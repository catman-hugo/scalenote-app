// Tests for the exact-text rules. They call the real functions from web/blocks.js and
// web/compose.js; only the editor's markdown parser is replaced by a small stand-in,
// because the real one needs a browser (it is tested in tests/editor.spec.mjs).

import test from "node:test";
import assert from "node:assert/strict";
import { splitBlocks, splitFrontmatter, joinBlocks, withNoteId } from "../web/blocks.js";
import { loadNote, composeNote } from "../web/compose.js";

const kinds = (text) => splitBlocks(splitFrontmatter(text).body).blocks.map((b) => b.kind);

// A stand-in for the editor: one node per block, rewriting "* " bullets as "- " like the
// real editor does, so "unchanged blocks keep their original text" can be seen.
function fakeParse(src) {
  const type = /^#{1,6} /.test(src) ? "heading" : /^[-*+] /.test(src) ? "bulletList" : /^```/.test(src) ? "codeBlock" : /^---$/.test(src) ? "horizontalRule" : /^>/.test(src) ? "blockquote" : "paragraph";
  return { type: "doc", content: [{ type, attrs: {}, content: [{ type: "text", text: src }] }] };
}
function fakeSerialize(doc) {
  return doc.content.map((n) => (n.content || []).map((c) => c.text).join("").replace(/^\* /gm, "- ").replace(/[ \t]+$/gm, "")).join("\n\n");
}
const io = { parse: fakeParse, serialize: fakeSerialize };

const SAMPLE = [
  "---\ntitle: Week 1\ntags: [a, b]\n---\n\n# Heading\nright below\n\nA paragraph\nover two lines.\n\n* one\n* two\n  - nested\n\n> quote\n\n",
  "```js\nlet a = 1;\n\nlet b = 2;\n```\n\n---\n\n- [ ] todo\n- [x] done\n",
].join("");

test("splitting and joining never loses or adds a character", () => {
  const { front, body } = splitFrontmatter(SAMPLE);
  assert.equal(front + joinBlocks(splitBlocks(body)), SAMPLE);
});

test("random documents always come back byte for byte", () => {
  const pool = ["# h", "text", "", "  ", "* a", "- b", "1. c", "> q", "```", "~~~", "---", "***", "| a | b |", "|---|---|", "<div>", "[[x]]", "$$", "\ttab", "    code", "- [ ] t", "\r", "a  ", "=", "%%c%%", "[^1]: n", "#tag", "![[img.png]]"];
  let seed = 12345;
  const rand = (n) => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) % n);
  for (let round = 0; round < 3000; round++) {
    const lines = Array.from({ length: rand(12) }, () => pool[rand(pool.length)]);
    const text = lines.join("\n") + (rand(2) ? "\n" : "");
    const { front, body } = splitFrontmatter(text);
    assert.equal(front + joinBlocks(splitBlocks(body)), text, JSON.stringify(text));
    // Opening and saving without edits must not change a byte either.
    const loaded = loadNote(text, io);
    assert.equal(composeNote(loaded.parts, loaded.doc, { ...io, assignId: false }), text, JSON.stringify(text));
  }
});

test("syntax the editor does not know is kept as raw blocks", () => {
  assert.deepEqual(kinds("| a | b |\n|---|---|\n| 1 | 2 |"), ["table"]); // a candidate: richblocks.js may still refuse it
  assert.deepEqual(kinds("See [[Other note]] for more"), ["paragraph"], "a well formed link is editable (wikilinks.js keeps it)");
  assert.deepEqual(kinds("See [[Other#Goals|the goals]], [[A]] and [[B]]"), ["paragraph"]);
  assert.deepEqual(kinds("# Title with [[Link]]"), ["heading"]);
  assert.deepEqual(kinds("- item with [[Link]]"), ["list"]);
  for (const odd of ["See ![[Other]] here", "See [[open", "close]] only", "[[]] empty", "A `[[code]]` span", "<[[a]]>", "[[a]]#tag next", "[[a\nb]]", "x [[a]] ==bad == y", "\\[[a]]"]) {
    assert.deepEqual(kinds(odd), ["raw"], odd);
  }
  assert.deepEqual(kinds("<div>html</div>"), ["raw"]);
  assert.deepEqual(kinds("> [!note] Title\n> body"), ["callout"]);
  assert.deepEqual(kinds("$$\nx^2\n$$"), ["raw"]);
  assert.deepEqual(kinds("Text with == highlight == inside"), ["paragraph"], "spaced == is just text");
  assert.deepEqual(kinds("Text with ==highlight ==  inside"), ["raw"], "a malformed highlight is kept raw");
  assert.deepEqual(kinds("![[image.png]]"), ["raw"]);
  assert.deepEqual(kinds("Title\n====="), ["raw"]);
  assert.deepEqual(kinds("    indented code"), ["raw"]);
  assert.deepEqual(kinds("A line with a #tag in it"), ["paragraph"], "a well formed tag is editable (compose.js checks that it is kept)");
  assert.deepEqual(kinds("# Heading with #tag"), ["heading"]);
  assert.deepEqual(kinds("#tag at the start\n#second"), ["paragraph"]);
  for (const odd of ["Issue #1984 is open", "#tag<b>", "x #é <u>ok</u> ==bad == y", "Text #tag and $math$"]) {
    assert.deepEqual(kinds(odd), ["raw"], odd);
  }
  assert.deepEqual(kinds("A line with a #1984 in it"), ["raw"], "a number is not a tag, and the editor is not asked to keep it");
  assert.deepEqual(kinds("```\nnever closed"), ["raw"]);
});

test("ordinary markdown is editable and a lone price is not mistaken for math", () => {
  assert.deepEqual(kinds("# H\n\ntext with **bold** and `code`\n\n- a\n- b\n\n> q\n\n---\n\n```\nx\n```"), ["heading", "paragraph", "list", "quote", "rule", "code"]);
  assert.deepEqual(kinds("It costs $5 today"), ["paragraph"]);
});

test("a note that is only opened and saved is identical", () => {
  const loaded = loadNote(SAMPLE, io);
  assert.equal(composeNote(loaded.parts, loaded.doc, { ...io, assignId: false }), SAMPLE);
});

test("editing one block changes only that block", () => {
  const loaded = loadNote(SAMPLE, io);
  const doc = structuredClone(loaded.doc);
  const paragraph = doc.content.find((n) => n.attrs.src && n.attrs.src.startsWith("A paragraph"));
  paragraph.content = [{ type: "text", text: "Changed text" }];
  const saved = composeNote(loaded.parts, doc, { ...io, assignId: false });
  assert.equal(saved, SAMPLE.replace("A paragraph\nover two lines.", "Changed text"));
  // The "* one" list was not touched, so it keeps the "*" markers the author used.
  assert.ok(saved.includes("* one\n* two"));
});

test("a new block gets a blank line before it and the file ends with a newline", () => {
  const loaded = loadNote("Only line", io);
  const doc = structuredClone(loaded.doc);
  doc.content.push({ type: "paragraph", content: [{ type: "text", text: "Second" }] });
  assert.equal(composeNote(loaded.parts, doc, { ...io, assignId: false }), "Only line\n\nSecond\n");
});

test("empty paragraphs are not written", () => {
  const loaded = loadNote("a\n", io);
  const doc = structuredClone(loaded.doc);
  doc.content.push({ type: "paragraph" });
  assert.equal(composeNote(loaded.parts, doc, { ...io, assignId: false }), "a\n");
});

test("the note id is added once and existing frontmatter is kept", () => {
  assert.equal(withNoteId("", "X"), "---\nid: X\n---\n\n");
  assert.equal(withNoteId("---\ntitle: T\n---\n", "X"), "---\ntitle: T\nid: X\n---\n");
  assert.equal(withNoteId("---\nid: keep\n---\n", "X"), "---\nid: keep\n---\n");
  assert.equal(withNoteId("---\r\ntitle: T\r\n---\r\n", "X"), "---\r\ntitle: T\r\nid: X\r\n---\r\n");
  const loaded = loadNote("hello\n", io);
  const saved = composeNote(loaded.parts, loaded.doc, { ...io, makeId: () => "abc" });
  assert.equal(saved, "---\nid: abc\n---\n\nhello\n");
});

test("huge and odd input does not break the splitter", () => {
  const huge = "line with text\n".repeat(200000);
  assert.equal(joinBlocks(splitBlocks(huge)), huge);
  for (const odd of ["", "\n", "\n\n\n", "\u0000", "\r\n\r\n", "---", "---\n", "---\n---", "\u{1F600}\n‮"]) {
    const { front, body } = splitFrontmatter(odd);
    assert.equal(front + joinBlocks(splitBlocks(body)), odd);
  }
});

test("well-formed text styles are editable; any other html or marker keeps the block raw", () => {
  for (const text of [
    "Text with ==highlight== inside",
    "x <u>underlined</u> y",
    "H<sub>2</sub>O and x<sup>2</sup>",
    '<span style="color: #f72525">red</span> at the start of a line',
    "<u>underline at the start</u> of a line",
    "- item with ==mark==",
    "> quote with <u>u</u>",
    "# Heading with ==mark==",
    "x == y and a = b",
  ]) {
    assert.notEqual(kinds(text)[0], "raw", text);
  }
  for (const text of [
    "x <b>bold</b> y",
    "x <span class=\"a\">y</span> z",
    "x <u>ok</u> and <mark>no</mark>",
    "<div>block</div>",
    "a <kbd>k</kbd> <u>u</u>",
  ]) {
    assert.equal(kinds(text)[0], "raw", text);
  }
});
