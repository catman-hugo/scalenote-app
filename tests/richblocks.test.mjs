// Tests for callouts, toggles, tables and images. They call the real functions from
// web/blocks.js, web/richblocks.js and web/compose.js. Only the editor's markdown parser is
// replaced by a small stand-in (the real one needs a browser; see tests/editor.spec.mjs).

import test from "node:test";
import assert from "node:assert/strict";
import { splitBlocks, splitFrontmatter } from "../web/blocks.js";
import { loadNote, composeNote } from "../web/compose.js";
import { readCallout, writeCallout, readDetails, writeDetails, readTable, writeTable, readImage, writeImage, writeBlock, readRichBlock, MAX_COLUMNS } from "../web/richblocks.js";

const TYPE = { paragraph: "paragraph", heading: "heading", list: "bulletList", quote: "blockquote", code: "codeBlock", rule: "horizontalRule" };
const text = (t) => ({ type: "text", text: t });
// One node per markdown block, holding the block's own text.
function parse(md) {
  const { blocks } = splitBlocks(md);
  return { type: "doc", content: blocks.map((b) => ({ type: TYPE[b.kind] || "paragraph", content: [text(b.src)] })) };
}
function serialize(doc) {
  const flat = (n) => (n.content || []).map((c) => (c.type === "text" ? c.text : flat(c))).join("");
  return doc.content.map(flat).join("\n\n");
}
const io = { parse, serialize };

test("a callout is read with its kind, fold, title and body, and written back the same", () => {
  const src = "> [!tip]- Remember this\n> first line\n>\n> second paragraph";
  const node = readCallout(src, io);
  assert.equal(node.type, "callout");
  assert.deepEqual(node.attrs, { kind: "tip", fold: "-", title: "Remember this" });
  assert.equal(node.content.length, 2);
  assert.equal(writeCallout(node, serialize), src);
});

test("a callout without a title or body is still a callout", () => {
  const node = readCallout("> [!note]", io);
  assert.equal(writeCallout(node, serialize), "> [!note]");
});

test("a callout holding something the editor cannot keep stays raw", () => {
  assert.equal(readCallout("> [!note] T\n> see ![[Other]]", io), null);
  assert.notEqual(readCallout("> [!note] T\n> see [[Other]]", io), null, "a well formed link in the body is fine");
  assert.equal(readCallout("> [!note] T\n> <div>x</div>", io), null);
  assert.equal(readCallout("> [!note] T\nlazy line without marker", io), null);
  assert.equal(readCallout("> [!note] A [[link]] title", io), null);
  assert.equal(readTable("| a | [[link]] |\n|---|---|\n| 1 | 2 |", io), null, "links in table cells stay raw");
  assert.equal(readCallout("> [!note] T\r\n> body", io), null);
});

test("a toggle is read and written back in the usual layout", () => {
  const src = "<details>\n<summary>More</summary>\n\nHidden text\n\nSecond block\n\n</details>";
  const node = readDetails(src, io);
  assert.equal(node.attrs.summary, "More");
  assert.equal(node.attrs.open, false);
  assert.equal(writeDetails(node, serialize), src);
  assert.equal(readDetails("<details open>\n<summary>x</summary>\n\nbody\n\n</details>", io).attrs.open, true);
});

test("odd toggles stay raw", () => {
  assert.equal(readDetails("<details>\n<summary>A <b>b</b></summary>\n\nx\n\n</details>", io), null);
  assert.equal(readDetails("<details>\nno summary\n</details>", io), null);
});

test("a toggle with blank lines inside is one block, and an unclosed one is not", () => {
  const closed = "<details>\n<summary>S</summary>\n\nA\n\nB\n\n</details>\n\nafter";
  assert.deepEqual(splitBlocks(closed).blocks.map((b) => b.kind), ["details", "paragraph"]);
  assert.deepEqual(splitBlocks("<details>\n<summary>S</summary>\n\nA").blocks.map((b) => b.kind), ["raw", "paragraph"]);
});

test("a table is read with its alignment and written back", () => {
  const src = "| name | qty | note |\n| :--- | ---: | :---: |\n| apple | 3 | ok |\n| pear | 10 | |";
  const node = readTable(src, io);
  assert.deepEqual(node.attrs.aligns, ["left", "right", "center"]);
  assert.equal(node.content.length, 3);
  assert.equal(writeTable(node, serialize), src.replace("| pear | 10 | |", "| pear | 10 |  |"));
});

test("a table keeps an escaped pipe inside its cell", () => {
  const src = "| a | b |\n| --- | --- |\n| x \\| y | z |";
  const node = readTable(src, io);
  assert.equal(writeTable(node, serialize), src);
});

test("tables the editor cannot hold stay raw", () => {
  assert.equal(readTable("| a | b |\n| --- | --- |\n| only one |", io), null);
  assert.equal(readTable("| a | b |\n| -- x | --- |", io), null);
  assert.equal(readTable("| a | [[b]] |\n| --- | --- |", io), null);
  assert.equal(readTable("a | b\n--- | ---", io), null);
  const wide = `|${" a |".repeat(31)}\n|${" --- |".repeat(31)}`;
  assert.equal(readTable(wide, io), null);
});

test("images: only standard markdown into attachments, only safe types", () => {
  assert.deepEqual(readImage("![a diagram](attachments/cell-1.png)").attrs, { alt: "a diagram", path: "attachments/cell-1.png" });
  assert.equal(writeImage(readImage("![](attachments/a.JPG)")), "![](attachments/a.JPG)");
  assert.equal(readImage("![](attachments/a.svg)"), null);
  assert.equal(readImage("![](attachments/../secret.png)"), null);
  assert.equal(readImage("![](https://example.local/a.png)"), null);
  assert.equal(readImage("![](attachments/a.png) trailing"), null);
  assert.equal(readImage("![a]b](attachments/a.png)"), null);
});

test("an image size at the end of the description is read and written back unchanged", () => {
  const path = "attachments/a.png";
  const sized = readImage("![a cell|300x200](attachments/a.png)");
  assert.deepEqual(sized.attrs, { alt: "a cell", path, width: 300, height: 200 });
  assert.equal(writeImage(sized), "![a cell|300x200](attachments/a.png)");
  const widthOnly = readImage("![|300](attachments/a.png)");
  assert.deepEqual(widthOnly.attrs, { alt: "", path, width: 300 });
  assert.equal(writeImage(widthOnly), "![|300](attachments/a.png)");
  // Only the last number counts; an earlier pipe stays in the description.
  assert.deepEqual(readImage("![a|5|300](attachments/a.png)").attrs, { alt: "a|5", path, width: 300 });
  // Odd sizes mean the natural size and the text stays exactly as it was.
  for (const odd of ["a|0", "a|99999", "a|10001", "a|300x", "a|x200", "a|-5", "a|1e3", "a|3 00", "a|300x200x1"]) {
    const read = readImage(`![${odd}](attachments/a.png)`);
    assert.deepEqual(read.attrs, { alt: odd, path }, odd);
    assert.equal(writeImage(read), `![${odd}](attachments/a.png)`, odd);
  }
  // A description that only looks like a size is not turned into one when written.
  assert.equal(writeImage({ attrs: { alt: "a|300", path } }), "![a 300](attachments/a.png)");
  // Sizes round to whole numbers.
  assert.equal(writeImage({ attrs: { alt: "x", path, width: 120.6, height: 80.2 } }), "![x|121x80](attachments/a.png)");
});

const NOTE = [
  "---\nid: 1\n---\n\n# Title\n\n",
  "> [!note] Cells\n> The cell is small.\n\n",
  "<details>\n<summary>Why</summary>\n\nBecause.\n\n</details>\n\n",
  "| a | b |\n|---|---|\n| 1 | 2 |\n\n",
  "![](attachments/cell.png)\n\n",
  "> [!danger] Raw one\n> has ![[an embed]]\n\nEnd\n",
].join("");

test("a note with every rich block, opened and saved untouched, is identical", () => {
  const loaded = loadNote(NOTE, io);
  const types = loaded.doc.content.map((n) => n.type);
  assert.deepEqual(types, ["heading", "callout", "toggle", "table", "imageBlock", "rawBlock", "paragraph"]);
  assert.equal(composeNote(loaded.parts, loaded.doc, { ...io, assignId: false }), NOTE);
});

test("changing one callout title rewrites only that callout", () => {
  const loaded = loadNote(NOTE, io);
  loaded.doc.content[1].attrs.title = "Renamed";
  const out = composeNote(loaded.parts, loaded.doc, { ...io, assignId: false });
  assert.equal(out, NOTE.replace("> [!note] Cells", "> [!note] Renamed"));
});

test("random documents with rich blocks always come back byte for byte", () => {
  const pool = ["> [!note] T", "> body", ">", "<details>", "<summary>S</summary>", "</details>", "", "| a | b |", "|---|---|", "| 1 | 2 |", "![](attachments/a.png)", "![x](attachments/b.webp)", "text", "- item", "[[x]]", "<div>", "> [!x]+", "```", "\\|"];
  let seed = 777;
  const rand = (n) => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) % n);
  for (let round = 0; round < 4000; round++) {
    const lines = Array.from({ length: rand(14) }, () => pool[rand(pool.length)]);
    const original = lines.join("\n") + (rand(2) ? "\n" : "");
    const { front, body } = splitFrontmatter(original);
    assert.equal(front + (() => { const s = splitBlocks(body); return s.lead + s.blocks.map((b) => b.src + b.gap).join(""); })(), original);
    const loaded = loadNote(original, io);
    assert.equal(composeNote(loaded.parts, loaded.doc, { ...io, assignId: false }), original, JSON.stringify(original));
  }
});

test("writeBlock writes plain editor nodes through the editor's own serializer", () => {
  assert.equal(writeBlock({ type: "paragraph", content: [text("hi")] }, serialize), "hi");
});

// ---------- moving blocks around ----------

// Every block of a note is moved to a random place. The text must still be the same blocks,
// each one intact and still separate from the others, never glued together.
test("moving blocks never glues two blocks together or changes one", () => {
  const notes = [
    "# One\ntext right below\n\nSecond paragraph\n\n- a\n- b\n\n> quote\n\n```\ncode\n```\n\n---\n\nLast paragraph",
    "---\nid: 1\n---\n\n# Title\n\n> [!note] C\n> body\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n<div>raw</div>\n\n![](attachments/a.png)\n\nlast\n",
    "alpha\n\nbeta\n\n\n\ngamma\n",
    "a\n\nb ^abc123\n\nc\n",
  ];
  let seed = 4242;
  const rand = (n) => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) % n);
  for (const original of notes) {
    const before = splitBlocks(splitFrontmatter(original).body).blocks.map((b) => b.src);
    for (let round = 0; round < 300; round++) {
      const loaded = loadNote(original, io);
      const doc = { type: "doc", content: [...loaded.doc.content] };
      // shuffle
      for (let i = doc.content.length - 1; i > 0; i--) {
        const j = rand(i + 1);
        [doc.content[i], doc.content[j]] = [doc.content[j], doc.content[i]];
      }
      const out = composeNote(loaded.parts, doc, { ...io, assignId: false });
      const after = splitBlocks(splitFrontmatter(out).body).blocks.map((b) => b.src);
      assert.deepEqual([...after].sort(), [...before].sort(), JSON.stringify({ original, out }));
      // A file that ended with a line break still does. (One that did not may gain one.)
      if (original.endsWith("\n")) assert.ok(out.endsWith("\n"), JSON.stringify({ original, out }));
    }
  }
});

test("a paragraph's block id is kept apart from its text and written back", () => {
  const loaded = loadNote("hello world ^abc-1\n", io);
  assert.equal(loaded.doc.content[0].type, "paragraph");
  assert.equal(loaded.doc.content[0].attrs.blockId, "abc-1");
  assert.equal(composeNote(loaded.parts, loaded.doc, { ...io, assignId: false }), "hello world ^abc-1\n");
  // a new id on a paragraph that had none
  const plain = loadNote("hello\n", io);
  plain.doc.content[0].attrs.blockId = "x1y2";
  assert.equal(composeNote(plain.parts, plain.doc, { ...io, assignId: false }), "hello ^x1y2\n");
});

test("a block id is never written twice, and an id line after a list stays raw", () => {
  const loaded = loadNote("one ^dup\n\ntwo\n", io);
  loaded.doc.content[1].attrs.blockId = "dup";
  assert.equal(composeNote(loaded.parts, loaded.doc, { ...io, assignId: false }), "one ^dup\n\ntwo\n");
  const list = loadNote("- a\n- b\n\n^list-id\n", io);
  assert.deepEqual(list.doc.content.map((n) => n.type), ["bulletList", "rawBlock"]);
});

test("a callout, a toggle, a table and an image can sit inside a toggle, and are written back the same", () => {
  const src = [
    "<details>",
    "<summary>Skin</summary>",
    "",
    "> [!note] Drawing",
    "> The drawings are on the canvas.",
    "",
    "## Layers",
    "",
    "- one",
    "- two",
    "",
    "<details>",
    "<summary>Inner</summary>",
    "",
    "deep text",
    "",
    "</details>",
    "",
    "| a | b |",
    "| --- | --- |",
    "| 1 | 2 |",
    "",
    "![fig](attachments/fig.png)",
    "",
    "> [!tip] Exam tip",
    "> Draw it.",
    "",
    "</details>",
  ].join("\n");
  const node = readDetails(src, io);
  assert.notEqual(node, null, "the toggle is read, not kept raw");
  assert.deepEqual(node.content.map((n) => n.type), ["callout", "heading", "bulletList", "toggle", "table", "imageBlock", "callout"]);
  assert.equal(writeDetails(node, serialize), src, "and written back in the same layout");
});

test("a callout inside a callout is read, and something it cannot hold keeps the whole block raw", () => {
  const inside = readCallout("> [!note] Outer\n> text\n>\n> > [!tip] Inner\n> > deeper", io);
  assert.deepEqual(inside.content.map((n) => n.type), ["paragraph", "callout"]);
  assert.equal(readDetails("<details>\n<summary>x</summary>\n\n<div>raw html</div>\n\n</details>", io), null);
});

test("nesting that goes absurdly deep is kept raw instead of read without limit", () => {
  let src = "text";
  for (let i = 0; i < 20; i++) src = `<details>\n<summary>s</summary>\n\n${src}\n\n</details>`;
  assert.equal(readDetails(src, io), null);
});

test("a page with a callout inside a toggle opens as a toggle, not a raw block", () => {
  const text = "<details>\n<summary>Skin</summary>\n\n> [!note] Drawing\n> see canvas\n\ntext\n\n</details>\n";
  const { doc } = loadNote(text, io);
  assert.deepEqual(doc.content.map((n) => n.type), ["toggle"]);
  assert.equal(composeNote(loadNote(text, io).parts, doc, { serialize, assignId: false }), text, "untouched, the text is kept to the byte");
});

// ---------- columns ----------

const TWO = "> [!columns]\n> > [!column]\n> > left one\n> >\n> > left two\n>\n> > [!column]\n> > right";

test("a callout holding column callouts is read as columns and written back the same", () => {
  const node = readRichBlock("callout", TWO, io);
  assert.equal(node.type, "columns");
  assert.equal(node.content.length, 2);
  assert.ok(node.content.every((c) => c.type === "column"));
  assert.equal(node.content[0].content.length, 2);
  assert.equal(writeBlock(node, serialize), TWO);
});

test("columns hold callouts, toggles and tables, and an empty column is kept", () => {
  const src = "> [!columns]\n> > [!column]\n> > > [!tip] Inside\n> > > text\n>\n> > [!column]\n>\n> > [!column]\n> > <details>\n> > <summary>T</summary>\n> >\n> > body\n> >\n> > </details>";
  const node = readRichBlock("callout", src, io);
  assert.equal(node.type, "columns");
  assert.equal(node.content.length, 3);
  assert.equal(node.content[0].content[0].type, "callout");
  assert.equal(writeBlock(node, serialize), src);
});

test("a callout called columns that is not exactly columns stays an ordinary callout", () => {
  for (const src of [
    "> [!columns]\n> only text",
    "> [!columns] Title\n> > [!column]\n> > a\n>\n> > [!column]\n> > b",
    "> [!columns]-\n> > [!column]\n> > a\n>\n> > [!column]\n> > b",
    "> [!columns]\n> > [!column]\n> > only one column",
    "> [!columns]\n> > [!column] Named\n> > a\n>\n> > [!column]\n> > b",
    "> [!columns]\n> > [!note]\n> > a\n>\n> > [!column]\n> > b",
  ]) {
    const node = readRichBlock("callout", src, io);
    assert.equal(node.type, "callout", src);
    assert.equal(writeBlock(node, serialize), src, "and it is written back as it was");
  }
});

test("more columns than the limit is an ordinary callout, and columns do not nest", () => {
  const many = ["> [!columns]", ...Array.from({ length: MAX_COLUMNS + 1 }, (_, i) => `> > [!column]\n> > c${i}\n>`)].join("\n").replace(/\n>$/, "");
  assert.equal(readRichBlock("callout", many, io).type, "callout");
  const nested = "> [!note]\n> > [!columns]\n> > > [!column]\n> > > a\n> >\n> > > [!column]\n> > > b";
  const outer = readRichBlock("callout", nested, io);
  assert.equal(outer.type, "callout");
  assert.equal(outer.content[0].type, "callout", "inside another block it is a plain callout, which the editor can hold");
});

test("a page with columns opens with the columns block and an untouched page is written back byte for byte", () => {
  const page = `Before\n\n${TWO}\n\nAfter\n`;
  const { parts, doc } = loadNote(page, io);
  assert.ok(doc.content.some((n) => n.type === "columns"));
  assert.equal(composeNote(parts, doc, { ...io, assignId: false }), page);
});
