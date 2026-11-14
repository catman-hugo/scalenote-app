// The canvas block: a window in the text onto one region (a "frame") of the page's drawing.
//
// The block in the markdown only holds the frame's id. The frame (where the region is and how big)
// and everything drawn in it live in the page's drawing file, so the block never holds a drawing of
// its own: opening the whole canvas shows the same lines. A page whose frame is gone shows a calm
// message instead, and the drawing is never touched by the block.
import { Node } from "@tiptap/core";
import { createPainter, readEnv } from "./canvaspaint.js";
import { boundsOf, pageFill } from "./canvasrules.js";
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

// While a page is printed (or saved as a PDF) drawings are painted as they are on paper: black
// ink on a white sheet, whatever theme is on screen. Paper is white, and white ink would vanish.
let forPaper = false;
export function paintForPaper(on) {
  if (forPaper === on) return;
  forPaper = on;
  repaintCanvasBlocks();
}

/**
 * Paints the part of `canvas` inside `frame` onto `surface`, scaled down to fit `width` pixels
 * when the frame is wider (never scaled up). Returns the size on the page.
 */
export function paintRegion(surface, canvas, frame, width, { paper = forPaper, ratio = window.devicePixelRatio || 1 } = {}) {
  const scale = Math.min(1, width / frame.w);
  const cssWidth = Math.max(1, Math.round(frame.w * scale));
  const cssHeight = Math.max(1, Math.round(frame.h * scale));
  surface.style.width = `${cssWidth}px`;
  surface.style.height = `${cssHeight}px`;
  if (surface.width !== Math.round(cssWidth * ratio)) surface.width = Math.round(cssWidth * ratio);
  if (surface.height !== Math.round(cssHeight * ratio)) surface.height = Math.round(cssHeight * ratio);
  const ctx = surface.getContext("2d");
  const env = { wrapped: new WeakMap() };
  readEnv(env);
  if (paper) {
    env.background = "#ffffff";
    env.colours.ink = "#000000";
  }
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

// The longest side and the most pixels of the picture made for an export, so a drawing that
// spreads over a huge area becomes a smaller picture instead of using all the memory.
const PICTURE_SIDE = 4000;
const PICTURE_PIXELS = 12_000_000;
const PICTURE_MARGIN = 24;

/**
 * A picture of the sheet of a drawing (everything drawn on it, on white paper with the ink in
 * black), as a base64 PNG, or null when nothing is drawn. Ink drawn over the text of a page is
 * not part of it, because it belongs to the words, not to the sheet. Resolves to null as well
 * when the browser cannot make the picture.
 */
export async function drawingPicture(canvas) {
  const box = canvas && canvas.items.length ? boundsOf(canvas.items) : null;
  if (!box) return null;
  const frame = {
    x: Math.floor(box.minX - PICTURE_MARGIN),
    y: Math.floor(box.minY - PICTURE_MARGIN),
    w: Math.ceil(box.maxX - box.minX + 2 * PICTURE_MARGIN),
    h: Math.ceil(box.maxY - box.minY + 2 * PICTURE_MARGIN),
  };
  // Drawn at its own size, or smaller when it would be too big; never enlarged.
  const shrink = Math.min(1, PICTURE_SIDE / Math.max(frame.w, frame.h), Math.sqrt(PICTURE_PIXELS / (frame.w * frame.h)));
  const surface = document.createElement("canvas");
  try {
    paintRegion(surface, canvas, frame, frame.w * shrink, { paper: true, ratio: 1 });
    const blob = await new Promise((resolve) => surface.toBlob(resolve, "image/png"));
    if (!blob) return null;
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let text = "";
    for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(text);
  } catch {
    return null;
  } finally {
    surface.width = 0;
    surface.height = 0;
  }
}
