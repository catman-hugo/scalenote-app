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

import { cp, readFile, writeFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MODE_ATTRIBUTE = 'android:windowSoftInputMode="adjustResize"';

// "adjustResize" asks Android to make the window shorter for the keyboard. On Android 11 and
// newer that request is ignored for edge to edge apps, which is why the activity also pads
// itself (see ACTIVITY_BODY). Older versions honour the request on their own.
export function patchManifest(text) {
  if (text.includes("android:windowSoftInputMode")) return text;
  const anchor = 'android:name=".MainActivity"';
  if (!text.includes(anchor)) throw new Error("AndroidManifest.xml has no MainActivity entry");
  return text.replace(anchor, `${anchor}\n            ${MODE_ATTRIBUTE}`);
}

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
import androidx.activity.enableEdgeToEdge
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat

class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
    shortenForKeyboard()
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
  await writeFile(activity, patchActivity(await readFile(activity, "utf8")));
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
