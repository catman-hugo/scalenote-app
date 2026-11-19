// The release notes shown in the app keep only the lines for the system the app runs on.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { notesFor } from "../web/whatsnew.js";

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
  const android = notesFor(text, "android");
  assert.doesNotMatch(android, /Linux|Ctrl/);
  assert.match(android, /fingerprint/);
  const windows = notesFor(text, "windows");
  assert.doesNotMatch(windows, /fingerprint|Linux|Android|phone/i);
  assert.match(windows, /Ctrl/);
  assert.match(notesFor(text, "linux"), /Touch drawing works/);
});
