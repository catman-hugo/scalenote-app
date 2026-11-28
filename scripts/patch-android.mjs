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
  return addShareTargets(addNetwork(addInstaller(out)));
}

// ScaleNote in Android's share menu (0.6.6): text and links, pictures, PDFs and markdown, one
// thing or several. The activity is "singleTask" in the Tauri template, so a share reaches the
// app that is already open (onNewIntent) instead of starting a second one; that is checked here.
// What arrives is handled by ShareBridge.kt.
export const SHARE_FILTERS = `<intent-filter>
                <action android:name="android.intent.action.SEND" />
                <category android:name="android.intent.category.DEFAULT" />
                <data android:mimeType="text/plain" />
                <data android:mimeType="text/markdown" />
                <data android:mimeType="image/*" />
                <data android:mimeType="application/pdf" />
            </intent-filter>
            <intent-filter>
                <action android:name="android.intent.action.SEND_MULTIPLE" />
                <category android:name="android.intent.category.DEFAULT" />
                <data android:mimeType="image/*" />
                <data android:mimeType="application/pdf" />
            </intent-filter>`;

function addShareTargets(text) {
  if (text.includes("android.intent.action.SEND")) return text;
  const start = text.indexOf('android:name=".MainActivity"');
  const end = text.indexOf("</activity>", start);
  if (start === -1 || end === -1) throw new Error("AndroidManifest.xml has no closing MainActivity entry");
  const activity = text.slice(text.lastIndexOf("<activity", start), end);
  if (!/android:launchMode="singleTask"/.test(activity)) throw new Error("MainActivity is not singleTask; a share would start a second app");
  return `${text.slice(0, end)}    ${SHARE_FILTERS}\n        ${text.slice(end)}`;
}

// Sync between devices needs three things Android keeps behind permissions. None of them lets
// the app read anything from the network: they let it ask what kind of network it is on, and
// let it receive the short "I am here" notes that other devices send to the whole network
// (Android drops those unless the app holds a "multicast lock", see NetworkBridge).
const NETWORK_PERMISSIONS = [
  "android.permission.ACCESS_NETWORK_STATE",
  "android.permission.ACCESS_WIFI_STATE",
  "android.permission.CHANGE_WIFI_MULTICAST_STATE",
];

function addNetwork(text) {
  let out = text;
  for (const name of NETWORK_PERMISSIONS) {
    if (out.includes(name)) continue;
    if (!out.includes("<application")) throw new Error("AndroidManifest.xml has no application entry");
    out = out.replace("<application", `<uses-permission android:name="${name}" />\n    <application`);
  }
  return out;
}

// Installing an update from inside the app needs the permission Android calls "install unknown
// apps" and a file provider, because the system installer may only read the downloaded file
// through a content address, never through a file path. The provider is our own (its own
// authority and its own folder list), so nothing the Tauri template shares is widened.
const INSTALL_PERMISSION = '<uses-permission android:name="android.permission.REQUEST_INSTALL_PACKAGES" />';
const PROVIDER = `<provider
            android:name=".ApkFileProvider"
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

// The Tauri template already declares a provider of the class androidx.core.content.FileProvider.
// Android refuses to install an app that declares the same component name twice ("There was a
// problem while parsing the package"), which 0.4.10 did. So ours is its own small subclass with
// its own name.
export function apkFileProviderSource(pkg) {
  return `package ${pkg}

import androidx.core.content.FileProvider

class ApkFileProvider : FileProvider()
`;
}

// ---------- the release build (after 0.7.0) ----------
//
// The APK used to be a debug build: about 164 MB, with Rust code that is not optimised. A release
// build is much smaller and faster, but Android only installs it when it is signed, and only over
// the installed app when it is signed with the same key. The generated build file signs release
// builds with nothing, so a signing setup is added that reads src-tauri/gen/android/keystore.properties
// (written in the build from a GitHub secret; Tauri's documented way, see "Android Code Signing").
// Without that file the release build stays unsigned, and the build step stops (see build.yml).
const GRADLE_IMPORT = "import java.io.FileInputStream";
const SIGNING = `    signingConfigs {
        val keystoreFile = rootProject.file("keystore.properties")
        if (keystoreFile.exists()) {
            val keystore = Properties()
            FileInputStream(keystoreFile).use { keystore.load(it) }
            create("release") {
                keyAlias = keystore["keyAlias"] as String
                keyPassword = keystore["password"] as String
                storeFile = file(keystore["storeFile"] as String)
                storePassword = keystore["password"] as String
            }
        }
    }
`;
const RELEASE_SIGNING = `            signingConfigs.findByName("release")?.let { signingConfig = it }`;

export function patchGradle(text) {
  if (text.includes("signingConfigs {")) return text;
  if (!text.includes("import java.util.Properties")) throw new Error("build.gradle.kts does not import Properties");
  if (!text.includes("    buildTypes {")) throw new Error("build.gradle.kts has no buildTypes block");
  const release = '        getByName("release") {';
  if (!text.includes(release)) throw new Error("build.gradle.kts has no release build type");
  return text
    .replace("import java.util.Properties", `import java.util.Properties\n${GRADLE_IMPORT}`)
    .replace("    buildTypes {", `${SIGNING}    buildTypes {`)
    .replace(release, `${release}\n${RELEASE_SIGNING}`);
}

// A release build shrinks the Kotlin code (R8) and may rename or remove what it thinks is unused.
// The page calls our Kotlin objects by name (addJavascriptInterface in MainActivity), which R8
// cannot see, so our own classes and every method the page may call are kept as they are. The
// generated build file reads every *.pro file in the app folder.
export function keepRules(pkg) {
  return `# Written by scripts/patch-android.mjs. See keepRules there for why.
-keep class ${pkg}.** { *; }
-keepclassmembers class * {
    @android.webkit.JavascriptInterface <methods>;
}
-keepattributes JavascriptInterface
`;
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

import android.content.Intent
import android.os.Build
import android.os.Bundle
import android.view.View
import android.webkit.WebView
import androidx.activity.enableEdgeToEdge
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat

class MainActivity : TauriActivity() {
  private val network by lazy { NetworkBridge(this) }
  private val share by lazy { ShareBridge(this) }

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
    shortenForKeyboard()
    // Something shared with ScaleNote, or the "New page" shortcut. Only on a fresh start: after
    // turning the phone the same request would otherwise be handled twice.
    if (savedInstanceState == null) share.receive(intent)
  }

  // The app was already open (singleTask): Android hands the new request here.
  override fun onNewIntent(intent: Intent) {
    super.onNewIntent(intent)
    setIntent(intent)
    share.receive(intent)
  }

  // The page may start an update install through this object. See ApkInstaller.kt.
  override fun onWebViewCreate(webView: WebView) {
    super.onWebViewCreate(webView)
    webView.addJavascriptInterface(ApkInstaller(this, webView), "ScaleNoteInstaller")
    webView.addJavascriptInterface(network, "ScaleNoteNetwork")
    webView.addJavascriptInterface(share, "ScaleNoteShare")
  }

  // Devices find each other while the app is on screen. The multicast lock is held only then,
  // because it keeps the Wi-Fi radio awake and costs battery.
  override fun onResume() {
    super.onResume()
    network.holdMulticast()
  }

  override fun onPause() {
    network.releaseMulticast()
    super.onPause()
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

// The native part of sync on Android. Two jobs:
//  1. Hold the multicast lock while the app is open. Without it Android's Wi-Fi chip throws away
//     multicast packets to save power, so this phone would never hear other devices announce.
//  2. Say whether the connection is Wi-Fi or wired, for "sync on Wi-Fi only". The page can ask;
//     it gets one yes or no, never any address or name of the network.
export function networkBridgeSource(pkg) {
  return `package ${pkg}

import android.content.Context
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.net.wifi.WifiManager
import android.webkit.JavascriptInterface

class NetworkBridge(context: Context) {
  private val app = context.applicationContext
  private var lock: WifiManager.MulticastLock? = null

  fun holdMulticast() {
    try {
      if (lock == null) {
        val wifi = app.getSystemService(Context.WIFI_SERVICE) as WifiManager
        lock = wifi.createMulticastLock("scalenote-sync").also { it.setReferenceCounted(false) }
      }
      lock?.acquire()
    } catch (error: Exception) {
      android.util.Log.w("ScaleNote", "could not hold the multicast lock", error)
    }
  }

  fun releaseMulticast() {
    try {
      if (lock?.isHeld == true) lock?.release()
    } catch (error: Exception) {
      android.util.Log.w("ScaleNote", "could not release the multicast lock", error)
    }
  }

  // True on Wi-Fi or a wired connection. If Android cannot say, the answer is true, so a guess
  // never blocks a sync.
  @JavascriptInterface
  fun isWifi(): Boolean {
    return try {
      val manager = app.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
      val capabilities = manager.getNetworkCapabilities(manager.activeNetwork) ?: return true
      capabilities.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) || capabilities.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET)
    } catch (error: Exception) {
      true
    }
  }
}
`;
}

// The native part of Android's share menu and the "New page" home-screen shortcut (0.6.6).
//  - Text (and a link, which arrives as text) is kept as it is, at most 1 MB, with the subject.
//  - Files (pictures, PDFs, markdown) are copied by the app into its own cache folder
//    "scalenote-shared", at most 20 at once and 64 MB each, under a random name; the page passes
//    their place on, and Rust only takes files from that folder (src-tauri/src/capture.rs),
//    checks what they really are, and removes the copy once added or dismissed. Copies older than
//    a day are removed at the next start.
//  - The page asks for what came with take(): a JSON list. Nothing from the share is ever put
//    into the page as code: it is all JSON text, read with JSON.parse.
//  - The "New page" shortcut (long-press the app icon) is added once the page gives its label,
//    so the word comes from the app's language file.
export function shareBridgeSource(pkg) {
  return `package ${pkg}

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.OpenableColumns
import android.webkit.JavascriptInterface
import androidx.core.content.pm.ShortcutInfoCompat
import androidx.core.content.pm.ShortcutManagerCompat
import androidx.core.graphics.drawable.IconCompat
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.util.UUID

class ShareBridge(private val activity: Activity) {
  private val pending = mutableListOf<JSONObject>()
  private val maxFileBytes = 64L * 1024 * 1024
  private val maxFiles = 20
  private val maxTextChars = 1_000_000
  private val folder: File by lazy { File(activity.cacheDir, "scalenote-shared").also { it.mkdirs() } }

  init {
    Thread { removeOldCopies() }.start()
  }

  fun receive(intent: Intent?) {
    if (intent == null) return
    try {
      when (intent.action) {
        NEW_PAGE -> add(JSONObject().put("kind", "newPage"))
        Intent.ACTION_SEND -> {
          val text = intent.getCharSequenceExtra(Intent.EXTRA_TEXT)?.toString()
          val subject = intent.getCharSequenceExtra(Intent.EXTRA_SUBJECT)?.toString()
          val stream = streamOf(intent)
          if (stream != null) copyLater(listOf(stream))
          else if (!text.isNullOrBlank() && text.length <= maxTextChars) {
            add(JSONObject().put("kind", "text").put("text", text).put("subject", subject?.take(500) ?: JSONObject.NULL))
          }
        }
        Intent.ACTION_SEND_MULTIPLE -> copyLater(streamsOf(intent).take(maxFiles))
      }
    } catch (error: Exception) {
      android.util.Log.w("ScaleNote", "a shared item could not be read", error)
    }
    // Handled once: the same request is not read again later.
    intent.action = null
  }

  @Suppress("DEPRECATION")
  private fun streamOf(intent: Intent): Uri? =
    if (Build.VERSION.SDK_INT >= 33) intent.getParcelableExtra(Intent.EXTRA_STREAM, Uri::class.java)
    else intent.getParcelableExtra(Intent.EXTRA_STREAM)

  @Suppress("DEPRECATION")
  private fun streamsOf(intent: Intent): List<Uri> =
    (if (Build.VERSION.SDK_INT >= 33) intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM, Uri::class.java)
    else intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM)) ?: emptyList()

  // Copying can take a moment for a big PDF, so it is not done on the screen's own thread.
  private fun copyLater(uris: List<Uri>) {
    Thread {
      for (uri in uris) {
        try {
          copy(uri)?.let { add(it) }
        } catch (error: Exception) {
          android.util.Log.w("ScaleNote", "a shared file could not be copied", error)
        }
      }
    }.start()
  }

  private fun copy(uri: Uri): JSONObject? {
    if (uri.scheme != "content" && uri.scheme != "file") return null
    val name = cleanName(displayName(uri))
    val target = File(folder, UUID.randomUUID().toString() + "-" + name)
    val temporary = File(folder, target.name + ".part")
    var total = 0L
    activity.contentResolver.openInputStream(uri)?.use { input ->
      temporary.outputStream().use { output ->
        val buffer = ByteArray(64 * 1024)
        while (true) {
          val read = input.read(buffer)
          if (read < 0) break
          total += read
          if (total > maxFileBytes) {
            temporary.delete()
            return null
          }
          output.write(buffer, 0, read)
        }
      }
    } ?: return null
    if (!temporary.renameTo(target)) {
      temporary.delete()
      return null
    }
    return JSONObject().put("kind", "file").put("path", target.absolutePath).put("name", name)
  }

  private fun displayName(uri: Uri): String {
    try {
      activity.contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { cursor ->
        if (cursor.moveToFirst()) return cursor.getString(0) ?: "file"
      }
    } catch (error: Exception) {
      android.util.Log.w("ScaleNote", "a shared file has no name", error)
    }
    return uri.lastPathSegment ?: "file"
  }

  // Letters, digits and a few signs only, at most 100 characters: the name is only a hint.
  private fun cleanName(name: String): String {
    val kept = name.substringAfterLast('/').filter { it.isLetterOrDigit() || it in "._- ()" }.trim().take(100)
    return if (kept.isEmpty() || kept.startsWith(".")) "file" else kept
  }

  private fun add(item: JSONObject) {
    synchronized(pending) {
      if (pending.size < 100) pending.add(item)
    }
  }

  private fun removeOldCopies() {
    val dayAgo = System.currentTimeMillis() - 24L * 60 * 60 * 1000
    folder.listFiles()?.filter { it.lastModified() < dayAgo }?.forEach { it.delete() }
  }

  // What has arrived since the page last asked, as JSON text.
  @JavascriptInterface
  fun take(): String = synchronized(pending) {
    val list = JSONArray()
    pending.forEach { list.put(it) }
    pending.clear()
    list.toString()
  }

  // Adds (or renames) the "New page" shortcut on the app icon. The label comes from the page.
  @JavascriptInterface
  fun offerShortcut(label: String) {
    val clean = label.filter { !it.isISOControl() }.trim().take(25)
    if (clean.isEmpty()) return
    activity.runOnUiThread {
      try {
        val intent = Intent(activity, activity.javaClass).setAction(NEW_PAGE)
        val shortcut = ShortcutInfoCompat.Builder(activity, "new-page")
          .setShortLabel(clean)
          .setIcon(IconCompat.createWithResource(activity, R.mipmap.ic_launcher))
          .setIntent(intent)
          .build()
        ShortcutManagerCompat.pushDynamicShortcut(activity, shortcut)
      } catch (error: Exception) {
        android.util.Log.w("ScaleNote", "the New page shortcut could not be added", error)
      }
    }
  }

  companion object {
    const val NEW_PAGE = "org.scalenote.NEW_PAGE"
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
      val length = connection.contentLengthLong
      var lastReport = 0L
      connection.inputStream.use { input ->
        temporary.outputStream().use { output ->
          val buffer = ByteArray(64 * 1024)
          while (true) {
            val read = input.read(buffer)
            if (read < 0) break
            total += read
            if (total > maxBytes) throw IllegalStateException("file too large")
            output.write(buffer, 0, read)
            // At most four reports a second, so the page is not flooded.
            val now = System.currentTimeMillis()
            if (now - lastReport >= 250) {
              lastReport = now
              reportProgress(total, length)
            }
          }
        }
      }
      reportProgress(total, length)
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

  // Two plain numbers (bytes so far, bytes in all or -1 when the server did not say). Both are
  // Long values made here, never text from the network, so nothing can be injected into the page.
  private fun reportProgress(done: Long, length: Long) {
    webView.post {
      webView.evaluateJavascript("window.__scalenoteInstallProgress && window.__scalenoteInstallProgress(" + done + "," + length + ")", null)
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
  await writeFile(path.join(path.dirname(activity), "ApkFileProvider.kt"), apkFileProviderSource(pkg));
  await writeFile(path.join(path.dirname(activity), "NetworkBridge.kt"), networkBridgeSource(pkg));
  await writeFile(path.join(path.dirname(activity), "ShareBridge.kt"), shareBridgeSource(pkg));
  const gradle = path.join("src-tauri", "gen", "android", "app", "build.gradle.kts");
  await writeFile(gradle, patchGradle(await readFile(gradle, "utf8")));
  await writeFile(path.join("src-tauri", "gen", "android", "app", "proguard-scalenote.pro"), keepRules(pkg));
  console.log("patched", gradle);
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
