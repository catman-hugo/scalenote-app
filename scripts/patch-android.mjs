// Adjusts the Android project that `tauri android init` generates.
// Run with: node scripts/patch-android.mjs   (from the repository root, after the init step)
//
// Why this exists: the generated app draws edge to edge and says nothing about the on-screen
// keyboard, so Android slides the whole window up when the keyboard opens and the top bar
// disappears. We want the keyboard to sit on top of the bottom of the page: the window gets
// shorter, the top bar stays, and the page scrolls only as far as the text cursor needs.
//
// It also installs the launcher icons (see installIcons).
//
// The Android project is generated in the build and not stored in the repository, so the
// change is applied here as a small text patch. Each patch refuses to run if the generated
// file does not look as expected, so a changed template fails the build instead of being
// silently ignored.

import { cp, mkdir, readFile, writeFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MODE_ATTRIBUTE = 'android:windowSoftInputMode="adjustResize"';

// "adjustResize" asks Android to make the window shorter for the keyboard. On Android 11 and
// newer that request is ignored for edge to edge apps, which is why the activity also pads
// itself (see ACTIVITY_BODY). Older versions honour the request on their own.
// Each step below is skipped when its change is already there, so running the patch twice is safe.
export function patchManifest(text) {
  const anchor = 'android:name=".MainActivity"';
  if (!text.includes(anchor)) throw new Error("AndroidManifest.xml has no MainActivity entry");
  let out = text;
  if (!out.includes("android:windowSoftInputMode")) out = out.replace(anchor, `${anchor}\n            ${MODE_ATTRIBUTE}`);
  return addInstaller(out);
}

// Installing an update from inside the app needs the permission Android calls "install unknown
// apps" and a file provider, because the system installer may only read the downloaded file
// through a content address, never through a file path. The provider is our own (its own
// authority and its own folder list), so nothing the Tauri template shares is widened.
const INSTALL_PERMISSION = '<uses-permission android:name="android.permission.REQUEST_INSTALL_PACKAGES" />';
const PROVIDER = `<provider
            android:name="androidx.core.content.FileProvider"
            android:authorities="\${applicationId}.apkprovider"
            android:exported="false"
            android:grantUriPermissions="true">
            <meta-data android:name="android.support.FILE_PROVIDER_PATHS" android:resource="@xml/apk_paths" />
        </provider>`;

function addInstaller(text) {
  let out = text;
  if (!out.includes("REQUEST_INSTALL_PACKAGES")) {
    if (!out.includes("<application")) throw new Error("AndroidManifest.xml has no application entry");
    out = out.replace("<application", `${INSTALL_PERMISSION}\n    <application`);
  }
  if (!out.includes(".apkprovider")) {
    if (!out.includes("</application>")) throw new Error("AndroidManifest.xml has no closing application entry");
    out = out.replace("</application>", `    ${PROVIDER}\n    </application>`);
  }
  return out;
}

// Only the "updates" folder of the cache can be shared, and nothing else.
export const APK_PATHS_XML = `<?xml version="1.0" encoding="utf-8"?>
<paths>
    <cache-path name="updates" path="updates/" />
</paths>
`;

// The activity is replaced as a whole: it is tiny, and a whole file is easier to read and to
// check than a set of text insertions. Only the package line is taken from the generated file.
export function patchActivity(text) {
  const match = /^package\s+([^\s]+)\s*$/m.exec(text);
  if (!match) throw new Error("MainActivity.kt has no package line");
  if (!text.includes("TauriActivity")) throw new Error("MainActivity.kt is not a Tauri activity");
  return `package ${match[1]}

import android.os.Build
import android.os.Bundle
import android.view.View
import android.webkit.WebView
import androidx.activity.enableEdgeToEdge
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat

class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
    shortenForKeyboard()
  }

  // The page may start an update install through this object. See ApkInstaller.kt.
  override fun onWebViewCreate(webView: WebView) {
    super.onWebViewCreate(webView)
    webView.addJavascriptInterface(ApkInstaller(this, webView), "ScaleNoteInstaller")
  }

  // On Android 11 and newer an edge to edge window is not made shorter by the keyboard, so the
  // keyboard height is added as padding at the bottom of the content. The page then ends where
  // the keyboard starts. The insets are passed on unchanged, so nothing else is affected.
  private fun shortenForKeyboard() {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) return
    val content = findViewById<View>(android.R.id.content)
    ViewCompat.setOnApplyWindowInsetsListener(content) { view, insets ->
      val keyboard = insets.getInsets(WindowInsetsCompat.Type.ime()).bottom
      view.setPadding(view.paddingLeft, view.paddingTop, view.paddingRight, keyboard)
      insets
    }
  }
}
`;
}

// The native part of "install the update from inside the app". It is written as a separate file
// next to MainActivity.kt. Plain steps, each with a reason:
//  1. The address is checked again here, because the page could in theory be tampered with.
//  2. If Android has not yet been told this app may install apps, the settings screen for that
//     is opened and nothing is downloaded.
//  3. The file is downloaded to the cache with a size limit and timeouts, into a temporary
//     name that is renamed only when complete, and must start with "PK" (an .apk is a zip).
//  4. Android's installer is opened on it. The user still has to confirm there.
export function apkInstallerSource(pkg) {
  return `package ${pkg}

import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.Settings
import android.webkit.JavascriptInterface
import android.webkit.WebView
import androidx.core.content.FileProvider
import java.io.File
import java.net.HttpURLConnection
import java.net.URL

class ApkInstaller(private val context: Context, private val webView: WebView) {
  private val prefix = "https://github.com/catman-hugo/scalenote-app/releases/download/"
  private val maxBytes = 200L * 1024 * 1024
  @Volatile private var busy = false

  @JavascriptInterface
  fun install(address: String) {
    if (!isAllowed(address)) {
      report("error")
      return
    }
    // Before Android 8 there is no such switch: the installer itself asks.
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && !context.packageManager.canRequestPackageInstalls()) {
      openPermissionScreen()
      report("needs-permission")
      return
    }
    if (busy) return
    busy = true
    report("downloading")
    Thread {
      try {
        val file = download(address)
        report("installing")
        webView.post { openInstaller(file) }
      } catch (error: Exception) {
        android.util.Log.w("ScaleNote", "update install failed", error)
        report("error")
      } finally {
        busy = false
      }
    }.start()
  }

  private fun isAllowed(address: String): Boolean =
    address.length < 400 && address.startsWith(prefix) && address.endsWith(".apk") &&
      !address.contains("..") && address.none { it.isWhitespace() || it == '"' || it == '\\'' || it == '\\\\' || it == '?' || it == '#' }

  private fun openPermissionScreen() {
    val intent = Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:" + context.packageName))
    intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    try {
      context.startActivity(intent)
    } catch (error: ActivityNotFoundException) {
      android.util.Log.w("ScaleNote", "no settings screen for installing apps", error)
    }
  }

  // GitHub answers a release download with a redirect to its file store. HttpURLConnection
  // follows a redirect only when it stays on https, which is exactly what is wanted here.
  private fun download(address: String): File {
    val folder = File(context.cacheDir, "updates")
    folder.mkdirs()
    folder.listFiles()?.forEach { it.delete() }
    val temporary = File(folder, "update.part")
    val target = File(folder, "ScaleNote-update.apk")
    val connection = URL(address).openConnection() as HttpURLConnection
    connection.connectTimeout = 15000
    connection.readTimeout = 30000
    connection.instanceFollowRedirects = true
    try {
      if (connection.responseCode != 200) throw IllegalStateException("download answered " + connection.responseCode)
      if (connection.contentLengthLong > maxBytes) throw IllegalStateException("file too large")
      var total = 0L
      connection.inputStream.use { input ->
        temporary.outputStream().use { output ->
          val buffer = ByteArray(64 * 1024)
          while (true) {
            val read = input.read(buffer)
            if (read < 0) break
            total += read
            if (total > maxBytes) throw IllegalStateException("file too large")
            output.write(buffer, 0, read)
          }
        }
      }
    } finally {
      connection.disconnect()
    }
    val head = temporary.inputStream().use { stream -> ByteArray(2).also { stream.read(it) } }
    if (head[0] != 'P'.code.toByte() || head[1] != 'K'.code.toByte()) {
      temporary.delete()
      throw IllegalStateException("not an apk")
    }
    if (!temporary.renameTo(target)) throw IllegalStateException("could not rename the download")
    return target
  }

  private fun openInstaller(file: File) {
    try {
      val uri = FileProvider.getUriForFile(context, context.packageName + ".apkprovider", file)
      val intent = Intent(Intent.ACTION_VIEW)
      intent.setDataAndType(uri, "application/vnd.android.package-archive")
      intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
      context.startActivity(intent)
    } catch (error: Exception) {
      android.util.Log.w("ScaleNote", "could not open the installer", error)
      report("error")
    }
  }

  // The status word is one of four fixed words, never text from the network.
  private fun report(status: String) {
    webView.post {
      webView.evaluateJavascript("window.__scalenoteInstallStatus && window.__scalenoteInstallStatus('" + status + "')", null)
    }
  }
}
`;
}

// `tauri android init` writes Tauri's own launcher icons into the generated project and does not
// use the ones in src-tauri/icons/android, so the app showed the Tauri logo. The ScaleNote icons
// are copied over them. Files with the same name are replaced; the rest of the project is left alone.
export async function installIcons(from, to) {
  const entries = await readdir(from).catch(() => []);
  if (!entries.some((name) => name.startsWith("mipmap-"))) throw new Error(`no launcher icons found in ${from}`);
  await cp(from, to, { recursive: true, force: true });
  // Trust but check: the adaptive icon must now be ours, byte for byte.
  const ours = await readFile(path.join(from, "mipmap-anydpi-v26", "ic_launcher.xml"));
  const copied = await readFile(path.join(to, "mipmap-anydpi-v26", "ic_launcher.xml"));
  if (!ours.equals(copied)) throw new Error("the launcher icons were not copied");
  return entries;
}

async function findFile(dir, name) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const found = await findFile(full, name);
      if (found) return found;
    } else if (entry.name === name) {
      return full;
    }
  }
  return null;
}

async function main() {
  const root = path.join("src-tauri", "gen", "android", "app", "src", "main");
  const manifest = path.join(root, "AndroidManifest.xml");
  const activity = await findFile(root, "MainActivity.kt");
  if (!activity) throw new Error("MainActivity.kt was not found; run the Android init step first");
  await writeFile(manifest, patchManifest(await readFile(manifest, "utf8")));
  const activityText = await readFile(activity, "utf8");
  await writeFile(activity, patchActivity(activityText));
  const pkg = /^package\s+([^\s]+)\s*$/m.exec(activityText)[1];
  await writeFile(path.join(path.dirname(activity), "ApkInstaller.kt"), apkInstallerSource(pkg));
  await mkdir(path.join(root, "res", "xml"), { recursive: true });
  await writeFile(path.join(root, "res", "xml", "apk_paths.xml"), APK_PATHS_XML);
  console.log("patched", manifest);
  console.log("patched", activity);
  await installIcons(path.join("src-tauri", "icons", "android"), path.join(root, "res"));
  console.log("installed the ScaleNote launcher icons");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
