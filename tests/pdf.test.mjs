// Tests for the plain rules of PDF import (web/pdfrules.js) and for how a PDF link is read from
// and written to a page (web/blocks.js, web/richblocks.js, web/compose.js).

import test from "node:test";
import assert from "node:assert/strict";
import { PDF_LIMITS, checkPdf, isPdfPath, pageFileName, pageScale, pdfTitle } from "../web/pdfrules.js";
import { splitBlocks } from "../web/blocks.js";
import { readImage, readRichBlock, writeBlock } from "../web/richblocks.js";

test("a PDF is accepted by type or by name, and refused when empty, too big or something else", () => {
  assert.equal(checkPdf({ name: "a.pdf", type: "application/pdf", size: 10 }), null);
  assert.equal(checkPdf({ name: "A.PDF", type: "", size: 10 }), null);
  assert.equal(checkPdf({ name: "scan", type: "application/pdf", size: 10 }), null);
  assert.equal(checkPdf({ name: "a.png", type: "image/png", size: 10 }), "unsupported_type");
  assert.equal(checkPdf({ name: "a.pdf.exe", type: "", size: 10 }), "unsupported_type");
  assert.equal(checkPdf({ name: "a.pdf", type: "application/pdf", size: 0 }), "unsupported_type");
  assert.equal(checkPdf({ name: "a.pdf", type: "application/pdf", size: PDF_LIMITS.bytes }), null);
  assert.equal(checkPdf({ name: "a.pdf", type: "application/pdf", size: PDF_LIMITS.bytes + 1 }), "too_large_pdf");
});

test("a page picture is 1.5 times its paper size but never has more pixels than allowed", () => {
  assert.equal(pageScale(595, 842), 1.5);
  const poster = pageScale(5000, 7000);
  assert.ok(poster < 1.5 && poster >= 0.1);
  assert.ok(5000 * poster * 7000 * poster <= PDF_LIMITS.pagePixels * 1.001);
  assert.equal(pageScale(0, 0), 1.5, "a page of no size gets the normal scale instead of NaN");
  assert.equal(pageScale(NaN, 5), 1.5);
  assert.equal(pageScale(1e9, 1e9), 0.1, "never smaller than a tenth");
  assert.ok(pageScale(595, 842, PDF_LIMITS.viewPixels, 2.7) <= 2.7);
});

test("names for the pages and the description are safe in a markdown link", () => {
  assert.equal(pdfTitle("Lecture 1 (slides).pdf"), "Lecture 1 (slides)");
  assert.equal(pdfTitle("C:\\Users\\alice\\Notes [draft]|v2.PDF"), "Notes draft v2");
  assert.equal(pdfTitle(".pdf"), "PDF");
  assert.equal(pdfTitle("x".repeat(200) + ".pdf").length, 80);
  assert.equal(pageFileName("Lecture 1.pdf", 7, 12), "Lecture 1-p07.jpg");
  assert.equal(pageFileName("a.pdf", 3, 9), "a-p3.jpg");
  assert.ok(isPdfPath("attachments/a.PDF"));
  assert.ok(!isPdfPath("attachments/a.pdf.png"));
  assert.ok(!isPdfPath(null));
});

test("a link to a PDF in attachments is its own block, and is written back exactly", () => {
  const src = "![Lecture 1](attachments/Lecture-1.pdf)";
  const { blocks } = splitBlocks(`before\n\n${src}\n\nafter\n`);
  assert.deepEqual(blocks.map((b) => b.kind), ["paragraph", "image", "paragraph"]);
  const node = readRichBlock("image", src);
  assert.deepEqual(node, { type: "pdfBlock", attrs: { alt: "Lecture 1", path: "attachments/Lecture-1.pdf" } });
  assert.equal(writeBlock(node), src);
  // A picture next to it is still a picture.
  assert.equal(readRichBlock("image", "![a](attachments/a.png)").type, "imageBlock");
});

test("a PDF link that is not a plain attachment link stays as it was", () => {
  for (const bad of ["![x](attachments/../secret.pdf)", "![x](https://example.local/a.pdf)", "![x](a.pdf)", "![x](attachments/sub/../a.pdf)", "![x](attachments/a.pdf \"title\")", "![x](attachments/a b.pdf)"]) {
    const { blocks } = splitBlocks(`${bad}\n`);
    assert.notEqual(blocks[0].kind === "image" && readRichBlock("image", bad) !== null, true, bad);
  }
  assert.equal(readImage("![x](attachments/a.pdf.exe)"), null);
});

test("a PDF has no size: a size typed into its description is just text", () => {
  const node = readRichBlock("image", "![Notes|300](attachments/n.pdf)");
  assert.equal(node.type, "pdfBlock");
  assert.equal(node.attrs.alt, "Notes|300");
  assert.equal(writeBlock(node), "![Notes|300](attachments/n.pdf)");
  assert.equal(writeBlock({ type: "pdfBlock", attrs: { alt: "a]b\nc", path: "attachments/n.pdf" } }), "![a b c](attachments/n.pdf)");
});
