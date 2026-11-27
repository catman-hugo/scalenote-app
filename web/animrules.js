// Rules for animations (0.7.0): a box on the page's canvas with steps that are shown one after
// another. The file format is in canvasrules.js (format 7); this module holds what is done with an
// animation, without the screen, so the tests can call it directly.
//
// Every change returns new lists instead of changing a list in place. The undo history keeps the
// lists from before a change (DrawingHistory, `animations`), and they must stay as they were.

import { FRAME_LIMITS, ANIMATION_LIMITS, boundsOf, makeFrameId, moveItem } from "./canvasrules.js";

/** The size a new animation's box gets (the owner's example fits in it). */
export const NEW_BOX = { w: 600, h: 340 };

const copyItem = (item) => structuredClone(item);
const emptyStep = (id) => ({ id, title: "", text: "", items: [] });

/** The ids in use in a drawing, for frames and animations (they share the blocks' id space). */
export function takenIds(canvas) {
  return [...(canvas.frames || []).map((f) => f.id), ...(canvas.animations || []).map((a) => a.id)];
}

/**
 * A new animation with one empty step, below everything already on the sheet so it starts on
 * empty paper. `random(n)` gives n random bytes (for the ids).
 */
export function newAnimation(canvas, random) {
  const around = boundsOf([
    ...canvas.items,
    ...[...(canvas.frames || []), ...(canvas.animations || [])].map((f) => ({ tool: "note", x: f.x, y: f.y, w: f.w, h: f.h, color: "ink", text: "" })),
  ]);
  const id = makeFrameId(takenIds(canvas), random);
  return {
    id,
    x: around ? Math.round(around.minX) : 0,
    y: around ? Math.round(around.maxY + 40) : 0,
    ...NEW_BOX,
    label: "",
    background: [],
    steps: [emptyStep(makeFrameId([id], random))],
  };
}

/** A step id that is not used in this animation yet. */
function stepId(animation, random) {
  return makeFrameId(animation.steps.map((step) => step.id), random);
}

/** Whether one more step fits the limit of the file. */
export const canAddStep = (animation) => animation.steps.length < ANIMATION_LIMITS.steps;

/**
 * The steps after putting a copy of step `index` right after it ("copy to the next step and erase
 * what is not needed"). The copy has its own items and the same caption. Null when it would not fit.
 */
export function duplicateStep(animation, index, random) {
  const source = animation.steps[index];
  if (!source || !canAddStep(animation)) return null;
  const copy = { id: stepId(animation, random), title: source.title, text: source.text, items: source.items.map(copyItem) };
  return [...animation.steps.slice(0, index + 1), copy, ...animation.steps.slice(index + 1)];
}

/** The steps after putting an empty step right after step `index`. Null when it would not fit. */
export function addStep(animation, index, random) {
  if (!canAddStep(animation) || index < -1 || index >= animation.steps.length) return null;
  return [...animation.steps.slice(0, index + 1), emptyStep(stepId(animation, random)), ...animation.steps.slice(index + 1)];
}

/** The steps after moving step `index` one place left (-1) or right (1). Null when it cannot move. */
export function moveStep(animation, index, direction) {
  const to = index + direction;
  if (!animation.steps[index] || to < 0 || to >= animation.steps.length) return null;
  const steps = [...animation.steps];
  [steps[index], steps[to]] = [steps[to], steps[index]];
  return steps;
}

/** The steps after moving step `from` to place `to` (dragging in the strip of steps). */
export function placeStep(animation, from, to) {
  if (!animation.steps[from] || to < 0 || to >= animation.steps.length || from === to) return null;
  const steps = [...animation.steps];
  const [step] = steps.splice(from, 1);
  steps.splice(to, 0, step);
  return steps;
}

/** The steps after removing step `index`. An animation keeps at least one step: null for the last. */
export function deleteStep(animation, index) {
  if (!animation.steps[index] || animation.steps.length === 1) return null;
  return animation.steps.filter((_, i) => i !== index);
}

/** The steps after changing the caption of step `index` (cut to the limits of the file). */
export function captionStep(animation, index, title, text) {
  const step = animation.steps[index];
  if (!step) return null;
  const next = { ...step, title: String(title).slice(0, ANIMATION_LIMITS.title), text: String(text).slice(0, ANIMATION_LIMITS.text) };
  return animation.steps.map((one, i) => (i === index ? next : one));
}

// ---- between the box and the sheet ----
// Items are stored relative to the box's corner; on the canvas they are drawn and edited in sheet
// space. These two turn copies of items from one into the other.

/** Copies of `items` (stored relative to the box) at their place on the sheet. */
export function onSheet(items, box) {
  return items.map((item) => {
    const copy = copyItem(item);
    moveItem(copy, box.x, box.y);
    return copy;
  });
}

/** Copies of `items` (on the sheet) relative to the box, for storing. */
export function inBox(items, box) {
  return items.map((item) => {
    const copy = copyItem(item);
    moveItem(copy, -box.x, -box.y);
    return copy;
  });
}

/** What step `index` shows, on the sheet: the background first, then the step's own items. */
export function stepOnSheet(animation, index) {
  const step = animation.steps[Math.max(0, Math.min(index, animation.steps.length - 1))];
  return [...onSheet(animation.background, animation), ...onSheet(step ? step.items : [], animation)];
}

/** Whether a sheet point is inside the box. */
export function insideBox(animation, x, y) {
  return x >= animation.x && x <= animation.x + animation.w && y >= animation.y && y <= animation.y + animation.h;
}

/** The step to show after `index` when going `direction` (-1 or 1), staying within the steps. */
export function stepAfter(animation, index, direction) {
  return Math.max(0, Math.min(animation.steps.length - 1, index + direction));
}

/** The box sizes a resize may give, the same as for a frame. */
export const BOX_LIMITS = { min: FRAME_LIMITS.min, max: FRAME_LIMITS.max };

/**
 * The fields of an animation after its box becomes `rect` ({x, y, w, h}). Items are stored
 * relative to the box's corner, so when a resize moves the corner, every item is shifted back by
 * the same amount: the drawing stays where it was on the sheet. A plain move keeps the items as
 * they are, so they move with the box.
 */
export function resizedBox(animation, rect, moveWithBox = false) {
  const dx = moveWithBox ? 0 : animation.x - rect.x;
  const dy = moveWithBox ? 0 : animation.y - rect.y;
  const shift = (items) =>
    dx === 0 && dy === 0
      ? items
      : items.map((item) => {
          const copy = copyItem(item);
          moveItem(copy, dx, dy);
          return copy;
        });
  return {
    x: rect.x,
    y: rect.y,
    w: rect.w,
    h: rect.h,
    background: shift(animation.background),
    steps: animation.steps.map((step) => (dx === 0 && dy === 0 ? step : { ...step, items: shift(step.items) })),
  };
}
