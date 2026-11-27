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
import { openContextMenu } from "./contextmenu.js";
import { SPEEDS } from "./animfence.js";
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

// A hidden window (another app in front, a phone put away) stops every animation; shown again,
// they carry on.
if (typeof document !== "undefined") {
  document.addEventListener("visibilitychange", () => {
    for (const view of views) view.schedule();
  });
}

// On paper (printing, Save as PDF) every step is shown, small, one after another, each with its
// caption: a video or a loop cannot play on paper, and a list of steps makes a study sheet.
let onPaper = false;
export function printAnimationBlocks(on) {
  onPaper = on;
  for (const view of views) view.paper();
}
// The width of one step on paper, in CSS pixels (three fit across an A4 page).
const PAPER_STEP = 210;

/**
 * The items of the block's menu: Show as (steps, video, loop), the speed for video and loop (the
 * owner's six choices and one of your own), Edit in canvas and Remove from page.
 */
export function blockMenu(attrs, { show, speed, otherSpeed, edit, remove, editable = true }) {
  const t = strings.animationBlock;
  const items = [];
  if (editable) {
    for (const name of ["steps", "video", "loop"]) items.push({ label: t.showAs[name], current: attrs.show === name, run: () => show(name) });
    if (attrs.show !== "steps") {
      for (const fps of SPEEDS) items.push({ label: fps === 1 ? t.speedOne : t.speed.replace("{n}", String(fps)), current: attrs.fps === fps, indent: 1, run: () => speed(fps) });
      const own = !SPEEDS.includes(attrs.fps);
      items.push({ label: own ? t.otherSpeedNow.replace("{n}", String(attrs.fps)) : t.otherSpeed, current: own, indent: 1, run: otherSpeed });
    }
  }
  items.push({ label: t.edit, run: edit });
  if (editable) items.push({ label: t.remove, run: remove });
  return items;
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
    return { drawing: () => null, edit: () => {}, askSpeed: async () => null };
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
    const { drawing, edit, askSpeed } = this.options;
    return ({ node, editor, getPos }) => {
      let current = node;
      const t = strings.animationBlock;
      const dom = make("figure", "animation-block");
      // The arrow keys change the step when the block has the focus.
      dom.tabIndex = 0;
      // Ink drawn beside the block is tied to its id, not to its caption (see inklayer.js).
      dom.dataset.inkText = node.attrs.id;
      const stage = make("div", "animation-block-stage");
      const surface = make("canvas", "animation-block-surface");
      surface.setAttribute("role", "img");
      const play = make("button", "animation-block-play");
      play.type = "button";
      stage.append(surface, play);
      const controls = make("div", "animation-block-controls");
      const back = make("button", "animation-block-button", t.back);
      back.type = "button";
      const dots = make("div", "animation-block-dots");
      const next = make("button", "animation-block-button", t.next);
      next.type = "button";
      controls.append(back, dots, next);
      const caption = make("figcaption", "animation-block-caption");
      const title = make("strong", "animation-block-title");
      const text = make("span", "animation-block-text");
      caption.append(title, text);
      const missing = make("p", "animation-block-missing", t.missing);
      const sheet = make("div", "animation-block-paper");
      sheet.hidden = true;
      dom.append(stage, controls, caption, missing, sheet);
      // A double click (or double tap) opens the animation on the canvas, to draw its steps.
      surface.addEventListener("dblclick", () => edit(current.attrs.id));

      const reducedMotion = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
      const view = {
        step: 0,
        animation: null,
        // Video and Loop: whether it is playing (it may be waiting while out of view).
        playing: false,
        // Loop: started by itself once, so a pause by the person is kept.
        started: false,
        timer: 0,
        // A picture of each step, made once, so playing fast stays smooth on a phone.
        pictures: null,
        visible: true,
        paint() {
          // The drawing (or the theme, or the width) may have changed: the pictures are made again.
          view.pictures = null;
          const d = drawing();
          const animation = d && d.canvas ? (d.canvas.animations || []).find((a) => a.id === current.attrs.id) : null;
          view.animation = animation;
          view.canvas = d && d.canvas;
          for (const part of [stage, controls, caption]) part.hidden = !animation;
          missing.hidden = Boolean(animation);
          if (!animation) return view.stop();
          view.step = Math.min(view.step, animation.steps.length - 1);
          view.show();
          view.schedule();
        },
        // Shows the current step: its picture, its caption, the dots and buttons.
        show() {
          const animation = view.animation;
          if (!animation) return;
          const show = current.attrs.show;
          const words = stepCaption(animation, view.step);
          title.textContent = words.title;
          text.textContent = words.text;
          surface.setAttribute("aria-label", t.surface.replace("{title}", words.title));
          const width = Math.max(50, dom.clientWidth);
          if (show === "steps") paintStep(surface, view.canvas, animation, view.step, width);
          else view.drawPicture(width);
          controls.hidden = show !== "steps";
          back.disabled = view.step === 0;
          next.disabled = view.step === animation.steps.length - 1;
          if (dots.childElementCount !== animation.steps.length) {
            dots.replaceChildren(
              ...animation.steps.map((_, i) => {
                const dot = make("button", "animation-block-dot");
                dot.type = "button";
                dot.setAttribute("aria-label", t.goTo.replace("{n}", String(i + 1)));
                dot.addEventListener("click", () => view.go(i));
                return dot;
              }),
            );
          }
          [...dots.children].forEach((dot, i) => dot.setAttribute("aria-current", String(i === view.step)));
          play.hidden = show === "steps";
          play.textContent = view.playing ? t.pause : t.play;
          play.setAttribute("aria-label", view.playing ? t.pause : t.play);
          dom.dataset.show = show;
        },
        // Video and Loop: the steps are painted once into pictures that are shown in turn.
        drawPicture(width) {
          const animation = view.animation;
          if (!view.pictures) {
            view.pictures = animation.steps.map((_, i) => {
              const picture = document.createElement("canvas");
              paintStep(picture, view.canvas, animation, i, width);
              return picture;
            });
          }
          const picture = view.pictures[view.step];
          if (!picture) return;
          surface.width = picture.width;
          surface.height = picture.height;
          surface.style.width = picture.style.width;
          surface.style.height = picture.style.height;
          surface.getContext("2d").drawImage(picture, 0, 0);
        },
        go(index) {
          const animation = view.animation;
          if (!animation) return;
          view.step = Math.max(0, Math.min(index, animation.steps.length - 1));
          view.show();
        },
        // One timer per block, and only while it is playing and can be seen.
        schedule() {
          clearTimeout(view.timer);
          view.timer = 0;
          const animation = view.animation;
          const show = current.attrs.show;
          if (!animation || show === "steps") return;
          // A loop starts by itself, unless the system asks for less motion: then it waits for play.
          if (show === "loop" && !view.started && !reducedMotion) {
            view.started = true;
            view.playing = true;
            view.show();
          }
          if (!view.playing || !view.visible || document.hidden || animation.steps.length < 2) return;
          view.timer = setTimeout(view.tick, 1000 / current.attrs.fps);
        },
        tick() {
          view.timer = 0;
          const animation = view.animation;
          if (!animation || !view.playing) return;
          if (view.step < animation.steps.length - 1) view.step += 1;
          else if (current.attrs.show === "loop") view.step = 0;
          else {
            // A video stops on its last step.
            view.playing = false;
          }
          view.show();
          view.schedule();
        },
        toggle() {
          const animation = view.animation;
          if (!animation) return;
          if (view.playing) view.playing = false;
          else {
            // After the end, a video plays again from the start.
            if (current.attrs.show === "video" && view.step === animation.steps.length - 1) view.step = 0;
            view.playing = true;
            view.started = true;
          }
          view.show();
          view.schedule();
        },
        stop() {
          clearTimeout(view.timer);
          view.timer = 0;
        },
        // Fills (or empties) the list of every step for paper.
        paper() {
          sheet.replaceChildren();
          sheet.hidden = !onPaper;
          const animation = view.animation;
          if (!onPaper || !animation) return;
          animation.steps.forEach((_, i) => {
            const item = make("figure", "animation-block-paper-step");
            const picture = make("canvas");
            paintStep(picture, view.canvas, animation, i, PAPER_STEP, { paper: true, ratio: 2 });
            const words = stepCaption(animation, i);
            const label = make("figcaption");
            label.append(make("strong", "", words.title));
            if (words.text) label.append(make("span", "", words.text));
            item.append(picture, label);
            sheet.append(item);
          });
        },
      };
      views.add(view);

      play.addEventListener("click", () => view.toggle());
      back.addEventListener("click", () => view.go(view.step - 1));
      next.addEventListener("click", () => view.go(view.step + 1));
      dom.addEventListener("keydown", (event) => {
        if (event.target !== dom || current.attrs.show !== "steps") return;
        if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
          event.preventDefault();
          view.go(view.step + (event.key === "ArrowRight" ? 1 : -1));
        }
      });

      // A sideways swipe on the drawing changes the step; it only counts once the finger has gone
      // 40 points sideways and further sideways than up or down, so scrolling the page still works.
      let swipe = null;
      surface.addEventListener("pointerdown", (event) => {
        if (event.pointerType === "mouse" || current.attrs.show !== "steps") return;
        swipe = { x: event.clientX, y: event.clientY, id: event.pointerId, done: false };
      });
      surface.addEventListener("pointermove", (event) => {
        if (!swipe || swipe.done || event.pointerId !== swipe.id) return;
        const dx = event.clientX - swipe.x;
        const dy = event.clientY - swipe.y;
        if (Math.abs(dy) > Math.abs(dx) && Math.abs(dy) > 10) swipe = null;
        else if (Math.abs(dx) >= 40) {
          swipe.done = true;
          view.go(view.step + (dx < 0 ? 1 : -1));
        }
      });
      const endSwipe = () => {
        swipe = null;
      };
      surface.addEventListener("pointerup", endSwipe);
      surface.addEventListener("pointercancel", endSwipe);

      // Right-click, or a long press on a touch screen: how to show it, the speed, edit, remove.
      const setAttrs = (attrs) => {
        const pos = typeof getPos === "function" ? getPos() : null;
        if (typeof pos !== "number" || !editor.isEditable) return;
        editor.view.dispatch(editor.state.tr.setNodeMarkup(pos, undefined, { ...current.attrs, ...attrs }));
      };
      dom.addEventListener("contextmenu", (event) => {
        event.preventDefault();
        const items = blockMenu(current.attrs, {
          show: (show) => setAttrs({ show }),
          speed: (fps) => setAttrs({ fps }),
          otherSpeed: () => askSpeed(current.attrs.fps).then((fps) => fps && setAttrs({ fps })),
          edit: () => edit(current.attrs.id),
          remove: () => {
            const pos = typeof getPos === "function" ? getPos() : null;
            if (typeof pos === "number" && editor.isEditable) editor.view.dispatch(editor.state.tr.delete(pos, pos + current.nodeSize));
          },
          editable: editor.isEditable,
        });
        openContextMenu(event.clientX, event.clientY, items, { returnFocus: dom, label: t.menu });
      });

      // Out of view (above or below the screen), it waits; back in view, it carries on.
      const seen = typeof IntersectionObserver === "function" ? new IntersectionObserver((entries) => {
        view.visible = entries.some((entry) => entry.isIntersecting);
        view.schedule();
      }) : null;
      if (seen) seen.observe(dom);
      const resize = typeof ResizeObserver === "function" ? new ResizeObserver(() => view.paint()) : null;
      if (resize) resize.observe(dom);
      view.paint();
      if (onPaper) view.paper();
      return {
        dom,
        update(updated) {
          if (updated.type !== current.type) return false;
          const changed = updated.attrs.show !== current.attrs.show;
          current = updated;
          dom.dataset.inkText = updated.attrs.id;
          if (changed) {
            view.playing = false;
            view.started = false;
          }
          view.paint();
          return true;
        },
        stopEvent: (event) => controls.contains(event.target) || play.contains(event.target),
        ignoreMutation: () => true,
        destroy() {
          views.delete(view);
          view.stop();
          if (resize) resize.disconnect();
          if (seen) seen.disconnect();
        },
      };
    };
  },
});
