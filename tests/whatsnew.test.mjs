// The release notes shown in the app keep only the lines for the system the app runs on.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { appNotes, notesFor } from "../web/whatsnew.js";

const notes = [
  "## New",
  "- Computers: Zoom with Ctrl +.",
  "- Android: About page.",
  "- For everyone.",
  "",
  "## Fixed",
  "- Linux: Touch drawing works.",
  "  more words for the Linux line",
  "- Linux and Windows: Tray fixed.",
  "",
].join("\n");

test("Android sees its own and shared lines, without the system word", () => {
  assert.equal(notesFor(notes, "android"), "## New\n- About page.\n- For everyone.\n");
});

test("Linux sees computer lines and its own fixes, with their continuation lines", () => {
  assert.equal(
    notesFor(notes, "linux"),
    "## New\n- Zoom with Ctrl +.\n- For everyone.\n\n## Fixed\n- Touch drawing works.\n  more words for the Linux line\n- Tray fixed.\n",
  );
});

test("Windows loses the Linux line and its continuation, and a heading left empty goes", () => {
  assert.equal(notesFor(notes, "windows"), "## New\n- Zoom with Ctrl +.\n- For everyone.\n\n## Fixed\n- Tray fixed.\n");
  assert.equal(notesFor("## Fixed\n- Linux: Only this.\n", "android"), "");
});

test("a system word inside a sentence is not a marker, and empty or odd input is safe", () => {
  assert.equal(notesFor("- Works on Android: yes\n", "windows"), "- Works on Android: yes\n");
  assert.equal(notesFor("", "linux"), "");
  assert.equal(notesFor(null, "linux"), "");
  assert.equal(notesFor("- Linux: x".repeat(2000), "android").length >= 0, true);
});

test("the 0.5.6 notes: Android is not told about Linux or Ctrl zoom, Windows not about fingerprints", async () => {
  const text = await readFile(new URL("../docs/release-notes/0.5.6.md", import.meta.url), "utf8");
  const android = notesFor(appNotes(text), "android");
  assert.doesNotMatch(android, /Linux|Ctrl/);
  assert.match(android, /fingerprint/);
  const windows = notesFor(appNotes(text), "windows");
  assert.doesNotMatch(windows, /fingerprint|Linux|Android|phone/i);
  assert.match(windows, /Ctrl/);
  assert.match(notesFor(appNotes(text), "linux"), /Touch drawing works/);
  // GitHub keeps the full detail: the visible part has whole sentences about the lock and Linux.
  const visible = text.replace(/<!--[\s\S]*?-->/g, "");
  assert.match(visible, /forgotten PIN cannot be recovered/);
  assert.match(visible, /On Linux, two fingers/);
  assert.doesNotMatch(appNotes(text), /forgotten PIN/);
});

test("the app shows only the In the app part, or the notes without comments when there is none", () => {
  const file = "Full words here.\n\n<!-- In the app\n## New\n- Short.\n-->\n";
  assert.equal(appNotes(file), "## New\n- Short.\n");
  assert.equal(appNotes("## New\n- Long line. <!-- a note -->\n"), "## New\n- Long line. \n");
  assert.equal(appNotes(""), "");
  assert.equal(appNotes(undefined), "");
  // A comment that is never closed does not hide or break anything.
  assert.equal(appNotes("- One.\n<!-- In the app\n- Two."), "- One.\n<!-- In the app\n- Two.");
});
