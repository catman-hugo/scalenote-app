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

// Only one block is drawn in at a time; starting another (or leaving the page) ends the first.
let stopActive = null;

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
    // `drawing()` gives { canvas, readOnly } or null. `edit(host, frame)` puts a drawing view into
    // `host` for the region and gives back { destroy() }, or null when it cannot.
    return { drawing: () => null, edit: () => null };
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
    const { drawing, edit } = this.options;
    return ({ node }) => {
      let current = node;
      const dom = make("figure", "canvas-block");
      const head = make("figcaption", "canvas-block-head");
      const title = make("span", "canvas-block-title");
      const drawButton = make("button", "canvas-block-draw", strings.canvasBlock.draw);
      drawButton.type = "button";
      drawButton.setAttribute("aria-pressed", "false");
      drawButton.setAttribute("aria-label", strings.canvasBlock.drawLabel);
      head.append(title, drawButton);
      const surface = make("canvas", "canvas-block-surface");
      surface.setAttribute("role", "img");
      const editHost = make("div", "canvas-block-edit");
      editHost.hidden = true;
      const missing = make("p", "canvas-block-missing", strings.canvasBlock.missing);
      dom.append(head, surface, editHost, missing);
      editHost.addEventListener("dragstart", (event) => event.preventDefault());

      let editing = null;
      const leaveOnOutsidePress = (event) => {
        // A press on another block's head is left to that block's Draw button: ending this drawing
        // here would move the page under the finger before the click lands.
        if (dom.contains(event.target)) return;
        if (event.target.closest && event.target.closest(".canvas-block-head")) return;
        stop();
      };
      function stop() {
        if (!editing) return;
        const finished = editing;
        editing = null;
        document.removeEventListener("pointerdown", leaveOnOutsidePress, true);
        if (stopActive === stop) stopActive = null;
        finished.destroy();
        editHost.hidden = true;
        drawButton.setAttribute("aria-pressed", "false");
        view.paint();
      }
      function begin() {
        const d = drawing();
        const frame = d && d.canvas ? d.canvas.frames.find((f) => f.id === current.attrs.id) : null;
        if (!frame || editing) return;
        if (stopActive) stopActive();
        const size = paintRegion(surface, d.canvas, frame, Math.max(50, dom.clientWidth));
        editHost.style.width = `${size.width}px`;
        editHost.style.setProperty("--region-ratio", `${frame.w} / ${frame.h}`);
        editHost.hidden = false;
        editing = edit(editHost, frame);
        if (!editing) {
          editHost.hidden = true;
          return;
        }
        surface.hidden = true;
        drawButton.setAttribute("aria-pressed", "true");
        stopActive = stop;
        document.addEventListener("pointerdown", leaveOnOutsidePress, true);
      }
      drawButton.addEventListener("click", () => (editing ? stop() : begin()));

      const view = {
        paint() {
          const d = drawing();
          const frame = d && d.canvas ? d.canvas.frames.find((f) => f.id === current.attrs.id) : null;
          if (editing && !frame) stop();
          surface.hidden = !frame || Boolean(editing);
          missing.hidden = Boolean(frame);
          drawButton.hidden = !frame || Boolean(d && d.readOnly);
          title.textContent = frame && frame.label ? frame.label : strings.canvasBlock.title;
          if (!frame) return;
          surface.setAttribute("aria-label", strings.canvasBlock.surface);
          // While drawing, the live view shows the region; this picture is painted for when it ends.
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
        // The editor must not act on a press inside the drawing view or on the Draw button: it would
        // select the block and start dragging it, which cancels the pen's stroke.
        stopEvent: (event) => editHost.contains(event.target) || head.contains(event.target),
        ignoreMutation: () => true,
        destroy() {
          stop();
          views.delete(view);
          if (resize) resize.disconnect();
        },
      };
    };
  },
});
