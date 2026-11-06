import test from "node:test";
import assert from "node:assert/strict";
import { DrawingHistory, LIMITS, canAddStroke, emptyCanvas, parseCanvas, serializeCanvas, strokeTouched, strokesTouched, widthAt } from "../web/canvasrules.js";

const stroke = (points, color = "ink", width = 4) => ({ tool: "pen", color, width, points });

test("a drawing is written and read back exactly, apart from rounding", () => {
  const canvas = { strokes: [stroke([[1.04, 2.06, 0.5], [10, 20, 0.123]]), stroke([[0, 0, 1]], "red", 8)] };
  const text = serializeCanvas(canvas);
  assert.equal(text.split("\n").length, 5, "one stroke per line");
  const back = parseCanvas(text);
  assert.deepEqual(back.canvas.strokes[0].points, [[1, 2.1, 0.5], [10, 20, 0.12]]);
  assert.equal(back.canvas.strokes[1].color, "red");
  assert.equal(serializeCanvas(back.canvas), text, "writing what was read changes nothing");
  assert.deepEqual(parseCanvas(serializeCanvas(emptyCanvas())), { canvas: { strokes: [] } });
});

test("anything not understood is refused as a whole, never partly kept", () => {
  const bad = [
    "", "not json", "[]", "null", '{"format":1}', '{"format":1,"strokes":{}}', '{"format":2,"strokes":[]}', '{"format":0,"strokes":[]}',
    '{"format":1,"strokes":[{"tool":"pen","color":"pink","width":4,"points":[[0,0,0.5]]}]}',
    '{"format":1,"strokes":[{"tool":"pen","color":"ink","width":-1,"points":[[0,0,0.5]]}]}',
    '{"format":1,"strokes":[{"tool":"pen","color":"ink","width":4,"points":[]}]}',
    '{"format":1,"strokes":[{"tool":"pen","color":"ink","width":4,"points":[[0,0]]}]}',
    '{"format":1,"strokes":[{"tool":"pen","color":"ink","width":4,"points":[[0,0,2]]}]}',
    '{"format":1,"strokes":[{"tool":"pen","color":"ink","width":4,"points":[[1e9,0,0.5]]}]}',
    '{"format":1,"strokes":[{"tool":"pen","color":"ink","width":4,"points":[["a",0,0.5]]}]}',
    '{"format":1,"strokes":[{"tool":"laser","color":"ink","width":4,"points":[[0,0,0.5]]}]}',
    '{"format":1,"strokes":[null]}',
  ];
  for (const text of bad) assert.ok(parseCanvas(text).problem, `refused: ${text}`);
  assert.equal(parseCanvas('{"format":2,"strokes":[]}').problem, "newer", "a newer file is told apart, so it is not called broken");
  // One bad stroke among good ones refuses the whole drawing.
  const mixed = '{"format":1,"strokes":[{"tool":"pen","color":"ink","width":4,"points":[[0,0,0.5]]},{"tool":"pen","color":"x","width":4,"points":[[0,0,0.5]]}]}';
  assert.ok(parseCanvas(mixed).problem);
});

test("limits are enforced on read and when adding", () => {
  const many = { format: 1, strokes: Array.from({ length: LIMITS.strokes + 1 }, () => stroke([[0, 0, 0.5]])) };
  assert.equal(parseCanvas(JSON.stringify(many)).problem, "too-big");
  const long = { format: 1, strokes: [stroke(Array.from({ length: LIMITS.pointsPerStroke + 1 }, () => [0, 0, 0.5]))] };
  assert.ok(parseCanvas(JSON.stringify(long)).problem);
  const canvas = { strokes: [stroke([[0, 0, 0.5]])] };
  assert.equal(canAddStroke(canvas, 10), true);
  assert.equal(canAddStroke(canvas, LIMITS.pointsPerStroke + 1), false);
  assert.equal(canAddStroke({ strokes: Array.from({ length: LIMITS.strokes }, () => stroke([[0, 0, 0.5]])) }, 1), false);
});

test("hostile text does not run code or change the prototype", () => {
  const text = '{"format":1,"__proto__":{"polluted":true},"strokes":[{"tool":"pen","color":"ink","width":4,"points":[[0,0,0.5]],"__proto__":{"x":1}}]}';
  parseCanvas(text);
  assert.equal({}.polluted, undefined);
  assert.equal({}.x, undefined);
});

test("the eraser touches a stroke near a segment, a single dot, and misses a far one", () => {
  const line = stroke([[0, 0, 0.5], [100, 0, 0.5]], "ink", 4);
  assert.equal(strokeTouched(line, 50, 5, 4), true);
  assert.equal(strokeTouched(line, 50, 20, 4), false);
  assert.equal(strokeTouched(line, 150, 0, 4), false, "past the end of the segment");
  const dot = stroke([[10, 10, 0.5]]);
  assert.equal(strokeTouched(dot, 12, 10, 1), true);
  assert.equal(strokeTouched(dot, 30, 10, 1), false);
  assert.deepEqual(strokesTouched({ strokes: [line, dot] }, 10, 10, 3), [1]);
  assert.deepEqual(strokesTouched({ strokes: [line, dot] }, 10, 5, 3), [0, 1]);
});

test("the pen is thin for a light touch, plain for a mouse, thick for a firm one", () => {
  assert.ok(widthAt(4, 0.1) < widthAt(4, 0.5));
  assert.ok(widthAt(4, 0.5) < widthAt(4, 1));
  assert.ok(Math.abs(widthAt(4, 0.5) - 4) < 1.5);
  assert.ok(widthAt(4, 0) > 0);
});

test("undo and redo put strokes back where they were, including erased ones", () => {
  const a = stroke([[0, 0, 0.5]]);
  const b = stroke([[1, 1, 0.5]]);
  const c = stroke([[2, 2, 0.5]]);
  const canvas = { strokes: [a, b, c] };
  const history = new DrawingHistory();
  // Erase a and c in one gesture.
  history.record({ remove: [{ index: 0, stroke: a }, { index: 2, stroke: c }] });
  canvas.strokes.splice(2, 1);
  canvas.strokes.splice(0, 1);
  assert.deepEqual(canvas.strokes, [b]);
  assert.equal(history.undo(canvas), true);
  assert.deepEqual(canvas.strokes, [a, b, c]);
  assert.equal(history.redo(canvas), true);
  assert.deepEqual(canvas.strokes, [b]);
  // A new stroke clears what could be redone.
  history.undo(canvas);
  const d = stroke([[3, 3, 0.5]]);
  canvas.strokes.push(d);
  history.record({ add: d });
  assert.equal(history.canRedo, false);
  history.undo(canvas);
  assert.deepEqual(canvas.strokes, [a, b, c]);
  assert.equal(new DrawingHistory().undo({ strokes: [] }), false);
});

test("history is limited so a long session does not grow without end", () => {
  const history = new DrawingHistory(3);
  for (let i = 0; i < 10; i++) history.record({ add: stroke([[i, 0, 0.5]]) });
  assert.equal(history.undoList.length, 3);
});
