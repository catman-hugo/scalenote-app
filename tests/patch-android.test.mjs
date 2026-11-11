// Calls the real patch functions on text shaped like the files `tauri android init` writes
// (the Tauri 2.12.4 template, with the example identifier used everywhere in this repository).
import test from "node:test";
import assert from "node:assert/strict";
import { patchManifest, patchActivity, apkInstallerSource, APK_PATHS_XML } from "../scripts/patch-android.mjs";

const MANIFEST = `<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android">
    <application android:icon="@mipmap/ic_launcher">
        <activity
            android:configChanges="orientation|keyboardHidden|keyboard|screenSize|locale|smallestScreenSize|screenLayout|uiMode"
            android:launchMode="singleTask"
            android:label="@string/main_activity_title"
            android:name=".MainActivity"
            android:exported="true">
        </activity>
    </application>
</manifest>
`;

const ACTIVITY = `package local.example.scalenote

import android.os.Bundle
import androidx.activity.enableEdgeToEdge

class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
  }
}
`;

test("the manifest asks Android to shorten the window for the keyboard", () => {
  const out = patchManifest(MANIFEST);
  assert.match(out, /android:windowSoftInputMode="adjustResize"/);
  assert.match(out, /android:name="\.MainActivity"\s+android:windowSoftInputMode/);
  assert.match(out, /<activity[\s\S]*<\/activity>\s*<provider/, "the provider sits inside the application, after the activity");
});

test("the manifest gets the install permission and a provider of its own, once", () => {
  const out = patchManifest(MANIFEST);
  assert.equal(out.split("REQUEST_INSTALL_PACKAGES").length, 2);
  assert.match(out, /android:authorities="\$\{applicationId\}\.apkprovider"/);
  assert.match(out, /android:exported="false"/);
  assert.match(out, /@xml\/apk_paths/);
});

test("the shared folder is only the updates folder of the cache", () => {
  assert.match(APK_PATHS_XML, /<cache-path name="updates" path="updates\/" \/>/);
  assert.equal((APK_PATHS_XML.match(/-path /g) || []).length, 1);
});

test("the installer source checks the address, size and file type before installing", () => {
  const out = apkInstallerSource("local.example.scalenote");
  assert.match(out, /^package local\.example\.scalenote$/m);
  assert.match(out, /releases\/download\//);
  assert.match(out, /maxBytes/);
  assert.match(out, /canRequestPackageInstalls/);
  assert.match(out, /'P'\.code/);
  assert.match(out, /ACTION_MANAGE_UNKNOWN_APP_SOURCES/);
  assert.match(out, /apkprovider/);
});

test("a manifest missing the application entry is refused", () => {
  assert.throws(() => patchManifest('<manifest><x android:name=".MainActivity"/></manifest>'), /application/);
});

test("patching the manifest twice changes nothing more", () => {
  const once = patchManifest(MANIFEST);
  assert.equal(patchManifest(once), once);
});

test("a manifest with an existing keyboard setting is left alone", () => {
  const own = MANIFEST.replace('android:exported="true"', 'android:exported="true" android:windowSoftInputMode="adjustPan"');
  const out = patchManifest(own);
  assert.doesNotMatch(out, /adjustResize/);
  assert.match(out, /adjustPan/);
});

test("a manifest without the main activity is refused", () => {
  assert.throws(() => patchManifest("<manifest></manifest>"), /MainActivity/);
});

test("the activity keeps its package and pads the content for the keyboard", () => {
  const out = patchActivity(ACTIVITY);
  assert.match(out, /^package local\.example\.scalenote$/m);
  assert.match(out, /class MainActivity : TauriActivity\(\)/);
  assert.match(out, /enableEdgeToEdge\(\)\n    super\.onCreate\(savedInstanceState\)\n    shortenForKeyboard\(\)/);
  assert.match(out, /Type\.ime\(\)\)\.bottom/);
  assert.match(out, /Build\.VERSION_CODES\.R/);
  assert.match(out, /addJavascriptInterface\(ApkInstaller\(this, webView\), "ScaleNoteInstaller"\)/);
});

test("the activity patch is stable when run on its own output", () => {
  const once = patchActivity(ACTIVITY);
  assert.equal(patchActivity(once), once);
});

test("a file that is not a Tauri activity is refused", () => {
  assert.throws(() => patchActivity("package a.b\nclass Other {}\n"), /Tauri/);
  assert.throws(() => patchActivity("class MainActivity : TauriActivity()"), /package/);
});

// ---- launcher icons ----
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { installIcons } from "../scripts/patch-android.mjs";

const REPO_ICONS = path.join(import.meta.dirname, "..", "src-tauri", "icons", "android");

test("the icons in the repository are a complete adaptive icon set", () => {
  const xml = fs.readFileSync(path.join(REPO_ICONS, "mipmap-anydpi-v26", "ic_launcher.xml"), "utf8");
  assert.match(xml, /@mipmap\/ic_launcher_foreground/);
  assert.match(xml, /@color\/ic_launcher_background/);
  assert.match(fs.readFileSync(path.join(REPO_ICONS, "values", "ic_launcher_background.xml"), "utf8"), /name="ic_launcher_background"/);
  for (const density of ["mdpi", "hdpi", "xhdpi", "xxhdpi", "xxxhdpi"]) {
    for (const name of ["ic_launcher.png", "ic_launcher_round.png", "ic_launcher_foreground.png"]) {
      const file = path.join(REPO_ICONS, `mipmap-${density}`, name);
      assert.ok(fs.statSync(file).size > 200, `${density}/${name} exists and is not empty`);
      assert.deepEqual([...fs.readFileSync(file).subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47], `${density}/${name} is a png`);
    }
  }
});

test("the ScaleNote icons replace the generated ones and nothing else is touched", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "icons-"));
  const res = path.join(dir, "res");
  fs.mkdirSync(path.join(res, "mipmap-hdpi"), { recursive: true });
  fs.mkdirSync(path.join(res, "mipmap-anydpi-v26"), { recursive: true });
  fs.writeFileSync(path.join(res, "mipmap-hdpi", "ic_launcher.png"), "tauri default");
  fs.writeFileSync(path.join(res, "mipmap-anydpi-v26", "ic_launcher.xml"), "<adaptive-icon>tauri</adaptive-icon>");
  fs.writeFileSync(path.join(res, "unrelated.txt"), "keep me");
  await installIcons(REPO_ICONS, res);
  assert.deepEqual(fs.readFileSync(path.join(res, "mipmap-hdpi", "ic_launcher.png")), fs.readFileSync(path.join(REPO_ICONS, "mipmap-hdpi", "ic_launcher.png")));
  assert.match(fs.readFileSync(path.join(res, "mipmap-anydpi-v26", "ic_launcher.xml"), "utf8"), /ic_launcher_foreground/);
  assert.equal(fs.readFileSync(path.join(res, "unrelated.txt"), "utf8"), "keep me");
  assert.ok(fs.existsSync(path.join(res, "values", "ic_launcher_background.xml")));
});

test("missing icons stop the build instead of shipping the default logo", async () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), "noicons-"));
  await assert.rejects(installIcons(empty, path.join(empty, "res")), /no launcher icons/);
  await assert.rejects(installIcons(path.join(empty, "nope"), path.join(empty, "res")), /no launcher icons/);
});
