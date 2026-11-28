import test from "node:test";
import assert from "node:assert/strict";
import { ANIMATION_LIMITS, DrawingHistory, LIMITS, canAddItem, emptyCanvas, parseCanvas, serializeCanvas } from "../web/canvasrules.js";
import { addStep, captionStep, deleteStep, duplicateStep, inBox, moveStep, newAnimation, onSheet, placeStep, resizedBox, stepAfter, stepOnSheet } from "../web/animrules.js";

// Random bytes that always differ, so ids are known in the tests.
function counter() {
  let n = 0;
  return (size) => Uint8Array.from({ length: size }, (_, i) => (n++ * 7 + i) % 256);
}
const pen = (points, color = "ink") => ({ tool: "pen", color, width: 4, points });
const ANIM = {
  id: "anim0001",
  x: 100,
  y: 200,
  w: 600,
  h: 340,
  label: "SRP pathway",
  background: [pen([[10, 300, 0.5], [590, 300, 0.5]])],
  steps: [
    { id: "step0001", title: "1. Translation starts", text: "A ribosome reads the mRNA.", items: [pen([[50, 50, 0.5]], "red")] },
    { id: "step0002", title: "2. SRP binds", text: "", items: [] },
  ],
};

// ---- the file (format 7) ----

test("a drawing with an animation is written as format 7 and read back the same", () => {
  const canvas = { ...emptyCanvas(), items: [pen([[0, 0, 1]])], animations: [ANIM] };
  const text = serializeCanvas(canvas);
  assert.match(text, /^\{"format":7,/);
  assert.deepEqual(parseCanvas(text), { canvas });
  assert.equal(serializeCanvas(parseCanvas(text).canvas), text, "writing what was read changes nothing");
  // One stroke a line, so a change to one stroke is a small change in the file.
  assert.ok(text.split("\n").some((line) => line.startsWith('{"tool":"pen","color":"red"')));
});

test("an animation, frames, ink, paper and a page colour can all be in one file", () => {
  const ink = [{ tool: "pen", color: "ink", width: 4, anchor: { block: 0, tag: "paragraph:a" }, points: [[0.1, 0.2, 0.5]] }];
  const frames = [{ id: "frame001", x: 0, y: 0, w: 480, h: 320, label: "" }];
  const canvas = { ...emptyCanvas(), paper: "grid-2", page: "none", ink, frames, animations: [ANIM] };
  assert.deepEqual(parseCanvas(serializeCanvas(canvas)), { canvas });
});

test("a drawing without animations is written exactly as before (an older app keeps reading it)", () => {
  assert.equal(serializeCanvas(emptyCanvas()), '{"format":1,"strokes":[]}\n');
  const frames = [{ id: "frame001", x: 0, y: 0, w: 480, h: 320, label: "" }];
  assert.match(serializeCanvas({ ...emptyCanvas(), frames }), /^\{"format":6,/);
});

test("an older app sees format 7 as newer, so it saves nothing over the steps", () => {
  // The rule since format 6 (main.js): a "newer" drawing is shown read-only and never written.
  assert.deepEqual(parseCanvas(JSON.stringify({ format: 8, items: [] })), { problem: "newer" });
  // Animations in a file that says it is older were not written by that version: ignored.
  assert.deepEqual(parseCanvas(JSON.stringify({ format: 6, items: [], animations: [ANIM] })).canvas.animations, []);
});

test("a bad, repeated, too big or too many animations make the drawing read-only, never half read", () => {
  const file = (animations) => JSON.stringify({ format: 7, items: [], animations });
  const step = ANIM.steps[0];
  const bad = [
    { ...ANIM, id: "BAD ID" },
    { ...ANIM, w: 5 },
    { ...ANIM, label: "x".repeat(81) },
    { ...ANIM, background: "no" },
    { ...ANIM, background: [{ tool: "laser" }] },
    { ...ANIM, steps: [] },
    { ...ANIM, steps: [step, step] },
    { ...ANIM, steps: [{ ...step, id: "no!" }] },
    { ...ANIM, steps: [{ ...step, title: "x".repeat(ANIMATION_LIMITS.title + 1) }] },
    { ...ANIM, steps: [{ ...step, text: "x".repeat(ANIMATION_LIMITS.text + 1) }] },
    { ...ANIM, steps: [{ ...step, title: 5 }] },
    { ...ANIM, steps: [{ ...step, items: [pen([[1, 2]])] }] },
    { ...ANIM, steps: [{ ...step, items: [pen([[1e9, 2, 0.5]])] }] },
  ];
  for (const one of bad) assert.deepEqual(parseCanvas(file([one])), { problem: "broken" }, JSON.stringify(one).slice(0, 80));
  assert.deepEqual(parseCanvas(file([ANIM, ANIM])), { problem: "broken" }, "the same id twice");
  assert.deepEqual(parseCanvas(file("nope")), { problem: "broken" });
  const many = Array.from({ length: ANIMATION_LIMITS.count + 1 }, (_, i) => ({ ...ANIM, id: `anim${String(i).padStart(4, "0")}` }));
  assert.deepEqual(parseCanvas(file(many)), { problem: "broken" });
  const steps = Array.from({ length: ANIMATION_LIMITS.steps + 1 }, (_, i) => ({ ...step, id: `step${String(i).padStart(4, "0")}` }));
  assert.deepEqual(parseCanvas(file([{ ...ANIM, steps }])), { problem: "broken" });
  // Items in the steps count towards the limits of the whole file.
  const heavy = Array.from({ length: 300 }, (_, i) => ({ ...step, id: `step${String(i).padStart(4, "0")}`, items: [pen(Array.from({ length: 4_000 }, () => [1, 1, 0.5]))] }));
  assert.deepEqual(parseCanvas(file([{ ...ANIM, steps: heavy }])), { problem: "too-big" });
  // Unknown fields are not carried into the program.
  const extra = parseCanvas(file([{ ...ANIM, sneaky: 1, steps: [{ ...step, more: 2 }] }])).canvas.animations[0];
  assert.equal(extra.sneaky, undefined);
  assert.equal(extra.steps[0].more, undefined);
});

test("the items of animations count when checking whether one more item fits", () => {
  const steps = [{ id: "step0001", title: "", text: "", items: Array.from({ length: LIMITS.items - 1 }, () => pen([[0, 0, 1]])) }];
  const canvas = { ...emptyCanvas(), animations: [{ ...ANIM, background: [], steps }] };
  assert.equal(canAddItem(canvas), true);
  canvas.items.push(pen([[0, 0, 1]]));
  assert.equal(canAddItem(canvas), false);
});

// ---- what is done with an animation ----

test("a new animation goes below everything on the sheet, with one empty step and its own ids", () => {
  const canvas = { ...emptyCanvas(), items: [pen([[0, 0, 1], [100, 500, 1]])], frames: [{ id: "frame001", x: 0, y: 600, w: 480, h: 320, label: "" }] };
  const a = newAnimation(canvas, counter());
  // Left-aligned with the drawing (its outer edge, half a pen width left of 0) and 40 below the frame.
  assert.deepEqual({ x: a.x, y: a.y, w: a.w, h: a.h }, { x: -2, y: 960, w: 600, h: 340 });
  assert.equal(a.steps.length, 1);
  assert.deepEqual(a.background, []);
  assert.notEqual(a.id, "frame001");
  assert.match(a.id, /^[a-z0-9]{8}$/);
  // It is a valid file straight away.
  assert.ok(parseCanvas(serializeCanvas({ ...canvas, animations: [a] })).canvas);
});

test("duplicating a step puts a copy with its own items right after it", () => {
  const steps = duplicateStep(ANIM, 0, counter());
  assert.equal(steps.length, 3);
  assert.equal(steps[1].title, "1. Translation starts");
  assert.notEqual(steps[1].id, steps[0].id);
  assert.deepEqual(steps[1].items, steps[0].items);
  // Erasing in the copy leaves the original alone.
  steps[1].items[0].points[0][0] = 999;
  assert.equal(ANIM.steps[0].items[0].points[0][0], 50);
  assert.equal(ANIM.steps.length, 2, "the old list is not changed (undo keeps it)");
});

test("steps can be added, moved, placed, given a caption and removed, and an animation keeps one step", () => {
  const random = counter();
  const added = addStep(ANIM, 0, random);
  assert.deepEqual(added.map((s) => s.title), ["1. Translation starts", "", "2. SRP binds"]);
  assert.deepEqual(moveStep(ANIM, 0, 1).map((s) => s.id), ["step0002", "step0001"]);
  assert.equal(moveStep(ANIM, 0, -1), null);
  assert.equal(moveStep(ANIM, 1, 1), null);
  const three = { ...ANIM, steps: added };
  assert.deepEqual(placeStep(three, 2, 0).map((s) => s.title), ["2. SRP binds", "1. Translation starts", ""]);
  assert.deepEqual(deleteStep(ANIM, 0).map((s) => s.id), ["step0002"]);
  assert.equal(deleteStep({ ...ANIM, steps: [ANIM.steps[0]] }, 0), null);
  const captioned = captionStep(ANIM, 1, "2. SRP binds the signal", "x".repeat(2_000));
  assert.equal(captioned[1].title, "2. SRP binds the signal");
  assert.equal(captioned[1].text.length, ANIMATION_LIMITS.text);
  assert.equal(stepAfter(ANIM, 1, 1), 1, "no step after the last");
  assert.equal(stepAfter(ANIM, 0, -1), 0);
});

test("no step is added past the limit of the file", () => {
  const full = { ...ANIM, steps: Array.from({ length: ANIMATION_LIMITS.steps }, (_, i) => ({ ...ANIM.steps[0], id: `step${String(i).padStart(4, "0")}` })) };
  assert.equal(addStep(full, 0, counter()), null);
  assert.equal(duplicateStep(full, 0, counter()), null);
});

test("items are kept relative to the box and drawn on the sheet, background first", () => {
  const sheet = stepOnSheet(ANIM, 0);
  assert.deepEqual(sheet.map((item) => item.points[0].slice(0, 2)), [[110, 500], [150, 250]]);
  assert.deepEqual(inBox(onSheet(ANIM.steps[0].items, ANIM), ANIM), ANIM.steps[0].items);
  assert.equal(ANIM.background[0].points[0][0], 10, "the stored items are not changed");
});

test("resizing from a corner keeps every step where it was on the sheet; moving the box moves them", () => {
  const bigger = resizedBox(ANIM, { x: 50, y: 150, w: 650, h: 390 });
  const a = { ...ANIM, ...bigger };
  assert.deepEqual(stepOnSheet(a, 0).map((item) => item.points[0].slice(0, 2)), [[110, 500], [150, 250]]);
  const moved = { ...ANIM, ...resizedBox(ANIM, { x: 300, y: 200, w: 600, h: 340 }, true) };
  assert.deepEqual(stepOnSheet(moved, 0).map((item) => item.points[0].slice(0, 2)), [[310, 500], [350, 250]]);
});

test("undo and redo put a changed animation back, and an added or removed one", () => {
  const animation = structuredClone(ANIM);
  const canvas = { ...emptyCanvas(), animations: [animation] };
  const history = new DrawingHistory();
  const before = { steps: animation.steps };
  const after = { steps: duplicateStep(animation, 0, counter()) };
  Object.assign(animation, after);
  history.record({ animations: { animation, before, after } });
  assert.equal(animation.steps.length, 3);
  history.undo(canvas);
  assert.equal(animation.steps.length, 2);
  history.redo(canvas);
  assert.equal(animation.steps.length, 3);
  const added = newAnimation(canvas, counter());
  canvas.animations.push(added);
  history.record({ animationAdd: added });
  history.undo(canvas);
  assert.equal(canvas.animations.length, 1);
  history.redo(canvas);
  assert.equal(canvas.animations.length, 2);
  canvas.animations.splice(0, 1);
  history.record({ animationRemove: { index: 0, animation } });
  history.undo(canvas);
  assert.equal(canvas.animations[0], animation);
  history.redo(canvas);
  assert.deepEqual(canvas.animations, [added]);
});

test("while editing, Undo and Redo go back through drawing and step actions in the order they were made", async () => {
  const { AnimationHistory } = await import("../web/animrules.js");
  const animation = structuredClone(ANIM);
  const editing = { step: 0, layer: "step", items: onSheet(animation.steps[0].items, animation) };
  const sync = () => {
    animation.steps = animation.steps.map((one, i) => (i === editing.step ? { ...one, items: inBox(editing.items, animation) } : one));
  };
  const restored = [];
  const history = new AnimationHistory({
    take: () => ({ background: animation.background, steps: animation.steps, step: editing.step, layer: editing.layer }),
    sync,
    restore(picture) {
      animation.background = picture.background;
      animation.steps = picture.steps;
      editing.step = picture.step;
      restored.push(picture.step);
      editing.items = onSheet(animation.steps[editing.step].items, animation);
    },
  });
  // A line drawn in step 1, then the step duplicated, then the copy's items erased.
  editing.items.push({ tool: "pen", color: "ink", width: 4, points: [[300, 300, 0.5]] });
  history.record();
  animation.steps = duplicateStep(animation, 0, counter());
  editing.step = 1;
  editing.items = onSheet(animation.steps[1].items, animation);
  history.keep();
  editing.items = [];
  history.record();
  assert.deepEqual(animation.steps.map((s) => s.items.length), [2, 0, 0]);
  history.undo();
  assert.deepEqual(animation.steps.map((s) => s.items.length), [2, 2, 0], "the erased items are back in the copy");
  history.undo();
  assert.deepEqual(animation.steps.map((s) => s.items.length), [2, 0], "the copy is gone");
  history.undo();
  assert.deepEqual(animation.steps.map((s) => s.items.length), [1, 0], "the line is gone");
  assert.equal(history.canUndo, false);
  history.redo();
  history.redo();
  history.redo();
  assert.deepEqual(animation.steps.map((s) => s.items.length), [2, 0, 0]);
  assert.deepEqual(restored.slice(0, 3), [1, 0, 0], "each undo shows the step it changed");
});

test("the steps before and after are tinted copies on the sheet, and the drawing is not changed", async () => {
  const { onionSkin } = await import("../web/animrules.js");
  const three = { ...ANIM, steps: [...ANIM.steps, { id: "step0003", title: "", text: "", items: [pen([[5, 5, 0.5]], "green"), { tool: "note", color: "yellow", x: 1, y: 1, w: 180, h: 60, text: "hi" }] }] };
  const middle = onionSkin(three, 1);
  assert.deepEqual(middle.before.map((item) => [item.color, item.points[0][0]]), [["blue", 150]]);
  assert.deepEqual(middle.after.map((item) => item.color), ["orange", "yellow"], "a note keeps its own colour");
  assert.deepEqual(onionSkin(three, 0).before, [], "nothing before the first step");
  assert.deepEqual(onionSkin(three, 2).after, [], "nothing after the last");
  assert.equal(three.steps[0].items[0].color, "red", "the steps themselves keep their colours");
});
