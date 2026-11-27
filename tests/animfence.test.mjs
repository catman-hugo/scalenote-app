import test from "node:test";
import assert from "node:assert/strict";
import { parseFps, readAnimationFence, validFps, writeAnimationFence } from "../web/animfence.js";
import { splitBlocks } from "../web/blocks.js";

const fence = (...lines) => ["```scalenote-animation", ...lines, "```"].join("\n");

test("an animation block is read and written back exactly", () => {
  const src = fence("id: k3j9x2ab", "show: loop", "fps: 1.5");
  assert.deepEqual(readAnimationFence(src), { id: "k3j9x2ab", show: "loop", fps: 1.5, rest: "" });
  assert.equal(writeAnimationFence(readAnimationFence(src)), src);
});

test("only the id is needed; showing as steps at 2 a second is the default", () => {
  assert.deepEqual(readAnimationFence(fence("id: k3j9x2ab")), { id: "k3j9x2ab", show: "steps", fps: 2, rest: "" });
  assert.equal(writeAnimationFence({ id: "k3j9x2ab" }), fence("id: k3j9x2ab", "show: steps", "fps: 2"));
});

test("lines a later version may add are kept as they were, in their order", () => {
  const src = fence("id: k3j9x2ab", "show: video", "fps: 12", "hold-last: 3", "start: 2");
  const read = readAnimationFence(src);
  assert.equal(read.rest, "hold-last: 3\nstart: 2");
  assert.equal(writeAnimationFence(read), src);
  assert.equal(writeAnimationFence({ ...read, show: "loop" }), fence("id: k3j9x2ab", "show: loop", "fps: 12", "hold-last: 3", "start: 2"));
});

test("anything this version cannot use leaves the fence an ordinary code block", () => {
  const notOurs = [
    fence("show: steps"),
    fence("id: BAD"),
    fence("id: k3j9x2ab", "show: sideways"),
    fence("id: k3j9x2ab", "fps: 0.1"),
    fence("id: k3j9x2ab", "fps: 31"),
    fence("id: k3j9x2ab", "fps: 1.234"),
    fence("id: k3j9x2ab", "fps: two"),
    fence("id: k3j9x2ab", "id: other123"),
    fence("id: k3j9x2ab", "just some words"),
    fence("id: k3j9x2ab", ""),
    fence(...Array.from({ length: 21 }, (_, i) => (i ? `x${i}: y` : "id: k3j9x2ab"))),
    "```scalenote-animation\nid: k3j9x2ab",
    "```js\nid: k3j9x2ab\n```",
  ];
  for (const src of notOurs) assert.equal(readAnimationFence(src), null, src);
  // The note splitter agrees: only a real block becomes an animation block.
  assert.deepEqual(splitBlocks(`Before\n\n${fence("id: k3j9x2ab")}\n\nAfter\n`).blocks.map((b) => b.kind), ["paragraph", "animationblock", "paragraph"]);
  assert.deepEqual(splitBlocks(`${fence("id: BAD")}\n`).blocks.map((b) => b.kind), ["code"]);
});

test("a speed of one's own is 0.5 to 30 steps a second, with at most two decimals", () => {
  assert.equal(parseFps("3"), 3);
  assert.equal(parseFps(" 1,5 "), 1.5);
  assert.equal(parseFps("0.5"), 0.5);
  assert.equal(parseFps("30"), 30);
  for (const bad of ["0.4", "31", "1.234", "", "abc", "-2", "1e1", "Infinity"]) assert.equal(parseFps(bad), null, bad);
  assert.equal(validFps(2), true);
  assert.equal(validFps(NaN), false);
});
