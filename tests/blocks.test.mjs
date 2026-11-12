// Tests for the exact-text rules. They call the real functions from web/blocks.js and
// web/compose.js; only the editor's markdown parser is replaced by a small stand-in,
// because the real one needs a browser (it is tested in tests/editor.spec.mjs).

import test from "node:test";
import assert from "node:assert/strict";
import { hideNoteId, restoreNoteId, splitBlocks, splitFrontmatter, joinBlocks, withNoteId } from "../web/blocks.js";
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

// ---------- empty lines ----------
const para = (text) => ({ type: "paragraph", content: [{ type: "text", text }] });
const empty = () => ({ type: "paragraph" });
const isEmpty = (n) => n.type === "paragraph" && !(n.content && n.content.length);
// The page as a list: a block's text, or "" for an empty line.
const shape = (doc) => doc.content.map((n) => (isEmpty(n) ? "" : n.content ? n.content[0].text : n.attrs.src));
const save = (parts, doc) => composeNote(parts, doc, { ...io, assignId: false });

test("empty lines between blocks are saved as extra blank lines and come back", () => {
  const loaded = loadNote("a\n\nb\n", io);
  const doc = structuredClone(loaded.doc);
  doc.content.splice(1, 0, empty(), empty());
  const saved = save(loaded.parts, doc);
  assert.equal(saved, "a\n\n\n\nb\n");
  const again = loadNote(saved, io);
  assert.deepEqual(shape(again.doc), ["a", "", "", "b"]);
  assert.equal(save(again.parts, again.doc), saved, "opened and saved untouched");
  // Taking them out again goes back to one blank line.
  const without = structuredClone(again.doc);
  without.content.splice(1, 2);
  assert.equal(save(again.parts, without), "a\n\nb\n");
});

test("empty lines at the start and the end of a page are kept, with and without properties", () => {
  for (const front of ["", "---\ntitle: t\n---\n\n", "---\ntitle: t\n---\n"]) {
    const loaded = loadNote(front + "a\n", io);
    assert.deepEqual(shape(loaded.doc), ["a"], "one blank line under the properties is not an empty line");
    const doc = structuredClone(loaded.doc);
    doc.content.unshift(empty());
    doc.content.push(empty(), empty());
    const saved = save(loaded.parts, doc);
    const again = loadNote(saved, io);
    assert.deepEqual(shape(again.doc), ["", "a", "", ""], JSON.stringify(saved));
    assert.equal(save(again.parts, again.doc), saved);
  }
});

test("the line the editor keeps under a last block that is not a paragraph is not saved", () => {
  const loaded = loadNote("# Title\n", io);
  assert.deepEqual(shape(loaded.doc), ["# Title"]);
  const doc = structuredClone(loaded.doc);
  doc.content.push(empty()); // the editor's own line
  assert.equal(save(loaded.parts, doc), "# Title\n", "the file does not change");
  doc.content.push(empty()); // one the person added
  const saved = save(loaded.parts, doc);
  assert.equal(saved, "# Title\n\n");
  const again = loadNote(saved, io);
  assert.deepEqual(shape(again.doc), ["# Title", "", ""], "both lines are back");
  assert.equal(save(again.parts, again.doc), saved);
});

test("a heading directly above a list keeps its tight line break until an empty line is put between", () => {
  const loaded = loadNote("# h\n- x\n", io);
  assert.equal(save(loaded.parts, loaded.doc), "# h\n- x\n");
  const doc = structuredClone(loaded.doc);
  doc.content.splice(1, 0, empty());
  assert.equal(save(loaded.parts, doc), "# h\n\n\n- x\n");
});

test("blank lines with spaces in them and Windows line endings come back byte for byte", () => {
  for (const text of ["a\n  \n\t\n\nb\n\n \n", "a\r\n\r\n\r\n\r\nb\r\n\r\n", "\n\n\na\n\n\n\n\nb", "---\nx: 1\n---\n\n\n\na\n"]) {
    const loaded = loadNote(text, io);
    assert.equal(save(loaded.parts, loaded.doc), text);
  }
});

test("random pages with empty lines keep every empty line through save and open", () => {
  let seed = 4242;
  const rand = (n) => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) % n);
  // Blocks that never merge with a neighbour (two lists in a row would become one list).
  const words = ["alpha", "# head", "beta gamma", "## two", "```\ncode\n```"];
  for (let round = 0; round < 2000; round++) {
    const start = loadNote(rand(2) ? "---\ntitle: t\n---\n\nseed\n" : "seed\n", io);
    const doc = { type: "doc", content: [] };
    const blocks = 1 + rand(5);
    for (let i = 0; i < rand(3); i++) doc.content.push(empty());
    for (let b = 0; b < blocks; b++) {
      const node = fakeParse(words[rand(words.length)]).content[0];
      doc.content.push(node);
      for (let i = 0; i < rand(4); i++) doc.content.push(empty());
    }
    const saved = save(start.parts, doc);
    const again = loadNote(saved, io);
    const want = shape(doc);
    // The one line the editor keeps for itself after a last block that is not a paragraph.
    const lastBlock = doc.content.findLast((n) => !isEmpty(n));
    const trailing = want.length - 1 - want.findLastIndex((t) => t !== "");
    if (lastBlock.type !== "paragraph" && trailing === 1) want.pop();
    assert.deepEqual(shape(again.doc), want, JSON.stringify(saved));
    assert.equal(save(again.parts, again.doc), saved, "stable: " + JSON.stringify(saved));
  }
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

// ---------- the page id is never shown ----------

const PAGE_ID = "0b9c7e52-3f1a-4d6e-9a58-2c7d41e6b0aa";

test("a byte-order mark before the frontmatter does not stop it being recognised", () => {
  const text = `\uFEFF---\nid: ${PAGE_ID}\n---\n\nHello\n`;
  const { front, body } = splitFrontmatter(text);
  assert.equal(front + body, text);
  assert.equal(body, "\nHello\n");
});

test("hiding the id takes out only the id and putting it back gives the same bytes", () => {
  for (const text of [
    `---\nid: ${PAGE_ID}\n---\n\nHello\n`,
    `---\r\nid: ${PAGE_ID}\r\n---\r\n\r\nHello\r\n`,
    `\uFEFF---\nid: ${PAGE_ID}\n---\nHello\n`,
    `---\nid: ${PAGE_ID}\ntags: [a]\n---\n\nHello\n`,
    `---\ntitle: T\nid: ${PAGE_ID}\n---\n\nHello\n`,
    `---\nid: ${PAGE_ID}\n---\n`,
  ]) {
    const { text: shown, hidden } = hideNoteId(text);
    assert.ok(!shown.includes(PAGE_ID), "the id is not in the shown text");
    assert.equal(restoreNoteId(shown, hidden), text, "untouched text comes back byte for byte");
  }
  assert.equal(hideNoteId(`---\nid: ${PAGE_ID}\n---\n\nHello\n`).text, "Hello\n");
  assert.equal(hideNoteId(`---\nid: ${PAGE_ID}\ntags: [a]\n---\n\nHello\n`).text, "---\ntags: [a]\n---\n\nHello\n");
});

test("a note without an id is left alone, and an edit made while the id is hidden keeps the id", () => {
  assert.deepEqual(hideNoteId("# Plain\n"), { text: "# Plain\n", hidden: null });
  assert.equal(restoreNoteId("# Plain\n", null), "# Plain\n");
  const { hidden } = hideNoteId(`---\nid: ${PAGE_ID}\ntags: [a]\n---\n\nHello\n`);
  assert.equal(restoreNoteId("---\ntags: [a, b]\n---\n\nHello there\n", hidden), `---\nid: ${PAGE_ID}\ntags: [a, b]\n---\n\nHello there\n`);
  // Even if the properties block was deleted in the box, the id is not lost.
  assert.equal(restoreNoteId("Only text\n", hidden), `---\nid: ${PAGE_ID}\n---\n\nOnly text\n`);
});

test("the fallback view of a page shows only the body and still saves the same bytes", () => {
  // A stand-in parser that rejects everything makes every block raw; the safety net is
  // forced by a serializer that changes the text.
  const text = `---\nid: ${PAGE_ID}\n---\n\n# Plan\n\nBody\n`;
  const parse = () => ({ type: "doc", content: [{ type: "paragraph" }, { type: "paragraph" }] });
  const serialize = () => "changed";
  const { parts, doc } = loadNote(text, { parse, serialize });
  const shown = JSON.stringify(doc);
  assert.ok(!shown.includes(PAGE_ID), "the id is not in what the editor shows");
  assert.equal(composeNote(parts, doc, { serialize, assignId: false }), text);
});

test("a note with an id and an empty body opens as an empty page, not as a kept-as-written block", () => {
  const parse = () => ({ type: "doc", content: [] });
  const serialize = () => "";
  for (const text of [`---\nid: ${PAGE_ID}\n---\n\n`, `---\nid: ${PAGE_ID}\n---\n`, `---\nid: ${PAGE_ID}\n---\n\n\n  \n`, "\n", ""]) {
    const { parts, doc } = loadNote(text, { parse, serialize });
    assert.ok(!doc.content.some((node) => node.type === "rawBlock"), JSON.stringify(text) + " shows no raw block");
    assert.equal(composeNote(parts, doc, { serialize, assignId: false }), text, "and saves the same bytes");
  }
});

// ---- lists of different kinds one after another (0.4.10) ----

test("a bulleted, a numbered and a to-do list in a row are three lists, not one raw block", () => {
  const text = "- a\n- b\n\n1. one\n2. two\n\n- [ ] todo\n- [x] done\n";
  assert.deepEqual(kinds(text), ["list", "list", "list"]);
  const { lead, blocks } = splitBlocks(splitFrontmatter(text).body);
  assert.equal(joinBlocks({ lead, blocks }), text, "the text is still kept to the byte");
});

test("a different bullet character or numbering mark after a blank line starts a new list", () => {
  assert.deepEqual(kinds("- a\n\n* b\n"), ["list", "list"]);
  assert.deepEqual(kinds("1. a\n\n- b\n"), ["list", "list"]);
  assert.deepEqual(kinds("- a\n\n- [ ] b\n"), ["list", "list"]);
});

test("a loose list of one kind, and an indented item after a blank line, are still kept as written", () => {
  assert.deepEqual(kinds("- a\n\n- b\n"), ["raw"]);
  assert.deepEqual(kinds("1. a\n\n2. b\n"), ["raw"]);
  assert.deepEqual(kinds("- a\n\n  more of a\n- b\n"), ["raw"]);
});

test("a canvas block is exactly three lines; anything else with that label stays a code block", () => {
  assert.deepEqual(kinds("```scalenote-canvas\nid: abc123xy\n```"), ["canvasblock"]);
  assert.deepEqual(kinds("before\n\n```scalenote-canvas\nid: abc123xy\n```\n\nafter"), ["paragraph", "canvasblock", "paragraph"]);
  for (const odd of [
    "```scalenote-canvas\nid: abc123xy\nmore\n```",
    "```scalenote-canvas\nid: ABC\n```",
    "```scalenote-canvas\nid: abc123xy \n```",
    "```scalenote-canvas\r\nid: abc123xy\r\n```",
    "```scalenote-canvas\n```",
    "```canvas\nid: abc123xy\n```",
    "```scalenote-canvas\nid: abc123xy",
  ]) {
    assert.ok(!kinds(odd).includes("canvasblock"), JSON.stringify(odd));
  }
});
