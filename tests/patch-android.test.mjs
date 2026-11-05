// Calls the real patch functions on text shaped like the files `tauri android init` writes
// (the Tauri 2.12.4 template, with the example identifier used everywhere in this repository).
import test from "node:test";
import assert from "node:assert/strict";
import { patchManifest, patchActivity } from "../scripts/patch-android.mjs";

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
  assert.equal(out.replace(/\n\s+android:windowSoftInputMode="adjustResize"/, ""), MANIFEST, "nothing else changes");
});

test("patching the manifest twice changes nothing more", () => {
  const once = patchManifest(MANIFEST);
  assert.equal(patchManifest(once), once);
});

test("a manifest with an existing keyboard setting is left alone", () => {
  const own = MANIFEST.replace('android:exported="true"', 'android:exported="true" android:windowSoftInputMode="adjustPan"');
  assert.equal(patchManifest(own), own);
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
});

test("the activity patch is stable when run on its own output", () => {
  const once = patchActivity(ACTIVITY);
  assert.equal(patchActivity(once), once);
});

test("a file that is not a Tauri activity is refused", () => {
  assert.throws(() => patchActivity("package a.b\nclass Other {}\n"), /Tauri/);
  assert.throws(() => patchActivity("class MainActivity : TauriActivity()"), /package/);
});
