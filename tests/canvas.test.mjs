import test from "node:test";
import assert from "node:assert/strict";
import {
  DrawingHistory, LIMITS, NOTE, arrowHead, boundsOf, canAddItem, canMove, emptyCanvas, itemTouched, itemsInLoop, itemsTouched,
  moveItem, noteHeight, parseCanvas, pointInLoop, serializeCanvas, strokeTouched, widthAt, wrapText, SHAPE_GRID, snapToGrid } from "../web/canvasrules.js";

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
  assert.deepEqual(parseCanvas(serializeCanvas(emptyCanvas())), { canvas: { items: [] } });
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
  assert.equal(parseCanvas('{"format":3,"items":[]}').problem, "newer", "a newer file is told apart, so it is not called broken");
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
  assert.equal(noteHeight(1), NOTE.minHeight, "a short note has the minimum height");
  assert.equal(noteHeight(10), 10 * NOTE.lineHeight + 2 * NOTE.padding);
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
