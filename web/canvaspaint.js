// Painting the items of a drawing (pen lines, highlights, shapes, sticky notes and the paper) onto a
// 2D canvas context. The full canvas view and the canvas block in the text both use it, so the
// same drawing looks the same in both places.
//
// `env` is read each time something is painted, so it can change between frames:
//   colours   the colour of each pen name, as the page shows it now
//   pageFill  the colour of the page
//   font      the font family for sticky notes
//   wrapped   a WeakMap used to remember how a note's text was cut into lines
import { NOTE, MARGIN_X, PEN_COLOURS, arrowHead, boxOf, drawnWidth, ellipseOutline, paperInks, paperLayout, tidyStroke, widthAt, wrapText } from "./canvasrules.js";

export const HIGHLIGHT_ALPHA = 0.35;
export const NOTE_FILL_ALPHA = 0.22;

/** Fills `env` with the colours, background and font the page shows now. */
export function readEnv(env) {
  const style = getComputedStyle(document.documentElement);
  env.colours = env.colours || {};
  for (const name of PEN_COLOURS) {
    // Ink follows the theme (black on light, white on dark); the others are fixed colours.
    env.colours[name] = style.getPropertyValue(name === "ink" ? "--text" : `--pen-${name}`).trim() || "#000";
  }
  env.background = style.getPropertyValue("--bg").trim() || "#fff";
  env.accent = style.getPropertyValue("--accent").trim() || "#06c";
  env.font = getComputedStyle(document.body).fontFamily || "sans-serif";
}

export function createPainter(ctx, env) {
  function stroke_(stroke) {
    const colour = env.colours[stroke.color] || "#000";
    const points = stroke.points;
    ctx.strokeStyle = colour;
    ctx.fillStyle = colour;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    if (stroke.tool === "highlighter") {
      // One path with one width: drawn in pieces, the see-through ends of each piece would
      // overlap and show as dark dots along the line.
      ctx.save();
      ctx.globalAlpha = HIGHLIGHT_ALPHA;
      ctx.lineWidth = drawnWidth(stroke);
      ctx.beginPath();
      ctx.moveTo(points[0][0], points[0][1]);
      if (points.length === 1) ctx.lineTo(points[0][0], points[0][1]);
      for (let i = 1; i < points.length; i++) ctx.lineTo(points[i][0], points[i][1]);
      ctx.stroke();
      ctx.restore();
      return;
    }
    if (points.length === 1) {
      ctx.beginPath();
      ctx.arc(points[0][0], points[0][1], widthAt(stroke.width, points[0][2]) / 2, 0, Math.PI * 2);
      ctx.fill();
      return;
    }
    // One short line per piece, because the width changes with the pressure along the way.
    for (let i = 1; i < points.length; i++) {
      ctx.lineWidth = widthAt(stroke.width, (points[i - 1][2] + points[i][2]) / 2);
      ctx.beginPath();
      ctx.moveTo(points[i - 1][0], points[i - 1][1]);
      ctx.lineTo(points[i][0], points[i][1]);
      ctx.stroke();
    }
  }

  function shape(shape) {
    ctx.strokeStyle = env.colours[shape.color] || "#000";
    ctx.lineWidth = shape.width;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    const [ax, ay] = shape.a;
    const [bx, by] = shape.b;
    ctx.beginPath();
    if (shape.kind === "rect") {
      const box = boxOf(shape.a, shape.b);
      ctx.rect(box.x, box.y, box.w, box.h);
    } else if (shape.kind === "ellipse") {
      const outline = ellipseOutline(shape.a, shape.b, 64);
      outline.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
      ctx.closePath();
    } else {
      ctx.moveTo(ax, ay);
      ctx.lineTo(bx, by);
      if (shape.kind === "arrow") {
        const head = arrowHead(shape.a, shape.b, Math.max(10, shape.width * 4));
        ctx.moveTo(head[0][0], head[0][1]);
        ctx.lineTo(bx, by);
        ctx.lineTo(head[1][0], head[1][1]);
      }
    }
    ctx.stroke();
  }

  // The lines of a note, cut to fit its width. Cached, because redrawing happens on every frame.
  function linesOf(note) {
    const cached = env.wrapped.get(note);
    if (cached && cached.text === note.text && cached.w === note.w) return cached.lines;
    ctx.font = `${NOTE.fontSize}px ${env.font}`;
    const lines = wrapText(note.text, note.w - 2 * NOTE.padding, (text) => ctx.measureText(text).width);
    env.wrapped.set(note, { text: note.text, w: note.w, lines });
    return lines;
  }

  // The box of a note (its fill and edge). The text is painted later, on top of everything else.
  function note_(note, box) {
    const colour = env.colours[note.color] || "#000";
    ctx.fillStyle = env.pageFill;
    ctx.fillRect(box.x, box.y, box.w, box.h);
    ctx.save();
    ctx.globalAlpha = NOTE_FILL_ALPHA;
    ctx.fillStyle = colour;
    ctx.fillRect(box.x, box.y, box.w, box.h);
    ctx.restore();
    ctx.strokeStyle = colour;
    ctx.lineWidth = 1.5;
    ctx.strokeRect(box.x, box.y, box.w, box.h);
  }

  function noteText(note, box) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(box.x, box.y, box.w, box.h);
    ctx.clip();
    ctx.fillStyle = env.colours.ink;
    ctx.font = `${NOTE.fontSize}px ${env.font}`;
    ctx.textBaseline = "top";
    linesOf(note).forEach((line, i) => ctx.fillText(line, box.x + NOTE.padding, box.y + NOTE.padding + i * NOTE.lineHeight));
    ctx.restore();
  }

  // A stroke with a clip (saved when it was drawn) only shows inside its figure.
  function clipped(stroke) {
    const figure = stroke.clip;
    if (!figure) return stroke_(stroke);
    ctx.save();
    ctx.beginPath();
    if (figure.kind === "rect") ctx.rect(figure.x, figure.y, figure.w, figure.h);
    else {
      ellipseOutline([figure.x, figure.y], [figure.x + figure.w, figure.y + figure.h], 64).forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
      ctx.closePath();
    }
    ctx.clip();
    stroke_(stroke);
    ctx.restore();
  }

  // The layers, back to front: sticky note boxes, highlights (also over a note), then shapes and
  // pen lines, then the text of notes. So ink and text are never hidden by a highlight.
  // `options.live` is a highlighter stroke being drawn, `noteBox(note)` gives a note's box (it can
  // be taller while it is edited) and `hideText(note)` says a note's text is shown by something else.
  function items(list, options = {}) {
    const { live = null, noteBox = (note) => note, hideText = () => false } = options;
    const notes = list.filter((item) => item.tool === "note");
    for (const note of notes) note_(note, noteBox(note));
    for (const item of list) if (item.tool === "highlighter") clipped(item);
    // The stroke being drawn is shown as it will look once the pen is lifted.
    if (live) for (const part of tidyStroke(live, list)) clipped(part);
    for (const item of list) {
      if (item.tool === "shape") shape(item);
      else if (item.tool !== "note" && item.tool !== "highlighter") clipped(item);
    }
    for (const note of notes) if (!hideText(note)) noteText(note, noteBox(note));
  }

  // The lines of the paper, in drawing space, only the part that is on the screen. Lines closer
  // together than a few pixels would only turn the sheet into a smear, so they are left out when
  // zoomed far out. A line is one screen pixel wide at any zoom.
  const MIN_PAPER_PIXELS = 6;
  function paper(name, view, screen) {
    const layout = paperLayout(name);
    const { x, y, scale } = view;
    if (!layout || layout.step * scale < MIN_PAPER_PIXELS) return;
    const left = -x / scale;
    const right = (screen.width - x) / scale;
    const top = -y / scale;
    const bottom = (screen.height - y) / scale;
    const inks = paperInks(env.pageFill);
    ctx.save();
    ctx.lineWidth = 1 / scale;
    ctx.strokeStyle = inks.line;
    ctx.beginPath();
    for (let at = Math.ceil(top / layout.step) * layout.step; at <= bottom; at += layout.step) {
      ctx.moveTo(left, at);
      ctx.lineTo(right, at);
    }
    if (layout.kind === "grid") {
      for (let at = Math.ceil(left / layout.step) * layout.step; at <= right; at += layout.step) {
        ctx.moveTo(at, top);
        ctx.lineTo(at, bottom);
      }
    }
    ctx.stroke();
    if (layout.kind === "rule" && MARGIN_X >= left && MARGIN_X <= right) {
      ctx.strokeStyle = inks.margin;
      ctx.beginPath();
      ctx.moveTo(MARGIN_X, top);
      ctx.lineTo(MARGIN_X, bottom);
      ctx.stroke();
    }
    ctx.restore();
  }


  // The outline and name of each frame (a region a canvas block in the text shows), for the full sheet.
  function frames(list, scale) {
    if (!list || !list.length) return;
    ctx.save();
    ctx.strokeStyle = env.accent;
    ctx.fillStyle = env.accent;
    ctx.lineWidth = 1.5 / scale;
    ctx.setLineDash([8 / scale, 5 / scale]);
    ctx.font = `${12 / scale}px ${env.font}`;
    ctx.textBaseline = "bottom";
    for (const frame of list) {
      ctx.strokeRect(frame.x, frame.y, frame.w, frame.h);
      if (frame.label) ctx.fillText(frame.label, frame.x, frame.y - 3 / scale);
    }
    ctx.restore();
  }

  return { frames, stroke: stroke_, shape, note: note_, noteText, clipped, items, paper };
}
