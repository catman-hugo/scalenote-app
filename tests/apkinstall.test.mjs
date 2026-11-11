// Calls the real functions of web/apkinstall.js.
import test from "node:test";
import assert from "node:assert/strict";
import { isInstallableUrl, installerOf, startInstall } from "../web/apkinstall.js";

const GOOD = "https://github.com/catman-hugo/scalenote-app/releases/download/v0.4.10/ScaleNote-0.4.10.apk";

test("only an apk of this project's releases is installable", () => {
  assert.equal(isInstallableUrl(GOOD), true);
  for (const bad of [
    "http://github.com/catman-hugo/scalenote-app/releases/download/v1/a.apk",
    "https://example.local/catman-hugo/scalenote-app/releases/download/v1/a.apk",
    GOOD.replace("v0.4.10/", "../"),
    GOOD + "?x=1",
    GOOD.replace(".apk", ".msi"),
    GOOD.replace("ScaleNote", "Scale Note"),
    "https://github.com/catman-hugo/scalenote-app/releases/download/v1/" + "a".repeat(500) + ".apk",
    null,
    42,
  ]) assert.equal(isInstallableUrl(bad), false, String(bad));
});

test("no bridge means no installer", () => {
  assert.equal(installerOf({}), null);
  assert.equal(installerOf({ ScaleNoteInstaller: {} }), null);
  assert.equal(startInstall({}, GOOD, () => {}), false);
});

test("the address is passed to the bridge and statuses come back, unknown words are dropped", () => {
  const seen = [];
  const win = { ScaleNoteInstaller: { install: (url) => seen.push(url) } };
  const statuses = [];
  assert.equal(startInstall(win, GOOD, (s) => statuses.push(s)), true);
  assert.deepEqual(seen, [GOOD]);
  win.__scalenoteInstallStatus("downloading");
  win.__scalenoteInstallStatus("<script>");
  win.__scalenoteInstallStatus("error");
  assert.deepEqual(statuses, ["downloading", "error"]);
});

test("a bad address never reaches the bridge, and a throwing bridge falls back", () => {
  const seen = [];
  const win = { ScaleNoteInstaller: { install: (url) => seen.push(url) } };
  assert.equal(startInstall(win, "https://example.local/a.apk", () => {}), false);
  assert.deepEqual(seen, []);
  assert.equal(startInstall({ ScaleNoteInstaller: { install() { throw new Error("x"); } } }, GOOD, () => {}), false);
});
