import test from "node:test";
import assert from "node:assert/strict";
import { decodePageText, encodePageText, hitsOnPicture, LIMITS, textPathOf } from "../web/imagetext.js";
import { MIN_PDF_WIDTH, pdfWidthAfter } from "../web/pdfrules.js";
import { readImage, writePdf } from "../web/richblocks.js";

test("the words of a page are kept as parts of the picture's size and read back the same", () => {
  const raw = encodePageText([{ text: "Hello world", x: 30, y: 40, w: 120, h: 20 }, { text: "   ", x: 0, y: 0, w: 1, h: 1 }], 300, 400);
  const items = decodePageText(raw);
  assert.deepEqual(items, [{ text: "Hello world", x: 0.1, y: 0.1, w: 0.4, h: 0.05 }], "empty pieces are left out");
  assert.equal(encodePageText([], 300, 400), null, "no words, no file");
  assert.equal(encodePageText([{ text: "a", x: 0, y: 0, w: 1, h: 1 }], 0, 400), null);
  assert.equal(textPathOf("attachments/a-p1.jpg"), "attachments/a-p1.jpg.text.json");
});

test("a file from elsewhere is not trusted: bad shapes are skipped, boxes stay on the picture, a newer format is ignored", () => {
  assert.deepEqual(decodePageText("not json"), []);
  assert.deepEqual(decodePageText(JSON.stringify({ format: 2, items: [["a", 0, 0, 1, 1]] })), []);
  assert.deepEqual(decodePageText(undefined), []);
  assert.deepEqual(decodePageText("x".repeat(LIMITS.fileBytes + 1)), []);
  const odd = JSON.stringify({ format: 1, items: [["ok", -1, 0.5, 5, 9], [1, 0, 0, 1, 1], ["nan", "x", 0, 1, 1], "text", ["__proto__", 0, 0, 0.1, 0.1]] });
  const items = decodePageText(odd);
  assert.deepEqual(items[0], { text: "ok", x: 0, y: 0.5, w: 1, h: 0.5 });
  assert.equal(items.length, 2);
  assert.equal(({}).polluted, undefined);
});

test("a hit on a picture covers about the typed letters, not the whole piece", () => {
  const items = [{ text: "Page 12", x: 0.1, y: 0.2, w: 0.7, h: 0.05 }];
  const [hit] = hitsOnPicture(items, "12");
  assert.ok(Math.abs(hit.x - 0.6) < 1e-9 && Math.abs(hit.w - 0.2) < 1e-9, JSON.stringify(hit));
  assert.equal(hit.y, 0.2);
  assert.equal(hitsOnPicture(items, "PAGE").length, 1, "case is ignored");
  // With measured widths, a narrow letter takes less room than a wide one.
  const width = (t) => [...t].reduce((sum, c) => sum + (c === "i" ? 1 : 3), 0);
  const [narrow] = hitsOnPicture([{ text: "iiim", x: 0, y: 0, w: 1, h: 1 }], "m", LIMITS.hits, width);
  assert.ok(Math.abs(narrow.x - 0.5) < 1e-9 && Math.abs(narrow.w - 0.5) < 1e-9, JSON.stringify(narrow));
  assert.deepEqual(hitsOnPicture(items, "  "), []);
  const many = [{ text: "a".repeat(LIMITS.itemChars), x: 0, y: 0, w: 1, h: 1 }];
  assert.equal(hitsOnPicture(Array(10).fill(many[0]), "a").length, LIMITS.hits);
});

test("a PDF's width follows its side handle, stays between the smallest width and the page, and full width writes nothing", () => {
  assert.equal(pdfWidthAfter(800, -100, 1, 900), 600, "the right handle moved left by 100 makes it 200 narrower");
  assert.equal(pdfWidthAfter(800, 100, -1, 900), 600, "the left handle moved right does the same");
  assert.equal(pdfWidthAfter(800, -1000, 1, 900), MIN_PDF_WIDTH);
  assert.equal(pdfWidthAfter(800, 100, 1, 900), null, "as wide as the page");
});

test("a PDF's width is written Obsidian-style and read back; an odd size stays part of the name", () => {
  const node = { attrs: { alt: "Lecture", path: "attachments/n.pdf", width: 600 } };
  assert.equal(writePdf(node), "![Lecture|600](attachments/n.pdf)");
  assert.deepEqual(readImage("![Lecture|600](attachments/n.pdf)"), { type: "pdfBlock", attrs: { alt: "Lecture", path: "attachments/n.pdf", width: 600 } });
  assert.equal(writePdf({ attrs: { alt: "Lecture", path: "attachments/n.pdf" } }), "![Lecture](attachments/n.pdf)");
  assert.deepEqual(readImage("![Lecture](attachments/n.pdf)"), { type: "pdfBlock", attrs: { alt: "Lecture", path: "attachments/n.pdf" } });
  assert.equal(readImage("![Notes|99999](attachments/n.pdf)").attrs.alt, "Notes|99999", "out of range: kept as text");
});
