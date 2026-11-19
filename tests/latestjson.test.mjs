// latest.json tells the app where each kind of installer of a release is, with its signature.
import test from "node:test";
import assert from "node:assert/strict";
import { kindOf, latestJson } from "../scripts/latest-json.mjs";

const URL9 = "https://github.com/catman-hugo/scalenote-app/releases/download/v9.9.9";
const assets = [
  { name: "ScaleNote_9.9.9_x64-setup.exe", size: 100, browser_download_url: `${URL9}/ScaleNote_9.9.9_x64-setup.exe` },
  { name: "ScaleNote_9.9.9_x64_en-US.msi", size: 200, browser_download_url: `${URL9}/ScaleNote_9.9.9_x64_en-US.msi` },
  { name: "ScaleNote_9.9.9_amd64.deb", size: 300, browser_download_url: `${URL9}/ScaleNote_9.9.9_amd64.deb` },
  { name: "ScaleNote-9.9.9-1.x86_64.rpm", size: 400, browser_download_url: `${URL9}/ScaleNote-9.9.9-1.x86_64.rpm` },
  { name: "ScaleNote_9.9.9_amd64.AppImage", size: 500, browser_download_url: `${URL9}/ScaleNote_9.9.9_amd64.AppImage` },
  { name: "ScaleNote_9.9.9_arm64-debug.apk", size: 600, browser_download_url: `${URL9}/ScaleNote_9.9.9_arm64-debug.apk` },
];

test("each installer gets the key of its own kind; the apk and the portable zip get none", () => {
  assert.equal(kindOf("ScaleNote_1_x64-setup.exe"), "windows-x86_64-nsis");
  assert.equal(kindOf("ScaleNote_1_x64_en-US.msi"), "windows-x86_64-msi");
  assert.equal(kindOf("ScaleNote_1_amd64.AppImage"), "linux-x86_64-appimage");
  assert.equal(kindOf("ScaleNote_1_arm64-debug.apk"), null);
  assert.equal(kindOf("ScaleNote_1_x64-portable.zip"), null);
});

test("latest.json lists every signed installer with its uploaded address, matched by size", () => {
  const built = [
    { name: "ScaleNote 9.9.9_x64-setup.exe", size: 100, signature: "sig-nsis\n" },
    { name: "ScaleNote_9.9.9_x64_en-US.msi", size: 200, signature: "sig-msi" },
    { name: "ScaleNote_9.9.9_amd64.deb", size: 300, signature: "sig-deb" },
    { name: "ScaleNote-9.9.9-1.x86_64.rpm", size: 400, signature: "sig-rpm" },
    { name: "ScaleNote_9.9.9_amd64.AppImage", size: 500, signature: "sig-app" },
  ];
  const json = latestJson("v9.9.9", built, assets, new Date("2026-11-19T10:00:00.123Z"));
  assert.equal(json.version, "9.9.9");
  assert.equal(json.pub_date, "2026-11-19T10:00:00Z");
  assert.deepEqual(Object.keys(json.platforms).sort(), ["linux-x86_64-appimage", "linux-x86_64-deb", "linux-x86_64-rpm", "windows-x86_64-msi", "windows-x86_64-nsis"]);
  // A name GitHub changed (the space) is still found, by its ending and size.
  assert.deepEqual(json.platforms["windows-x86_64-nsis"], { signature: "sig-nsis", url: `${URL9}/ScaleNote_9.9.9_x64-setup.exe` });
  assert.equal(json.platforms["linux-x86_64-rpm"].url, `${URL9}/ScaleNote-9.9.9-1.x86_64.rpm`);
});

test("a signed file with no matching upload, or nothing signed at all, stops the release step", () => {
  assert.throws(() => latestJson("v9.9.9", [{ name: "ScaleNote_9.9.9_amd64.deb", size: 999, signature: "s" }], assets), /no single uploaded file/);
  assert.throws(() => latestJson("v9.9.9", [], assets), /no signed installers/);
});
