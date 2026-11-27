// The animation block (0.7.0): shows an animation of the page's drawing in the text.
//
// Like the canvas block, the block only holds the animation's id and how to show it (animfence.js);
// the steps live in the page's drawing file, so the canvas and the text always show the same
// lines. A block whose animation is gone shows a calm message, and the block never changes the
// drawing. This slice shows the first step with its caption; the ways of showing it (steps, video,
// loop) come later.
import { Node } from "@tiptap/core";
import { paintRegion } from "./canvasblock.js";
import { stepOnSheet } from "./animrules.js";
import { strings } from "./strings.js";

function make(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

// Every block on screen, so main.js can ask them to paint again when the drawing changes.
const views = new Set();
export function repaintAnimationBlocks() {
  for (const view of views) view.paint();
}

/**
 * Paints step `index` of `animation` onto `surface`, at most `width` pixels wide: the page's paper
 * and colour, the background of every step, then the step's own items, cut to the box.
 */
export function paintStep(surface, canvas, animation, index, width, options = {}) {
  const sheet = { ...canvas, items: stepOnSheet(animation, index) };
  return paintRegion(surface, sheet, animation, width, options);
}

/** The caption of a step for the text: "Step 2 of 7" when the step has no title. */
export function stepCaption(animation, index) {
  const step = animation.steps[index];
  const t = strings.animationBlock;
  return {
    title: step && step.title ? step.title : t.stepOf.replace("{n}", String(index + 1)).replace("{total}", String(animation.steps.length)),
    text: step ? step.text : "",
  };
}

export const AnimationBlock = Node.create({
  name: "animationBlock",
  group: "block",
  atom: true,
  draggable: false,
  addOptions() {
    return { drawing: () => null, edit: () => {} };
  },
  addAttributes() {
    const keep = (value) => ({ default: value, rendered: false });
    return { id: keep(""), show: keep("steps"), fps: keep(2), rest: keep("") };
  },
  parseHTML() {
    return [{ tag: "figure[data-animation-block]" }];
  },
  renderHTML({ node }) {
    return ["figure", { "data-animation-block": "" }, node.attrs.id];
  },
  addNodeView() {
    const { drawing, edit } = this.options;
    return ({ node }) => {
      let current = node;
      const dom = make("figure", "animation-block");
      // Ink drawn beside the block is tied to its id, not to its caption (see inklayer.js).
      dom.dataset.inkText = node.attrs.id;
      const surface = make("canvas", "animation-block-surface");
      surface.setAttribute("role", "img");
      const caption = make("figcaption", "animation-block-caption");
      const title = make("strong", "animation-block-title");
      const text = make("span", "animation-block-text");
      caption.append(title, text);
      const missing = make("p", "animation-block-missing", strings.animationBlock.missing);
      dom.append(surface, caption, missing);
      // A double click (or double tap) opens the animation on the canvas, to draw its steps.
      surface.addEventListener("dblclick", () => edit(current.attrs.id));

      const view = {
        step: 0,
        paint() {
          const d = drawing();
          const animation = d && d.canvas ? (d.canvas.animations || []).find((a) => a.id === current.attrs.id) : null;
          surface.hidden = !animation;
          caption.hidden = !animation;
          missing.hidden = Boolean(animation);
          if (!animation) return;
          view.step = Math.min(view.step, animation.steps.length - 1);
          const words = stepCaption(animation, view.step);
          title.textContent = words.title;
          text.textContent = words.text;
          surface.setAttribute("aria-label", strings.animationBlock.surface.replace("{title}", words.title));
          paintStep(surface, d.canvas, animation, view.step, Math.max(50, dom.clientWidth));
        },
      };
      views.add(view);
      const resize = typeof ResizeObserver === "function" ? new ResizeObserver(() => view.paint()) : null;
      if (resize) resize.observe(dom);
      view.paint();
      return {
        dom,
        update(updated) {
          if (updated.type !== current.type) return false;
          current = updated;
          dom.dataset.inkText = updated.attrs.id;
          view.paint();
          return true;
        },
        stopEvent: () => false,
        ignoreMutation: () => true,
        destroy() {
          views.delete(view);
          if (resize) resize.disconnect();
        },
      };
    };
  },
});
