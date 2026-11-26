// Checks the installer additions of 0.6.6 ("Send to", "Open with") as text: both Windows
// installers offer the same file types, neither makes ScaleNote the default program for any of
// them, the uninstall removes everything added, and the Linux entry passes the chosen files on.
// The installers themselves are built and installed only on Windows and Linux (CI and the owner).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";

const root = new URL("../src-tauri/", import.meta.url);
const read = (name) => readFileSync(new URL(name, root), "utf8");
const conf = JSON.parse(read("tauri.conf.json"));
const nsh = read("windows/hooks.nsh");
const wxs = read("windows/capture.wxs");
const desktop = read("linux/scalenote.desktop");
const TYPES = ["png", "jpg", "jpeg", "gif", "webp", "pdf", "md", "markdown"];

test("the config points at the installer additions, and they exist", () => {
  const w = conf.bundle.windows;
  for (const file of [w.nsis.installerHooks, ...w.wix.fragmentPaths, conf.bundle.linux.deb.desktopTemplate, conf.bundle.linux.rpm.desktopTemplate]) {
    assert.ok(existsSync(new URL(file, root)), file);
  }
  for (const ref of w.wix.componentRefs) assert.match(wxs, new RegExp(`<Component Id="${ref}"`), ref);
  assert.equal(conf.bundle.fileAssociations, undefined, "Tauri's own file associations would make ScaleNote the default program");
});

test("both Windows installers add ScaleNote to Open with for the same types, never as the default", () => {
  for (const ext of TYPES) {
    assert.ok(nsh.includes(`SCALENOTE_OPEN_WITH "${ext}"`), `nsis ${ext}`);
    assert.ok(nsh.includes(`SCALENOTE_NOT_OPEN_WITH "${ext}"`), `nsis uninstall ${ext}`);
    assert.ok(wxs.includes(`Classes\\.${ext}\\OpenWithProgids" Name="ScaleNote.Open"`), `wix ${ext}`);
  }
  assert.equal((nsh.match(/SCALENOTE_OPEN_WITH "/g) || []).length, TYPES.length);
  assert.equal((wxs.match(/OpenWithProgids" Name=/g) || []).length, TYPES.length);
  // Writing the unnamed value of `.png` (or any type) would change its default program.
  assert.doesNotMatch(nsh, /Classes\\\.[a-z]+" ""/);
  assert.doesNotMatch(wxs, /Key="Software\\Classes\\\.[a-z]+">/);
  assert.match(nsh, /shell\\open\\command" "" "\$\\"\$INSTDIR\\\$\{MAINBINARYNAME\}\.exe\$\\" \$\\"%1\$\\""/);
});

test("Send to is added and removed again", () => {
  assert.match(nsh, /CreateShortCut "\$SENDTO\\ScaleNote\.lnk"/);
  assert.match(nsh, /Delete "\$SENDTO\\ScaleNote\.lnk"/);
  assert.match(nsh, /DeleteRegKey SHCTX "Software\\Classes\\ScaleNote\.Open"/);
  assert.match(wxs, /<Directory Id="SendToFolder" \/>/);
  assert.match(wxs, /<Shortcut Id="ScaleNoteSendToShortcut" Name="ScaleNote" Target="\[!Path\]"/);
});

test("the WiX fragment is well-formed XML", () => {
  const body = wxs.replace(/<\?xml[^>]*\?>/, "").replace(/<!--[\s\S]*?-->/g, "");
  const stack = [];
  for (const [, close, name, selfClosing] of body.matchAll(/<(\/?)([A-Za-z]+)[^>]*?(\/?)>/g)) {
    if (close) assert.equal(stack.pop(), name, `closing ${name}`);
    else if (!selfClosing) stack.push(name);
  }
  assert.deepEqual(stack, []);
});

test("the Linux entry passes the chosen files and lists the kinds ScaleNote takes", () => {
  assert.match(desktop, /^Exec=\{\{exec\}\} %F$/m);
  for (const type of ["image/png", "image/jpeg", "application/pdf", "text/markdown"]) assert.ok(desktop.includes(type), type);
  assert.doesNotMatch(desktop, /text\/plain/, "not offered for every text file");
});
