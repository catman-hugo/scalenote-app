import test from "node:test";
import assert from "node:assert/strict";
import { blockAtY, blockTag, findBlock, fromFractions, inkFromScreen, inkToScreen, lineTouched, toFractions, TAG_LENGTH } from "../web/textink.js";
import { emptyCanvas, parseCanvas, serializeCanvas, canAddItem, totalPoints } from "../web/canvasrules.js";

const ink = (extra = {}) => ({ tool: "pen", color: "red", width: 4, anchor: { block: 2, tag: "p:Hello" }, points: [[0.1, 0.5, 0.5], [0.9, 0.5, 0.7]], ...extra });
const withInk = (...list) => ({ ...emptyCanvas(), ink: list });

test("a fingerprint is the kind and the first words, with spaces made even", () => {
  assert.equal(blockTag("p", "  Hello \n  world "), "p:Hello world");
  assert.equal(blockTag("h1", "x".repeat(500)).length, 3 + TAG_LENGTH);
  assert.equal(blockTag("p", ""), "p:");
});

test("a block is found again at its place, or by its words when blocks moved", () => {
  const tags = ["p:a", "p:b", "p:c", "p:b"];
  assert.equal(findBlock(tags, { block: 1, tag: "p:b" }), 1, "same place wins");
  assert.equal(findBlock(tags, { block: 2, tag: "p:b" }), 1, "nearest with the same words (tie: the earlier one)");
  assert.equal(findBlock(tags, { block: 3, tag: "p:b" }), 3);
  assert.equal(findBlock(tags, { block: 0, tag: "p:gone" }), -1, "words that are not there: no block, the ink is kept but not shown");
  assert.equal(findBlock([], { block: 0, tag: "p:a" }), -1);
});

test("the block under the first point is chosen, the nearest one in the gaps", () => {
  const rects = [{ top: 0, bottom: 40 }, { top: 50, bottom: 90 }, { top: 100, bottom: 140 }];
  assert.equal(blockAtY(rects, 20), 0);
  assert.equal(blockAtY(rects, 95), 1, "nearer to the second block's bottom than to the third's top? 5 vs 5 keeps the first found");
  assert.equal(blockAtY(rects, 97), 2);
  assert.equal(blockAtY(rects, -30), 0);
  assert.equal(blockAtY(rects, 900), 2);
  assert.equal(blockAtY([], 5), -1);
});

test("points are kept as fractions of the block, so a different width moves them with the text", () => {
  const wide = { left: 100, top: 200, width: 400, height: 40 };
  const narrow = { left: 50, top: 300, width: 200, height: 80 };
  const stroke = { tool: "pen", color: "ink", width: 4, points: [[150, 210, 0.5], [450, 230, 1]] };
  const saved = inkFromScreen(stroke, wide, { block: 3, tag: "p:Hi" });
  assert.deepEqual(saved.points, [[0.125, 0.25, 0.5], [0.875, 0.75, 1]]);
  assert.deepEqual(saved.anchor, { block: 3, tag: "p:Hi" });
  assert.deepEqual(inkToScreen(saved, wide), stroke.points, "back on the same box: same place");
  assert.deepEqual(inkToScreen(saved, narrow), [[75, 320, 0.5], [225, 360, 1]], "narrower and taller box: same spot on the words");
  assert.deepEqual(fromFractions(...toFractions(7, 9, wide), wide), [7, 9]);
});

test("a block with no size does not divide by nothing", () => {
  const flat = { left: 0, top: 0, width: 0, height: 0 };
  const [fx, fy] = toFractions(5, 5, flat);
  assert.ok(Number.isFinite(fx) && Number.isFinite(fy));
});

test("the eraser touches a line near it and not one far away", () => {
  const line = [[0, 0, 0.5], [100, 0, 0.5]];
  assert.ok(lineTouched(line, 50, 8, 10));
  assert.ok(!lineTouched(line, 50, 30, 10));
  assert.ok(lineTouched([[10, 10, 0.5]], 12, 10, 5), "a dot");
});

test("ink is written as format 5 and read back, and only then", () => {
  const text = serializeCanvas(withInk(ink()));
  assert.ok(text.startsWith('{"format":5,'), text);
  const back = parseCanvas(text);
  assert.deepEqual(back.canvas.ink, [ink()]);
  assert.equal(serializeCanvas(back.canvas), text, "writing what was read changes nothing");
  assert.ok(serializeCanvas(emptyCanvas()).startsWith('{"format":1,'), "no ink: still readable by older versions");
});

test("ink travels together with the sheet's own items, paper and page colour", () => {
  const canvas = { items: [{ tool: "shape", kind: "rect", color: "blue", width: 4, a: [0, 0], b: [50, 50] }], paper: "grid-2", page: "sky", ink: [ink()] };
  const back = parseCanvas(serializeCanvas(canvas)).canvas;
  assert.equal(back.items.length, 1);
  assert.equal(back.paper, "grid-2");
  assert.equal(back.page, "sky");
  assert.equal(back.ink.length, 1);
});

test("bad ink makes the whole drawing read-only, never half kept", () => {
  const file = (piece) => `{"format":5,"items":[],"ink":[${JSON.stringify(piece)}]}`;
  assert.ok(parseCanvas(file(ink())).canvas);
  for (const bad of [
    ink({ tool: "shape" }), ink({ color: "teal" }), ink({ width: -1 }), ink({ points: [] }), ink({ points: [[0, 0]] }),
    ink({ points: [[1e6, 0, 0.5]] }), ink({ points: [[0, 0, 2]] }), ink({ anchor: { block: -1, tag: "p:x" } }),
    ink({ anchor: { block: 1.5, tag: "p:x" } }), ink({ anchor: { block: 1, tag: 5 } }), ink({ anchor: null }), "text", null,
  ]) {
    assert.equal(parseCanvas(file(bad)).problem, "broken", JSON.stringify(bad));
  }
  assert.equal(parseCanvas('{"format":5,"items":[],"ink":{}}').problem, "broken");
  assert.equal(parseCanvas('{"format":4,"items":[],"ink":[]}').canvas.ink.length, 0, "ink in a file too old to have it is not read");
  assert.equal(parseCanvas('{"format":7,"items":[]}').problem, "newer");
});

test("an unknown key on a piece of ink is dropped, not carried into the program", () => {
  const text = `{"format":5,"items":[],"ink":[${JSON.stringify({ ...ink(), extra: 1, __proto__x: 2 })}]}`;
  assert.deepEqual(Object.keys(parseCanvas(text).canvas.ink[0]).sort(), ["anchor", "color", "points", "tool", "width"]);
});

test("ink counts towards the limits of the drawing", () => {
  const canvas = withInk(ink(), ink());
  assert.equal(totalPoints(canvas), 4);
  assert.ok(canAddItem(canvas, 10));
});

// ---- long strokes ----
import { splitByBlock, inkFromScreen as ink2, FRACTION_LIMIT } from "../web/textink.js";
import { parseCanvas as parse2, serializeCanvas as serialize2, emptyCanvas as empty2 } from "../web/canvasrules.js";

const THREE = [{ top: 0, bottom: 30 }, { top: 50, bottom: 80 }, { top: 100, bottom: 130 }];

test("a stroke across three blocks is cut into one piece per block, joined at the cuts", () => {
  const points = [[5, 10, 0.5], [5, 20, 0.5], [5, 60, 0.5], [5, 70, 0.5], [5, 120, 0.5]];
  const pieces = splitByBlock(points, THREE);
  assert.deepEqual(pieces.map((p) => p.block), [0, 1, 2]);
  assert.deepEqual(pieces[0].points, [[5, 10, 0.5], [5, 20, 0.5], [5, 60, 0.5]]);
  assert.deepEqual(pieces[1].points, [[5, 60, 0.5], [5, 70, 0.5], [5, 120, 0.5]]);
  assert.deepEqual(pieces[2].points, [[5, 120, 0.5]]);
});

test("a stroke inside one block stays one piece, and no blocks gives nothing", () => {
  assert.equal(splitByBlock([[1, 5, 1], [2, 6, 1]], THREE).length, 1);
  assert.deepEqual(splitByBlock([[1, 5, 1]], []), []);
});

test("a stroke in the space below a one-line block keeps its shape and is saved", () => {
  const stroke = { tool: "pen", color: "ink", width: 8, points: [[5, 130, 0.5], [60, 900, 0.5], [5, 1700, 0.5], [60, 2400, 0.5]] };
  const piece = ink2(stroke, { left: 0, top: 100, width: 400, height: 30 }, { block: 2, tag: "p:x" });
  const back = inkToScreen(piece, { left: 0, top: 100, width: 400, height: 30 });
  assert.deepEqual(back.map((p) => Math.round(p[1])), [130, 900, 1700, 2400], "nothing is flattened");
  const canvas = empty2();
  canvas.ink.push(piece);
  assert.equal(parse2(serialize2(canvas)).problem, undefined);
});

test("a stroke absurdly far below a block is pulled in so the saved file is still accepted", () => {
  const stroke = { tool: "pen", color: "ink", width: 8, points: [[5, 120, 0.5], [5, 9000, 0.5]] };
  const piece = ink2(stroke, { left: 0, top: 100, width: 400, height: 30 }, { block: 2, tag: "p:x" });
  assert.ok(piece.points.every(([, fy]) => Math.abs(fy) <= FRACTION_LIMIT));
  const canvas = empty2();
  canvas.ink.push(piece);
  assert.equal(parse2(serialize2(canvas)).problem, undefined);
});
