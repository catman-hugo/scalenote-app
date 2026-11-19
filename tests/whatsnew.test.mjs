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

test("the 0.5.6 notes: full and short, each for its own system, and GitHub sees every full line", async () => {
  const text = await readFile(new URL("../docs/release-notes/0.5.6.md", import.meta.url), "utf8");
  const phone = notesFor(appNotes(text, "short"), "android");
  assert.doesNotMatch(phone, /Linux|Ctrl|forgotten PIN/);
  assert.match(phone, /Fingerprint/);
  const windowsShort = notesFor(appNotes(text, "short"), "windows");
  assert.match(windowsShort, /Ctrl \+ and Ctrl/);
  assert.doesNotMatch(windowsShort, /fingerprint|Linux|Android|phone|forgotten PIN|<!--/i);
  const windowsFull = notesFor(appNotes(text, "full"), "windows");
  assert.match(windowsFull, /forgotten PIN cannot be recovered/);
  assert.doesNotMatch(windowsFull, /fingerprint|Linux|Android|phone|<!--/i);
  assert.match(notesFor(appNotes(text, "full"), "linux"), /^- Two fingers on a drawing/m);
  assert.match(notesFor(appNotes(text, "short"), "linux"), /^- Touch drawing works/m);
  const visible = text.replace(/<!--[\s\S]*?-->/g, "");
  for (const words of [/forgotten PIN/, /Linux: Two fingers/, /Android: \*\*Fingerprint/, /Computers: \*\*Zoom/]) assert.match(visible, words);
});

test("the short list is the In the app part; the full notes are everything outside comments", () => {
  const file = "Full words here.\n\n<!-- In the app\n## New\n- Short.\n-->\n";
  assert.equal(appNotes(file, "short"), "## New\n- Short.\n");
  assert.equal(appNotes(file, "full"), "Full words here.\n\n\n");
  // Without a short list the full notes are shown, never a comment.
  assert.equal(appNotes("## New\n- Long line. <!-- a note -->\n", "short"), "## New\n- Long line. \n");
  assert.equal(appNotes("", "full"), "");
  assert.equal(appNotes(undefined, "short"), "");
  // A comment that is never closed does not hide or break anything.
  assert.equal(appNotes("- One.\n<!-- In the app\n- Two.", "short"), "- One.\n<!-- In the app\n- Two.");
});
