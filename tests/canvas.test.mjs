import test from "node:test";
import assert from "node:assert/strict";
import {
  DrawingHistory, LIMITS, NOTE, arrowHead, boundsOf, canAddItem, canMove, emptyCanvas, itemTouched, itemsInLoop, itemsTouched,
  MARGIN_X, PAGE_COLOURS, PAPERS, isLightBackground, moveAnchor, moveItem, noteTextHeight, pageFill, paperInks, paperLayout, parseCanvas, pointInLoop, serializeCanvas, snappedShift, strokeTouched, widthAt, wrapText, SHAPE_GRID, snapToGrid, figureOf, tidyStroke, HIGHLIGHT_SLACK } from "../web/canvasrules.js";

const stroke = (points, color = "ink", width = 4, tool = "pen") => ({ tool, color, width, points });
const shape = (kind, a, b, color = "ink", width = 4) => ({ tool: "shape", kind, color, width, a, b });
const note = (x, y, text = "hi", color = "ink") => ({ tool: "note", color, x, y, w: 180, h: 60, text });
const withItems = (...items) => ({ items });

test("a pen-only drawing is written and read back exactly, apart from rounding, in the 0.4.0 file format", () => {
  const canvas = withItems(stroke([[1.04, 2.06, 0.5], [10, 20, 0.123]]), stroke([[0, 0, 1]], "red", 8));
  const text = serializeCanvas(canvas);
  assert.equal(text.split("\n").length, 5, "one stroke per line");
  assert.ok(text.startsWith('{"format":1,"strokes":['), "an older ScaleNote can still open it");
  const back = parseCanvas(text);
  assert.deepEqual(back.canvas.items[0].points, [[1, 2.1, 0.5], [10, 20, 0.12]]);
  assert.equal(back.canvas.items[1].color, "red");
  assert.equal(serializeCanvas(back.canvas), text, "writing what was read changes nothing");
  assert.deepEqual(parseCanvas(serializeCanvas(emptyCanvas())), { canvas: { items: [], paper: "none", page: "none" } });
});

test("a drawing with highlighter, shapes and notes round-trips in the new format", () => {
  const canvas = withItems(
    stroke([[0, 0, 0.5], [5, 5, 0.5]], "blue", 4, "highlighter"),
    shape("arrow", [1.26, 2], [30, 40.04], "red", 2),
    shape("ellipse", [0, 0], [10, 10]),
    note(5, 6, "Line one\nLine \"two\"", "green"),
    stroke([[0, 0, 0.5]]),
  );
  const text = serializeCanvas(canvas);
  assert.ok(text.startsWith('{"format":2,"items":['));
  assert.equal(text.split("\n").length, 8, "one item per line");
  const back = parseCanvas(text);
  assert.ok(back.canvas, "read back");
  assert.equal(back.canvas.items.length, 5);
  assert.deepEqual(back.canvas.items[1].a, [1.3, 2]);
  assert.equal(back.canvas.items[3].text, 'Line one\nLine "two"');
  assert.equal(serializeCanvas(back.canvas), text);
});

test("an old reader's file is still read, and new kinds are not allowed in the old format", () => {
  assert.ok(parseCanvas('{"format":1,"strokes":[{"tool":"pen","color":"ink","width":4,"points":[[0,0,0.5]]}]}').canvas);
  const sneaky = '{"format":1,"strokes":[{"tool":"highlighter","color":"ink","width":4,"points":[[0,0,0.5]]}]}';
  assert.ok(parseCanvas(sneaky).problem, "format 1 holds pen strokes only");
  const shapeInOld = '{"format":1,"strokes":[{"tool":"shape","kind":"line","color":"ink","width":4,"a":[0,0],"b":[1,1]}]}';
  assert.ok(parseCanvas(shapeInOld).problem);
});

test("anything not understood is refused as a whole, never partly kept", () => {
  const stroke1 = (extra) => `{"format":1,"strokes":[{"tool":"pen","color":"ink","width":4,"points":[[0,0,0.5]]${extra || ""}},{"tool":"pen","color":"teal","width":4,"points":[[0,0,0.5]]}]}`;
  const bad = [
    "", "not json", "[]", "null", '{"format":1}', '{"format":1,"strokes":{}}', '{"format":0,"strokes":[]}', '{"format":1.5,"strokes":[]}', '{"format":"2","items":[]}', '{"format":2}',
    '{"format":1,"strokes":[{"tool":"pen","color":"teal","width":4,"points":[[0,0,0.5]]}]}',
    '{"format":1,"strokes":[{"tool":"pen","color":"ink","width":-1,"points":[[0,0,0.5]]}]}',
    '{"format":1,"strokes":[{"tool":"pen","color":"ink","width":4,"points":[]}]}',
    '{"format":1,"strokes":[{"tool":"pen","color":"ink","width":4,"points":[[0,0]]}]}',
    '{"format":1,"strokes":[{"tool":"pen","color":"ink","width":4,"points":[[0,0,2]]}]}',
    '{"format":1,"strokes":[{"tool":"pen","color":"ink","width":4,"points":[[1e9,0,0.5]]}]}',
    '{"format":1,"strokes":[{"tool":"pen","color":"ink","width":4,"points":[["a",0,0.5]]}]}',
    '{"format":1,"strokes":[{"tool":"laser","color":"ink","width":4,"points":[[0,0,0.5]]}]}',
    '{"format":1,"strokes":[null]}',
    stroke1(),
    '{"format":2,"items":[{"tool":"shape","kind":"star","color":"ink","width":4,"a":[0,0],"b":[1,1]}]}',
    '{"format":2,"items":[{"tool":"shape","kind":"line","color":"ink","width":4,"a":[0,0],"b":[1]}]}',
    '{"format":2,"items":[{"tool":"shape","kind":"line","color":"ink","width":4,"a":[0,0],"b":[1e9,1]}]}',
    '{"format":2,"items":[{"tool":"note","color":"ink","x":0,"y":0,"w":10,"h":60,"text":"x"}]}',
    '{"format":2,"items":[{"tool":"note","color":"ink","x":0,"y":0,"w":180,"h":60,"text":5}]}',
    '{"format":2,"items":[{"tool":"note","color":"teal","x":0,"y":0,"w":180,"h":60,"text":"x"}]}',
    `{"format":2,"items":[{"tool":"note","color":"ink","x":0,"y":0,"w":180,"h":60,"text":"${"a".repeat(LIMITS.noteText + 1)}"}]}`,
    '{"format":2,"items":[{"tool":"highlighter","color":"ink","width":4,"points":[]}]}',
    '{"format":2,"items":[{"tool":"eraser"}]}',
  ];
  for (const text of bad) assert.ok(parseCanvas(text).problem, `refused: ${text}`);
  assert.equal(parseCanvas('{"format":5,"items":[]}').problem, "newer", "a newer file is told apart, so it is not called broken");
  const mixed = '{"format":2,"items":[{"tool":"note","color":"ink","x":0,"y":0,"w":180,"h":60,"text":"ok"},{"tool":"pen","color":"x","width":4,"points":[[0,0,0.5]]}]}';
  assert.ok(parseCanvas(mixed).problem, "one bad item among good ones refuses the whole drawing");
});

test("limits are enforced on read and when adding", () => {
  const many = { format: 1, strokes: Array.from({ length: LIMITS.items + 1 }, () => stroke([[0, 0, 0.5]])) };
  assert.equal(parseCanvas(JSON.stringify(many)).problem, "too-big");
  const manyShapes = { format: 2, items: Array.from({ length: LIMITS.items + 1 }, () => shape("line", [0, 0], [1, 1])) };
  assert.equal(parseCanvas(JSON.stringify(manyShapes)).problem, "too-big");
  const long = { format: 1, strokes: [stroke(Array.from({ length: LIMITS.pointsPerStroke + 1 }, () => [0, 0, 0.5]))] };
  assert.ok(parseCanvas(JSON.stringify(long)).problem);
  const canvas = withItems(stroke([[0, 0, 0.5]]));
  assert.equal(canAddItem(canvas, 10), true);
  assert.equal(canAddItem(canvas), true, "a shape or note has no points");
  assert.equal(canAddItem(canvas, LIMITS.pointsPerStroke + 1), false);
  assert.equal(canAddItem(withItems(...Array.from({ length: LIMITS.items }, () => shape("line", [0, 0], [1, 1]))), 0), false);
});

test("hostile text does not run code or change the prototype, and unknown keys are not carried along", () => {
  const text = '{"format":2,"__proto__":{"polluted":true},"items":[{"tool":"note","color":"ink","x":0,"y":0,"w":180,"h":60,"text":"a","__proto__":{"x":1},"extra":"y"}]}';
  const result = parseCanvas(text);
  assert.equal({}.polluted, undefined);
  assert.equal({}.x, undefined);
  assert.equal(result.canvas.items[0].extra, undefined);
});

test("the eraser touches a stroke near a segment, a single dot, and misses a far one", () => {
  const line = stroke([[0, 0, 0.5], [100, 0, 0.5]], "ink", 4);
  assert.equal(strokeTouched(line, 50, 5, 4), true);
  assert.equal(strokeTouched(line, 50, 20, 4), false);
  assert.equal(strokeTouched(line, 150, 0, 4), false, "past the end of the segment");
  const dot = stroke([[10, 10, 0.5]]);
  assert.equal(strokeTouched(dot, 12, 10, 1), true);
  assert.equal(strokeTouched(dot, 30, 10, 1), false);
  assert.deepEqual(itemsTouched(withItems(line, dot), 10, 10, 3), [1]);
  assert.deepEqual(itemsTouched(withItems(line, dot), 10, 5, 3), [0, 1]);
});

test("a highlighter is wider than a pen, so the eraser reaches it from further away", () => {
  const pen = stroke([[0, 0, 0.5], [100, 0, 0.5]], "ink", 4);
  const marker = stroke([[0, 0, 0.5], [100, 0, 0.5]], "ink", 4, "highlighter");
  assert.equal(strokeTouched(pen, 50, 7, 1), false);
  assert.equal(strokeTouched(marker, 50, 7, 1), true);
});

test("the eraser touches the outline of a shape, not its empty middle, and the whole of a note", () => {
  const box = shape("rect", [0, 0], [100, 100]);
  assert.equal(itemTouched(box, 50, 2, 3), true, "the top edge");
  assert.equal(itemTouched(box, 50, 50, 3), false, "the empty middle");
  const circle = shape("ellipse", [0, 0], [100, 60]);
  assert.equal(itemTouched(circle, 50, 0, 2), true, "top of the ellipse");
  assert.equal(itemTouched(circle, 0, 0, 2), false, "the corner of its box is outside it");
  const arrow = shape("arrow", [0, 0], [100, 100]);
  assert.equal(itemTouched(arrow, 50, 52, 3), true);
  assert.equal(itemTouched(arrow, 90, 10, 3), false);
  const sticky = note(10, 10);
  assert.equal(itemTouched(sticky, 100, 40, 1), true, "inside the note");
  assert.equal(itemTouched(sticky, 300, 40, 1), false);
});

test("a loop selects the items with at least half of their points inside it", () => {
  const inside = stroke([[10, 10, 0.5], [20, 20, 0.5], [30, 30, 0.5]]);
  const outside = stroke([[200, 200, 0.5], [210, 210, 0.5]]);
  const half = stroke([[40, 40, 0.5], [50, 50, 0.5], [60, 60, 0.5], [300, 300, 0.5]]);
  const box = shape("rect", [5, 5], [45, 45]);
  const sticky = note(300, 300);
  const canvas = withItems(inside, outside, half, box, sticky);
  const loop = [[0, 0], [100, 0], [100, 100], [0, 100]];
  assert.deepEqual(itemsInLoop(canvas, loop), [0, 2, 3], "half counts, a note or stroke far away does not");
  assert.deepEqual(itemsInLoop(canvas, [[0, 0], [1, 1]]), [], "two points are not a loop");
  assert.equal(pointInLoop(50, 50, loop), true);
  assert.equal(pointInLoop(150, 50, loop), false);
  // A concave loop: the notch is outside.
  const notch = [[0, 0], [100, 0], [100, 100], [60, 100], [60, 40], [40, 40], [40, 100], [0, 100]];
  assert.equal(pointInLoop(50, 80, notch), false);
  assert.equal(pointInLoop(20, 80, notch), true);
});

test("a long stroke is sampled, so selecting stays fast", () => {
  const points = Array.from({ length: 5000 }, (_, i) => [i % 50, Math.floor(i / 50), 0.5]);
  const long = stroke(points);
  const started = performance.now();
  for (let i = 0; i < 200; i++) itemsInLoop(withItems(long), [[-1, -1], [60, -1], [60, 200], [-1, 200]]);
  assert.ok(performance.now() - started < 1000, "200 selections of a 5000-point stroke take under a second");
});

test("moving changes every kind of item, and the box around them follows", () => {
  const s = stroke([[0, 0, 0.5], [10, 10, 0.5]], "ink", 4);
  const sh = shape("line", [0, 0], [10, 0], "ink", 2);
  const n = note(5, 5);
  for (const item of [s, sh, n]) moveItem(item, 100, 50);
  assert.deepEqual(s.points[0], [100, 50, 0.5]);
  assert.deepEqual(sh.a, [100, 50]);
  assert.equal(n.x, 105);
  const box = boundsOf([sh]);
  assert.deepEqual([box.minX, box.maxX], [99, 111]);
  assert.equal(boundsOf([]), null);
  assert.equal(canMove([s], 10, 10), true);
  assert.equal(canMove([s], LIMITS.coordinate, 0), false, "not off the edge of the sheet");
  assert.equal(canMove([], 1, 1), false);
});

test("an arrow head points back from the tip", () => {
  const [left, right] = arrowHead([0, 0], [100, 0], 10);
  assert.ok(left[0] < 100 && right[0] < 100, "both barbs are behind the tip");
  assert.ok(Math.abs(left[1] + right[1]) < 1e-9, "one each side of the shaft");
  assert.ok(Math.abs(Math.hypot(left[0] - 100, left[1]) - 10) < 1e-9, "the barb has the asked length");
});

test("note text is cut into lines that fit, keeping new lines and breaking very long words", () => {
  const measure = (text) => text.length * 10;
  assert.deepEqual(wrapText("one two three", 80, measure), ["one two", "three"]);
  assert.deepEqual(wrapText("a\n\nb", 80, measure), ["a", "", "b"]);
  assert.deepEqual(wrapText("abcdefghijkl", 50, measure), ["abcde", "fghij", "kl"]);
  assert.deepEqual(wrapText("", 80, measure), [""]);
  assert.ok(wrapText("x ".repeat(3000), 30, measure).length > 100, "huge text does not hang or throw");
  assert.equal(noteTextHeight(1), NOTE.lineHeight + 2 * NOTE.padding, "one line needs a line plus the padding");
  assert.equal(noteTextHeight(10), 10 * NOTE.lineHeight + 2 * NOTE.padding);
});

test("the pen is thin for a light touch, plain for a mouse, thick for a firm one", () => {
  assert.ok(widthAt(4, 0.1) < widthAt(4, 0.5));
  assert.ok(widthAt(4, 0.5) < widthAt(4, 1));
  assert.ok(Math.abs(widthAt(4, 0.5) - 4) < 1.5);
  assert.ok(widthAt(4, 0) > 0);
});

test("undo and redo put items back where they were, including erased ones", () => {
  const a = stroke([[0, 0, 0.5]]);
  const b = stroke([[1, 1, 0.5]]);
  const c = stroke([[2, 2, 0.5]]);
  const canvas = withItems(a, b, c);
  const history = new DrawingHistory();
  history.record({ remove: [{ index: 0, item: a }, { index: 2, item: c }] });
  canvas.items.splice(2, 1);
  canvas.items.splice(0, 1);
  assert.deepEqual(canvas.items, [b]);
  assert.equal(history.undo(canvas), true);
  assert.deepEqual(canvas.items, [a, b, c]);
  assert.equal(history.redo(canvas), true);
  assert.deepEqual(canvas.items, [b]);
  history.undo(canvas);
  const d = stroke([[3, 3, 0.5]]);
  canvas.items.push(d);
  history.record({ add: d });
  assert.equal(history.canRedo, false, "a new stroke clears what could be redone");
  history.undo(canvas);
  assert.deepEqual(canvas.items, [a, b, c]);
  assert.equal(new DrawingHistory().undo(emptyCanvas()), false);
});

test("undo and redo also reverse moves and note edits", () => {
  const s = stroke([[0, 0, 0.5]]);
  const n = note(0, 0, "before");
  const canvas = withItems(s, n);
  const history = new DrawingHistory();
  moveItem(s, 10, 20);
  moveItem(n, 10, 20);
  history.record({ move: { items: [s, n], dx: 10, dy: 20 } });
  history.record({ edit: { item: n, before: { text: "before", h: 60 }, after: { text: "after", h: 80 } } });
  Object.assign(n, { text: "after", h: 80 });
  history.undo(canvas);
  assert.deepEqual([n.text, n.h], ["before", 60]);
  history.undo(canvas);
  assert.deepEqual(s.points[0], [0, 0, 0.5]);
  assert.equal(n.x, 0);
  history.redo(canvas);
  assert.deepEqual(s.points[0], [10, 20, 0.5]);
  history.redo(canvas);
  assert.equal(n.text, "after");
});

test("undoing the drawing of an item that is already gone does not remove another", () => {
  const a = stroke([[0, 0, 0.5]]);
  const b = stroke([[1, 1, 0.5]]);
  const canvas = withItems(a, b);
  const history = new DrawingHistory();
  history.record({ add: { ...a } }); // not in the list
  history.undo(canvas);
  assert.deepEqual(canvas.items, [a, b]);
});

test("history is limited so a long session does not grow without end", () => {
  const history = new DrawingHistory(3);
  for (let i = 0; i < 10; i++) history.record({ add: stroke([[i, 0, 0.5]]) });
  assert.equal(history.undoList.length, 3);
});

test("snapToGrid puts a value on the nearest grid line and leaves grid values alone", () => {
  assert.equal(SHAPE_GRID, 20);
  assert.equal(snapToGrid(16), 20);
  assert.equal(snapToGrid(9), 0);
  assert.equal(snapToGrid(-31), -40);
  assert.equal(snapToGrid(140), 140);
  assert.equal(snapToGrid(37, 10), 40);
});

test("the anchor of a selection is a corner of its first shape or note, and pen lines have none", () => {
  assert.equal(moveAnchor([]), null);
  assert.equal(moveAnchor([stroke([[1, 1, 0.5]])]), null);
  assert.deepEqual(moveAnchor([stroke([[1, 1, 0.5]]), shape("rect", [40, 60], [100, 120])]), [40, 60]);
  assert.deepEqual(moveAnchor([note(200, 80, "hi"), shape("rect", [40, 60], [100, 120])]), [200, 80]);
});

test("a snapped move puts the anchor exactly on the grid, whether or not it started there", () => {
  assert.deepEqual(snappedShift([40, 60], 37, 52), [40, 60]);
  assert.deepEqual(snappedShift([40, 60], 9, 9), [0, 0]);
  const [dx, dy] = snappedShift([43, 57], 10, -4);
  assert.equal(43 + dx, 60);
  assert.equal(57 + dy, 60);
  assert.deepEqual(snappedShift([0, 0], -31, 0), [-40, 0]);
});

test("a drawing with a paper or a page colour is written as format 3 and read back; without them nothing changes", () => {
  const pen = stroke([[1, 2, 0.5]]);
  const plain = serializeCanvas({ items: [pen], paper: "none", page: "none" });
  assert.ok(plain.startsWith('{"format":1,"strokes":['), "no paper: still the 0.4.0 format");
  const text = serializeCanvas({ items: [pen], paper: "grid-2", page: "sky" });
  assert.ok(text.startsWith('{"format":3,"items":['));
  assert.ok(text.trimEnd().endsWith('],"paper":"grid-2","page":"sky"}'), text);
  const back = parseCanvas(text);
  assert.equal(back.canvas.paper, "grid-2");
  assert.equal(back.canvas.page, "sky");
  assert.equal(back.canvas.items.length, 1);
  assert.equal(serializeCanvas(back.canvas), text, "writing what was read changes nothing");
  const onlyPage = parseCanvas(serializeCanvas({ items: [], paper: "none", page: "peach" })).canvas;
  assert.deepEqual([onlyPage.paper, onlyPage.page], ["none", "peach"]);
  const old = parseCanvas('{"format":2,"items":[{"tool":"pen","color":"ink","width":4,"points":[[0,0,0.5]]}]}').canvas;
  assert.deepEqual([old.paper, old.page], ["none", "none"], "an older drawing has no paper");
});

test("a paper or page colour this version does not know makes the drawing read-only instead of being dropped", () => {
  for (const extra of ['"paper":"dots"', '"paper":5', '"page":"teal"', '"page":null', '"paper":"rule-9"', '"paper":"none","page":"chartreuse"']) {
    assert.equal(parseCanvas(`{"format":3,"items":[],${extra}}`).problem, "broken", extra);
  }
  assert.ok(parseCanvas('{"format":3,"items":[],"paper":"rule-1"}').canvas, "a known one is fine");
});

test("papers have four spacings that are multiples of the shape grid, and the margin is on the grid too", () => {
  assert.deepEqual(PAPERS.slice(0, 2), ["none", "rule-1"]);
  assert.equal(paperLayout("none"), null);
  assert.equal(paperLayout("nonsense"), null);
  const steps = (kind) => [1, 2, 3, 4].map((n) => paperLayout(`${kind}-${n}`).step);
  assert.deepEqual(steps("rule"), [20, 40, 60, 80]);
  assert.deepEqual(steps("grid"), [20, 40, 60, 80]);
  for (const paper of PAPERS.slice(1)) assert.equal(paperLayout(paper).step % SHAPE_GRID, 0, paper);
  assert.equal(MARGIN_X % SHAPE_GRID, 0);
  assert.equal(paperLayout("rule-3").kind, "rule");
  assert.equal(paperLayout("grid-3").kind, "grid");
});

test("page colours are tinted by the theme: multiplied on a light background, mixed into a dark one", () => {
  assert.equal(PAGE_COLOURS.length, 17, "none and the sixteen colours");
  assert.equal(pageFill("none", "#f9f7f4"), "#f9f7f4");
  assert.equal(pageFill("not-a-colour", "#f9f7f4"), "#f9f7f4");
  assert.equal(pageFill("sky", "not a colour"), "not a colour", "a background that cannot be read is left alone");
  const light = pageFill("sky", "#ffffff");
  assert.equal(light, "#e8eefa", "on white the light tint is the colour itself");
  assert.equal(pageFill("sky", "#000000"), "#081424", "on black it is three quarters of the dark tint");
  assert.equal(pageFill("sky", "#181818"), "#0e1a2a", "and the rest is the theme's own dark");
  const warm = pageFill("sky", "#f5f0e8");
  assert.notEqual(warm, light, "a warm theme keeps some of its warmth");
  assert.ok(parseInt(warm.slice(1, 3), 16) > parseInt(warm.slice(5, 7), 16) - 20, "still warm: " + warm);
  for (const name of PAGE_COLOURS.slice(1)) {
    for (const background of ["#f9f7f4", "#181818", "#131c24", "#f8faf7"]) {
      assert.match(pageFill(name, background), /^#[0-9a-f]{6}$/, `${name} on ${background}`);
      assert.equal(isLightBackground(pageFill(name, background)), isLightBackground(background), `${name} keeps a ${background} page light or dark`);
    }
  }
});

test("paper lines are pale on a light page and dark on a dark one, with a red margin either way", () => {
  const light = paperInks("#f9f7f4");
  const dark = paperInks("#181818");
  assert.notEqual(light.line, dark.line);
  assert.ok(isLightBackground(light.line) && !isLightBackground(dark.line));
  assert.match(light.margin, /^#e/);
  assert.match(dark.margin, /^#8/);
});

test("changing the paper or the page colour can be undone and redone", () => {
  const canvas = emptyCanvas();
  const history = new DrawingHistory();
  canvas.paper = "rule-2";
  history.record({ setting: { key: "paper", before: "none", after: "rule-2" } });
  canvas.page = "mint";
  history.record({ setting: { key: "page", before: "none", after: "mint" } });
  assert.ok(history.undo(canvas));
  assert.deepEqual([canvas.paper, canvas.page], ["rule-2", "none"]);
  assert.ok(history.undo(canvas));
  assert.deepEqual([canvas.paper, canvas.page], ["none", "none"]);
  assert.ok(history.redo(canvas));
  assert.ok(history.redo(canvas));
  assert.deepEqual([canvas.paper, canvas.page], ["rule-2", "mint"]);
});

// ---- tidy highlights ----

const hl = (points, width = 4) => stroke(points.map(([x, y]) => [x, y, 0.5]), "yellow", width, "highlighter");
const box = shape("rect", [100, 100], [300, 200]);

test("only rectangles, ellipses and notes are figures", () => {
  assert.deepEqual(figureOf(box), { kind: "rect", x: 100, y: 100, w: 200, h: 100 });
  assert.deepEqual(figureOf(shape("ellipse", [300, 200], [100, 100])), { kind: "ellipse", x: 100, y: 100, w: 200, h: 100 });
  assert.deepEqual(figureOf(note(10, 20)), { kind: "rect", x: 10, y: 20, w: 180, h: 60 });
  assert.equal(figureOf(shape("line", [0, 0], [50, 50])), null);
  assert.equal(figureOf(shape("rect", [5, 5], [5, 90])), null, "a flat rectangle has no inside");
  assert.equal(figureOf(stroke([[0, 0, 0.5]])), null);
});

test("a highlight that goes a little over a figure is cut to it, and the cut is saved in the stroke", () => {
  // Width 4 is drawn 16 wide, so up to 8 + the slack beyond the edge is allowed.
  const over = hl([[110, 150], [290, 150], [300 + HIGHLIGHT_SLACK + 8, 150]]);
  const [only, ...rest] = tidyStroke(over, [box]);
  assert.equal(rest.length, 0);
  assert.deepEqual(only.clip, figureOf(box));
  assert.deepEqual(only.points, over.points, "the points are kept as drawn");
  const inside = hl([[120, 150], [280, 150]]);
  assert.deepEqual(tidyStroke(inside, [box])[0].clip, figureOf(box), "a highlight inside is cut too, so its round ends stay in");
});

test("a pen line is only cut when it really goes over the edge", () => {
  const within = stroke([[120, 150, 0.5], [280, 150, 0.5]]);
  assert.deepEqual(tidyStroke(within, [box]), [within], "the very same stroke, nothing to cut");
  const over = stroke([[120, 150, 0.5], [290, 150, 0.5], [305, 150, 0.5]]);
  const [cut] = tidyStroke(over, [box]);
  assert.deepEqual(cut.clip, figureOf(box));
  assert.equal(cut.tool, "pen");
});

test("a stroke that stays away from every figure is left alone", () => {
  const beside = hl([[310, 150], [400, 150], [500, 150]]);
  assert.deepEqual(tidyStroke(beside, [box]), [beside]);
  const mostlyOut = hl([[280, 150], [310, 150], [320, 150], [330, 150]]);
  assert.deepEqual(tidyStroke(mostlyOut, [box]), [mostlyOut]);
  assert.deepEqual(tidyStroke(hl([]), [box]), [hl([])]);
});

test("a long fill that strays far at the end is split: only the stray part is left uncut", () => {
  const fill = hl([[110, 110], [290, 110], [290, 190], [110, 190], [150, 190], [220, 190], [400, 190], [420, 260]]);
  const parts = tidyStroke(fill, [box]);
  const cut = parts.filter((part) => part.clip);
  const free = parts.filter((part) => !part.clip);
  assert.equal(cut.length, 1);
  assert.equal(free.length, 1);
  // The free part starts where the line leaves the box (a point in it) and goes on to the end.
  assert.deepEqual(free[0].points.map((p) => [p[0], p[1]]), [[220, 190], [400, 190], [420, 260]]);
  assert.deepEqual(cut[0].points.at(-1).slice(0, 2), [220, 190], "the cut part ends where the free part starts");
  assert.equal(cut[0].points.length + free[0].points.length, fill.points.length + 1);
});

test("a stray in the middle gives two cut parts and a free part between them", () => {
  const s = hl([[120, 150], [290, 150], [380, 150], [290, 160], [200, 160]]);
  const parts = tidyStroke(s, [box]);
  assert.equal(parts.filter((part) => part.clip).length, 2);
  assert.equal(parts.filter((part) => !part.clip).length, 1);
});

test("splitting leaves the original stroke untouched, and the pieces do not share points", () => {
  const fill = hl([[110, 150], [200, 150], [290, 150], [400, 150], [420, 260]]);
  const before = JSON.stringify(fill);
  const parts = tidyStroke(fill, [box]);
  assert.equal(JSON.stringify(fill), before);
  parts[0].points[0][0] = -5;
  assert.equal(fill.points[0][0], 110);
  assert.notEqual(parts[0].points, parts[1].points);
});

test("the smallest figure around the stroke wins, and an ellipse is judged by its curve", () => {
  const inner = shape("rect", [150, 120], [250, 180]);
  const s = hl([[160, 150], [240, 150]]);
  assert.deepEqual(tidyStroke(s, [box, inner])[0].clip, figureOf(inner));
  const ellipse = shape("ellipse", [0, 0], [200, 100]);
  // The corner of the bounding box is outside the ellipse by far more than the allowance.
  const corner = hl([[190, 10], [195, 12], [198, 8]]);
  assert.deepEqual(tidyStroke(corner, [ellipse]), [corner]);
  const middle = hl([[40, 50], [160, 50]]);
  assert.deepEqual(tidyStroke(middle, [ellipse])[0].clip, figureOf(ellipse));
});

test("a long stroke is judged from a sample and stays quick", () => {
  const points = Array.from({ length: 5000 }, (_, i) => [110 + (i % 180), 150]);
  const long = hl(points);
  const started = Date.now();
  for (let i = 0; i < 200; i++) assert.deepEqual(tidyStroke(long, [box])[0].clip, figureOf(box));
  assert.ok(Date.now() - started < 1000);
});

// ---- 0.4.7: saved cuts, grouped undo, recolour ----

test("a cut is saved as format 4 and read back; a drawing without cuts keeps its old format", () => {
  const cut = tidyStroke(hl([[110, 150], [290, 150], [305, 150]]), [box])[0];
  const text = serializeCanvas({ items: [box, cut], paper: "none", page: "none" });
  assert.match(text, /^\{"format":4,/);
  const back = parseCanvas(text);
  assert.deepEqual(back.canvas.items[1].clip, figureOf(box));
  assert.match(serializeCanvas({ items: [box, hl([[1, 1]])], paper: "none", page: "none" }), /^\{"format":2,/);
  assert.match(serializeCanvas({ items: [hl([[1, 1]])], paper: "rule-1", page: "none" }), /^\{"format":3,/);
});

test("a bad cut, or a cut in a file that is too old for it, makes the drawing read-only", () => {
  const line = (clip, format) => `{"format":${format},"items":[{"tool":"highlighter","color":"yellow","width":4,"points":[[1,1,0.5]],"clip":${JSON.stringify(clip)}}]}`;
  assert.equal(parseCanvas(line({ kind: "rect", x: 0, y: 0, w: 10, h: 10 }, 4)).canvas.items[0].clip.w, 10);
  for (const bad of [{ kind: "star", x: 0, y: 0, w: 1, h: 1 }, { kind: "rect", x: 0, y: 0, w: 0, h: 1 }, { kind: "rect", x: "0", y: 0, w: 1, h: 1 }, null, [], { kind: "rect", x: 9e9, y: 0, w: 1, h: 1 }]) {
    assert.equal(parseCanvas(line(bad, 4)).problem, "broken", JSON.stringify(bad));
  }
  assert.equal(parseCanvas(line({ kind: "rect", x: 0, y: 0, w: 10, h: 10 }, 3)).problem, "broken");
  assert.equal(parseCanvas('{"format":5,"items":[]}').problem, "newer");
});

test("moving a cut stroke moves its cut with it", () => {
  const cut = tidyStroke(hl([[110, 150], [290, 150]]), [box])[0];
  moveItem(cut, 10, -20);
  assert.deepEqual(cut.clip, { kind: "rect", x: 110, y: 80, w: 200, h: 100 });
  assert.deepEqual(cut.points[0].slice(0, 2), [120, 130]);
});

test("a stroke split into pieces goes in and out with one undo and one redo", () => {
  const canvas = emptyCanvas();
  const history = new DrawingHistory();
  const parts = tidyStroke(hl([[110, 150], [200, 150], [290, 150], [400, 150], [420, 260]]), [box]);
  canvas.items.push(...parts);
  history.record({ add: parts });
  assert.equal(canvas.items.length, 2);
  history.undo(canvas);
  assert.equal(canvas.items.length, 0);
  history.redo(canvas);
  assert.equal(canvas.items.length, 2);
});

test("several recolours in one step undo and redo together", () => {
  const canvas = emptyCanvas();
  const a = hl([[1, 1]]);
  const b = shape("rect", [0, 0], [50, 50]);
  canvas.items.push(a, b);
  const history = new DrawingHistory();
  const edits = [a, b].map((item) => ({ item, before: { color: item.color }, after: { color: "red" } }));
  for (const edit of edits) Object.assign(edit.item, edit.after);
  history.record({ edit: edits });
  history.undo(canvas);
  assert.deepEqual([a.color, b.color], ["yellow", b.color === "red" ? "ink" : b.color]);
  history.redo(canvas);
  assert.deepEqual([a.color, b.color], ["red", "red"]);
});
