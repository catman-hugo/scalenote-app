// The step bar (0.7.0): the controls for the steps of an animation while it is edited on the
// canvas. It sits under the animation's box; on a narrow window it is fixed at the bottom of the
// canvas, so it stays in reach while zoomed in on a detail.
//
// Every change goes through `actions` (canvasview.js), which keeps it for Undo. The rules for
// the steps themselves are in animrules.js.
import { addStep, captionStep, deleteStep, duplicateStep, moveStep, placeStep } from "./animrules.js";
import { paintStep } from "./animblock.js";
import { icon } from "./icons.js";
import { strings } from "./strings.js";

// A sideways swipe on the bar changes the step once it has gone this far, and further sideways than
// up or down (the same rule as in the text, plan section "On a phone or tablet").
const SWIPE = 40;
// Below this window width (a phone) the bar is fixed at the bottom of the canvas instead of under
// the box, and shows one line.
const NARROW = 640;
// The pictures in the strip of steps.
const THUMB_WIDTH = 96;

function make(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function button(label, iconName, onClick, className = "") {
  const b = make("button", `step-bar-button ${className}`.trim());
  b.type = "button";
  b.title = label;
  b.setAttribute("aria-label", label);
  if (iconName) b.append(icon(iconName));
  else b.textContent = label;
  b.addEventListener("click", onClick);
  return b;
}

/**
 * Makes the bar inside `stage` (the box around the canvas). `actions` gives the animation being
 * edited and changes it: { animation, step, layer, readOnly, page, box(), go(i), change(steps, i),
 * background(on), done(), focus() }.
 */
export function createStepBar(stage, actions) {
  const t = strings.stepBar;
  const bar = make("div", "step-bar");
  bar.setAttribute("role", "toolbar");
  bar.setAttribute("aria-label", t.label);
  bar.hidden = true;

  const prev = button(t.previous, "arrowLeft", () => actions.go(actions.step - 1));
  const count = make("button", "step-bar-count");
  count.type = "button";
  count.title = t.showAll;
  count.addEventListener("click", () => toggleStrip());
  const next = button(t.next, "arrowRight", () => actions.go(actions.step + 1));

  const random = undefined;
  const duplicate = button(t.duplicate, null, () => actions.change(duplicateStep(actions.animation, actions.step, random), actions.step + 1));
  const add = button(t.add, null, () => actions.change(addStep(actions.animation, actions.step, random), actions.step + 1));
  const left = button(t.moveLeft, null, () => actions.change(moveStep(actions.animation, actions.step, -1), actions.step - 1));
  const right = button(t.moveRight, null, () => actions.change(moveStep(actions.animation, actions.step, 1), actions.step + 1));
  const remove = button(t.remove, null, () => actions.change(deleteStep(actions.animation, actions.step), actions.step));

  // The caption of the step: kept when the field is left or Enter is pressed, as one Undo step.
  const title = make("input", "step-bar-title");
  title.type = "text";
  title.placeholder = t.titlePlaceholder;
  title.setAttribute("aria-label", t.title);
  title.maxLength = 120;
  const text = make("input", "step-bar-text");
  text.type = "text";
  text.placeholder = t.textPlaceholder;
  text.setAttribute("aria-label", t.text);
  text.maxLength = 1000;
  function keepCaption() {
    const step = actions.animation && actions.animation.steps[actions.step];
    if (!step || actions.readOnly || (step.title === title.value && step.text === text.value)) return;
    actions.change(captionStep(actions.animation, actions.step, title.value, text.value), actions.step);
  }
  for (const field of [title, text]) {
    field.addEventListener("change", keepCaption);
    field.addEventListener("keydown", (event) => {
      // Keys typed here are text, not canvas shortcuts.
      event.stopPropagation();
      if (event.key === "Enter") {
        event.preventDefault();
        keepCaption();
        actions.focus();
      }
    });
  }

  const backgroundBox = make("input");
  backgroundBox.type = "checkbox";
  backgroundBox.addEventListener("change", () => actions.background(backgroundBox.checked));
  const backgroundRow = make("label", "step-bar-switch");
  backgroundRow.append(backgroundBox, make("span", "", t.background));
  // The steps before and after, faintly (onion skin). Off at first; remembered on this device.
  const onionBox = make("input");
  onionBox.type = "checkbox";
  onionBox.addEventListener("change", () => {
    actions.onion = onionBox.checked;
  });
  const onionRow = make("label", "step-bar-switch");
  onionRow.title = t.onionHint;
  onionRow.append(onionBox, make("span", "", t.onion));

  const done = button(t.done, null, () => actions.done(), "primary");
  // On a narrow window the bar shows the moves, Duplicate and Done in one line, so most of the
  // canvas stays free; the other actions and the caption open with this button.
  const more = button(t.more, "more", () => {
    const open = !bar.classList.contains("step-bar-open");
    bar.classList.toggle("step-bar-open", open);
    more.setAttribute("aria-expanded", String(open));
    this_.place();
  }, "step-bar-more");
  more.setAttribute("aria-expanded", "false");

  const moves = make("div", "step-bar-group");
  moves.append(prev, count, next, duplicate);
  const edits = make("div", "step-bar-group step-bar-extra");
  edits.append(add, left, right, remove);
  const caption = make("div", "step-bar-group step-bar-caption step-bar-extra");
  caption.append(title, text);
  const switches = make("div", "step-bar-group step-bar-extra");
  switches.append(backgroundRow, onionRow);
  const end = make("div", "step-bar-group step-bar-end");
  end.append(more, done);
  bar.append(moves, edits, caption, switches, end);

  // ---- the strip of steps: small pictures to jump to, or to drag to another place ----
  const strip = make("div", "step-strip");
  strip.setAttribute("role", "listbox");
  strip.setAttribute("aria-label", t.strip);
  strip.hidden = true;

  function toggleStrip(show = strip.hidden) {
    strip.hidden = !show;
    count.setAttribute("aria-expanded", String(show));
    if (show) fillStrip();
  }

  function fillStrip() {
    const animation = actions.animation;
    if (!animation) return;
    strip.replaceChildren();
    animation.steps.forEach((step, index) => {
      const thumb = make("button", "step-thumb");
      thumb.type = "button";
      thumb.dataset.index = String(index);
      thumb.setAttribute("role", "option");
      thumb.setAttribute("aria-selected", String(index === actions.step));
      thumb.setAttribute("aria-label", t.stepOf.replace("{n}", String(index + 1)).replace("{total}", String(animation.steps.length)));
      const picture = make("canvas");
      paintStep(picture, actions.page, animation, index, THUMB_WIDTH);
      thumb.append(picture, make("span", "step-thumb-number", String(index + 1)));
      strip.append(thumb);
    });
  }

  // A press on a picture: a tap goes there; a press that moves sideways drags it to another place.
  let drag = null;
  strip.addEventListener("pointerdown", (event) => {
    const thumb = event.target.closest(".step-thumb");
    if (!thumb || actions.readOnly) return;
    drag = { from: Number(thumb.dataset.index), x: event.clientX, moved: false, id: event.pointerId };
    try {
      strip.setPointerCapture(event.pointerId);
    } catch {
      // The pointer may already be gone; a tap still works.
    }
  });
  strip.addEventListener("pointermove", (event) => {
    if (!drag || event.pointerId !== drag.id) return;
    if (Math.abs(event.clientX - drag.x) > 10) drag.moved = true;
  });
  strip.addEventListener("pointerup", (event) => {
    if (!drag || event.pointerId !== drag.id) return;
    const { from, moved } = drag;
    drag = null;
    const over = document.elementFromPoint(event.clientX, event.clientY);
    const target = over && over.closest ? over.closest(".step-thumb") : null;
    const to = target ? Number(target.dataset.index) : from;
    if (moved && to !== from) actions.change(placeStep(actions.animation, from, to), to);
    else if (!moved) actions.go(from);
    fillStrip();
  });
  strip.addEventListener("pointercancel", () => {
    drag = null;
  });

  // ---- a sideways swipe on the bar changes the step ----
  let swipe = null;
  bar.addEventListener("pointerdown", (event) => {
    if (event.target.closest("input")) return;
    swipe = { x: event.clientX, y: event.clientY, id: event.pointerId, done: false };
  });
  bar.addEventListener("pointermove", (event) => {
    if (!swipe || swipe.done || event.pointerId !== swipe.id) return;
    const dx = event.clientX - swipe.x;
    const dy = event.clientY - swipe.y;
    if (Math.abs(dx) >= SWIPE && Math.abs(dx) > Math.abs(dy)) {
      swipe.done = true;
      actions.go(actions.step + (dx < 0 ? 1 : -1));
    }
  });
  const endSwipe = () => {
    swipe = null;
  };
  bar.addEventListener("pointerup", endSwipe);
  bar.addEventListener("pointercancel", endSwipe);
  // A swipe that changed the step is not also a click on a button.
  bar.addEventListener(
    "click",
    (event) => {
      if (swipe && swipe.done) event.stopPropagation();
    },
    true,
  );

  stage.append(bar, strip);

  const this_ = {
    show() {
      bar.hidden = false;
      toggleStrip(false);
      this.update();
    },
    hide() {
      bar.hidden = true;
      toggleStrip(false);
    },
    /** Shows the step that is open, and which actions can be done. */
    update() {
      const animation = actions.animation;
      if (!animation || bar.hidden) return;
      bar.classList.toggle("step-bar-narrow", window.innerWidth < NARROW);
      const total = animation.steps.length;
      const step = animation.steps[actions.step];
      const drawingBackground = actions.layer === "background";
      // On a phone the count is short ("2 / 7"), so the bar fits on one line.
      const compact = bar.classList.contains("step-bar-narrow");
      count.textContent = drawingBackground ? t.backgroundShort : (compact ? t.stepShort : t.stepOf).replace("{n}", String(actions.step + 1)).replace("{total}", String(total));
      count.setAttribute("aria-label", drawingBackground ? t.backgroundShort : t.stepOf.replace("{n}", String(actions.step + 1)).replace("{total}", String(total)));
      prev.disabled = actions.step === 0 && !drawingBackground;
      next.disabled = actions.step === total - 1 && !drawingBackground;
      const locked = actions.readOnly;
      duplicate.disabled = locked || total >= 300;
      add.disabled = locked || total >= 300;
      left.disabled = locked || actions.step === 0;
      right.disabled = locked || actions.step === total - 1;
      remove.disabled = locked || total === 1;
      for (const field of [title, text]) field.disabled = locked || drawingBackground;
      if (document.activeElement !== title) title.value = step ? step.title : "";
      if (document.activeElement !== text) text.value = step ? step.text : "";
      backgroundBox.checked = drawingBackground;
      onionBox.checked = actions.onion;
      onionBox.disabled = drawingBackground;
      if (!strip.hidden) fillStrip();
      this.place();
    },
    /** Puts the bar under the box, or at the bottom of the canvas when there is no room. */
    place() {
      if (bar.hidden) return;
      const area = stage.getBoundingClientRect();
      const box = actions.box();
      // A narrow window (a phone): fixed at the bottom, one line.
      const narrow = window.innerWidth < NARROW;
      bar.classList.toggle("step-bar-narrow", narrow);
      const height = bar.offsetHeight;
      const below = box ? box.top + box.height + 8 : Infinity;
      const atBottom = narrow || !box || below + height > area.height - 8;
      bar.classList.toggle("step-bar-bottom", atBottom);
      strip.classList.toggle("step-strip-bottom", atBottom);
      if (atBottom) {
        bar.style.left = "";
        bar.style.top = "";
        // The strip of steps sits just above the bar.
        strip.style.top = "";
        strip.style.bottom = `${8 + height + 4}px`;
        return;
      }
      strip.style.bottom = "";
      bar.style.left = `${Math.max(8, Math.min(box.left, area.width - bar.offsetWidth - 8))}px`;
      bar.style.top = `${below}px`;
      strip.style.top = `${below + height + 4}px`;
    },
    /** The height the bar takes, for keeping room under the box. */
    height() {
      return bar.hidden ? 0 : bar.offsetHeight || 56;
    },
  };
  return this_;
}
