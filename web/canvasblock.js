// The canvas block: a window in the text onto one region (a "frame") of the page's drawing.
//
// The block in the markdown only holds the frame's id. The frame (where the region is and how big)
// and everything drawn in it live in the page's drawing file, so the block never holds a drawing of
// its own: opening the whole canvas shows the same lines. A page whose frame is gone shows a calm
// message instead, and the drawing is never touched by the block.
import { Node } from "@tiptap/core";
import { createPainter, readEnv } from "./canvaspaint.js";
import { pageFill } from "./canvasrules.js";
import { strings } from "./strings.js";

function make(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

// Every block on screen, so main.js can ask them all to paint again when the drawing is loaded,
// changed, or the theme switches.
const views = new Set();
export function repaintCanvasBlocks() {
  for (const view of views) view.paint();
}

/**
 * Paints the part of `canvas` inside `frame` onto `surface`, scaled down to fit `width` pixels
 * when the frame is wider (never scaled up). Returns the size on the page.
 */
export function paintRegion(surface, canvas, frame, width) {
  const scale = Math.min(1, width / frame.w);
  const cssWidth = Math.max(1, Math.round(frame.w * scale));
  const cssHeight = Math.max(1, Math.round(frame.h * scale));
  const ratio = window.devicePixelRatio || 1;
  surface.style.width = `${cssWidth}px`;
  surface.style.height = `${cssHeight}px`;
  if (surface.width !== Math.round(cssWidth * ratio)) surface.width = Math.round(cssWidth * ratio);
  if (surface.height !== Math.round(cssHeight * ratio)) surface.height = Math.round(cssHeight * ratio);
  const ctx = surface.getContext("2d");
  const env = { wrapped: new WeakMap() };
  readEnv(env);
  env.pageFill = pageFill(canvas.page, env.background);
  const painter = createPainter(ctx, env);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = env.pageFill;
  ctx.fillRect(0, 0, surface.width, surface.height);
  // Drawing space to pixels: the frame's corner becomes the corner of the surface.
  ctx.setTransform(ratio * scale, 0, 0, ratio * scale, -ratio * scale * frame.x, -ratio * scale * frame.y);
  ctx.beginPath();
  ctx.rect(frame.x, frame.y, frame.w, frame.h);
  ctx.clip();
  painter.paper(canvas.paper, { x: -frame.x * scale, y: -frame.y * scale, scale }, { width: cssWidth, height: cssHeight });
  painter.items(canvas.items);
  return { width: cssWidth, height: cssHeight };
}

export const CanvasBlock = Node.create({
  name: "canvasBlock",
  group: "block",
  atom: true,
  draggable: false,
  addOptions() {
    return { drawing: () => null };
  },
  addAttributes() {
    return { id: { default: "", rendered: false } };
  },
  parseHTML() {
    return [{ tag: "figure[data-canvas-block]" }];
  },
  renderHTML({ node }) {
    return ["figure", { "data-canvas-block": "" }, node.attrs.id];
  },
  addNodeView() {
    const { drawing } = this.options;
    return ({ node }) => {
      let current = node;
      const dom = make("figure", "canvas-block");
      const title = make("figcaption", "canvas-block-title");
      const surface = make("canvas", "canvas-block-surface");
      surface.setAttribute("role", "img");
      const missing = make("p", "canvas-block-missing", strings.canvasBlock.missing);
      dom.append(title, surface, missing);

      const view = {
        paint() {
          const d = drawing();
          const frame = d && d.canvas ? d.canvas.frames.find((f) => f.id === current.attrs.id) : null;
          surface.hidden = !frame;
          missing.hidden = Boolean(frame);
          title.textContent = frame && frame.label ? frame.label : strings.canvasBlock.title;
          if (!frame) return;
          surface.setAttribute("aria-label", strings.canvasBlock.surface);
          paintRegion(surface, d.canvas, frame, Math.max(50, dom.clientWidth));
        },
      };
      views.add(view);
      // The block's width changes with the window and with columns around it.
      const resize = typeof ResizeObserver === "function" ? new ResizeObserver(() => view.paint()) : null;
      if (resize) resize.observe(dom);
      view.paint();
      return {
        dom,
        update(updated) {
          if (updated.type !== current.type) return false;
          current = updated;
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
