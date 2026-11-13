// Calls the real functions of web/apkinstall.js.
import test from "node:test";
import assert from "node:assert/strict";
import { isInstallableUrl, installerOf, startInstall, cleanProgress } from "../web/apkinstall.js";
import { installText } from "../web/installbar.js";

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

test("progress numbers from the native side are checked before they are used", () => {
  assert.deepEqual(cleanProgress(50, 200), { done: 50, total: 200, percent: 25 });
  assert.deepEqual(cleanProgress(200, 200), { done: 200, total: 200, percent: 100 });
  // The size is not known (the native side sends -1): there is no percent.
  assert.deepEqual(cleanProgress(5000, -1), { done: 5000, total: 0, percent: null });
  // More arrived than announced: the bar never goes past full.
  assert.deepEqual(cleanProgress(300, 200), { done: 300, total: 300, percent: 100 });
  for (const [done, total] of [[NaN, 10], [-1, 10], ["5", 10], [Infinity, 10], [null, null], [2 ** 41, 10]]) {
    assert.equal(cleanProgress(done, total), null, String([done, total]));
  }
  assert.equal(cleanProgress(5, "x").total, 0);
});

test("progress reaches the caller through the bridge callback, and nonsense is dropped", () => {
  const win = { ScaleNoteInstaller: { install: () => {} } };
  const seen = [];
  assert.equal(startInstall(win, GOOD, () => {}, (p) => seen.push(p)), true);
  win.__scalenoteInstallProgress(1048576, 4194304);
  win.__scalenoteInstallProgress("<script>", 10);
  win.__scalenoteInstallProgress(-5, 10);
  assert.deepEqual(seen, [{ done: 1048576, total: 4194304, percent: 25 }]);
});

test("the words under the bar say what is happening", () => {
  assert.match(installText({ kind: "downloading", done: 0, total: 0 }), /Starting/);
  assert.equal(installText({ kind: "downloading", done: 12 * 1048576, total: 131 * 1048576 }), "Downloading… 12 of 131 MB (9%)");
  assert.equal(installText({ kind: "downloading", done: 3.5 * 1048576, total: 0 }), "Downloading… 3.5 MB");
  assert.match(installText({ kind: "ready" }), /Android asks you to confirm/);
  assert.match(installText({ kind: "browser" }), /browser is downloading/);
  assert.equal(installText(null), "");
});
