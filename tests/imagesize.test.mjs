import test from "node:test";
import assert from "node:assert/strict";
import { resizeBy, keyDelta, HANDLES, MIN_SIDE, MAX_SIDE } from "../web/imagesize.js";

const natural = { width: 400, height: 200, explicitHeight: false };

test("there are eight handles", () => {
  assert.equal(new Set(HANDLES).size, 8);
});

test("a corner keeps the proportions and writes only the width when the file has no height", () => {
  // Dragging the bottom right corner 100 px right grows the picture by 200 px (both sides move).
  assert.deepEqual(resizeBy("se", natural, 100, 0, 5000), { width: 600, height: null });
  // Dragging mostly down is followed instead: 100 px down on a 200 px tall picture is a 1.5 factor.
  assert.deepEqual(resizeBy("se", natural, 10, 100, 5000), { width: 600, height: null });
  // The top left corner mirrors it.
  assert.deepEqual(resizeBy("nw", natural, -100, 0, 5000), { width: 600, height: null });
  assert.deepEqual(resizeBy("nw", natural, 0, -100, 5000), { width: 600, height: null });
});

test("a corner scales both sides of a stretched picture by the same factor", () => {
  const stretched = { width: 300, height: 100, explicitHeight: true };
  assert.deepEqual(resizeBy("ne", stretched, 75, 0, 5000), { width: 450, height: 150 });
});

test("an edge changes one side and writes both sizes", () => {
  assert.deepEqual(resizeBy("e", natural, 50, 99, 5000), { width: 500, height: 200 });
  assert.deepEqual(resizeBy("w", natural, -50, 99, 5000), { width: 500, height: 200 });
  assert.deepEqual(resizeBy("s", natural, 99, 40, 5000), { width: 400, height: 240 });
  assert.deepEqual(resizeBy("n", natural, 99, -40, 5000), { width: 400, height: 240 });
});

test("a picture never gets smaller than 50 px, wider than the page, or beyond the limit", () => {
  assert.equal(resizeBy("e", natural, -5000, 0, 5000).width, MIN_SIDE);
  assert.equal(resizeBy("s", natural, 0, -5000, 5000).height, MIN_SIDE);
  assert.equal(resizeBy("e", natural, 5000, 0, 700).width, 700);
  assert.equal(resizeBy("s", natural, 0, 99999, 700).height, MAX_SIDE);
  // A corner keeps both sides at 50 or more: 400x200 shrinks to 100x50, not 50x25.
  assert.deepEqual(resizeBy("se", natural, -5000, -5000, 5000), { width: 100, height: null });
  const tall = { width: 100, height: 400, explicitHeight: false };
  assert.deepEqual(resizeBy("se", tall, -5000, -5000, 5000), { width: 50, height: null });
  // A page narrower than 50 px cannot make the answer smaller than the minimum.
  assert.equal(resizeBy("e", natural, 0, 0, 10).width, MIN_SIDE);
});

test("odd numbers never produce NaN or sizes outside the limits", () => {
  for (const handle of HANDLES) {
    for (const [dx, dy] of [[0, 0], [NaN, 0], [Infinity, -Infinity], [1e9, 1e9], [-1e9, -1e9]]) {
      const out = resizeBy(handle, natural, dx, dy, 800);
      for (const side of [out.width, out.height]) {
        if (side === null) continue;
        assert.ok(Number.isInteger(side) && side >= MIN_SIDE && side <= MAX_SIDE, `${handle} ${dx} ${dy} gave ${side}`);
      }
    }
  }
});

test("arrow keys move a handle by 10 px and other keys do nothing", () => {
  assert.deepEqual(keyDelta("ArrowLeft"), [-10, 0]);
  assert.deepEqual(keyDelta("ArrowDown"), [0, 10]);
  assert.equal(keyDelta("a"), null);
});
