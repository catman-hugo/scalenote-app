// The drawing of a page: what an item on it is, how it is read from and written to the page's
// `.canvas.json` file, and the geometry that erasing and selecting need. No page or screen code
// in here, so the tests can load it on their own.
//
// An item is one of:
//   pen / highlighter  a stroke: colour, width and a list of [x, y, pressure] points
//   shape              a line, arrow, rectangle or ellipse between two corners
//   note               a sticky note: a coloured box with some text
//
// The file is untrusted text (another program or an older version may have written it), so it
// is read by one strict function. If anything in it is wrong the drawing is NOT used and NOT
// saved over: the screen shows it read-only. Dropping the bad items and saving would silently
// destroy them.
//
// Coordinates are in "canvas units" on an unbounded sheet, not in screen pixels, so a drawing
// looks the same at any zoom or window size. Pressure is 0 to 1.
//
// File versions: format 1 (0.4.0) holds pen strokes only, under the key "strokes". Format 2 holds
// every kind of item under the key "items". A drawing with only pen strokes is still written as
// format 1, so an older ScaleNote on another device can keep opening it. Format 3 (0.4.5) is a
// format 2 drawing that also has a paper (rule or grid lines) and/or a page colour; it is only
// written when one of them is set, and an older ScaleNote shows it read-only instead of saving
// over it and losing the paper.

export const FORMAT = 3;
// The pen colours, in the order of the picker: three rows of six, six, and four. The first
// version had only ink, red, blue, green, orange and purple; those names still mean the same
// colour family, so older drawings open as before (a little brighter than they were).
export const PEN_COLOURS = [
  "yellow", "orange", "pink", "red", "indigo", "purple",
  "raspberry", "navy", "blue", "sky", "green", "lime",
  "ink", "charcoal", "grey", "silver",
];
// Five line widths, picked with a slider. The first three are the thin, medium and thick of
// 0.4.0 to 0.4.2, so older drawings land on the same stop. Any width up to 100 is still a valid
// file; a width that is not a stop is shown at the nearest one.
export const PEN_WIDTHS = [2, 4, 6, 8, 12];
export function nearestWidthStop(width) {
  let best = 0;
  PEN_WIDTHS.forEach((value, index) => {
    if (Math.abs(value - width) < Math.abs(PEN_WIDTHS[best] - width)) best = index;
  });
  return best;
}
export const SHAPES = ["line", "arrow", "rect", "ellipse"];
// A highlighter line is this many times as wide as the pen line of the same width setting.
export const HIGHLIGHT_FACTOR = 4;
export const NOTE = { width: 180, minHeight: 60, padding: 8, fontSize: 14, lineHeight: 19 };
export const LIMITS = {
  items: 20_000,
  pointsPerStroke: 5_000,
  totalPoints: 1_000_000,
  coordinate: 1_000_000,
  noteText: 2_000,
  noteMin: 20,
  noteMax: 2_000,
};

// ---- paper and page colour ----
// The paper is the lines behind the drawing: none, rule lines (with a margin line) or a grid, each
// in four spacings from tight to wide. The spacings are multiples of the shape grid, so a shape
// that snapped to the grid sits exactly on a line of it. They are in drawing space, so they zoom
// and move with the drawing. Like OneNote, the paper belongs to the page, not to the app.
export const PAPERS = ["none", "rule-1", "rule-2", "rule-3", "rule-4", "grid-1", "grid-2", "grid-3", "grid-4"];
const PAPER_STEPS = [20, 40, 60, 80];
// Where the margin line of rule lines runs, in drawing units from the left edge of the sheet.
export const MARGIN_X = 60;

/** `{ kind: "rule" | "grid", step }` for a paper, or null for none (or a name that is not a paper). */
export function paperLayout(paper) {
  const match = /^(rule|grid)-([1-4])$/.exec(paper);
  return match ? { kind: match[1], step: PAPER_STEPS[Number(match[2]) - 1] } : null;
}

// The 16 page colours, in the order of the picker (four rows of four, like OneNote's). A page
// colour is stored by name and turned into a real colour here, for the theme that is showing:
// on a light page background the tint is multiplied onto it (so a warm theme stays warm), on a
// dark one it is mixed into it, so the same page looks right in every theme and on every
// device. The tints were read from OneNote's light and dark page colours.
export const PAGE_COLOURS = [
  "none",
  "sky", "aqua", "mint", "rose",
  "periwinkle", "frost", "meadow", "blush",
  "iris", "fog", "pistachio", "sand",
  "lilac", "orchid", "cream", "peach",
];
const LIGHT_TINTS = [
  "#e8eefa", "#e6f3ee", "#e8f4e8", "#fbe8e8",
  "#e8eaf8", "#e6f4f6", "#eaf4e4", "#fceef0",
  "#eceaf8", "#f3f4f6", "#eef3e0", "#f4eae4",
  "#f4e8f4", "#f8e8f4", "#fbf6da", "#fbf0e2",
];
// How much of the dark tint replaces the theme's own dark background.
const DARK_MIX = 0.75;
const DARK_TINTS = [
  "#0b1b30", "#0b1f1e", "#0c2415", "#2b0f10",
  "#14183a", "#0a1e20", "#162010", "#2a1012",
  "#1c1838", "#14141c", "#1e1e0e", "#2a1c14",
  "#2a1030", "#2c0f34", "#221c08", "#2a1a0a",
];

function toRgb(hex) {
  const match = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(hex).trim());
  if (!match) return null;
  const full = match[1].length === 3 ? [...match[1]].map((c) => c + c).join("") : match[1];
  return [0, 2, 4].map((at) => parseInt(full.slice(at, at + 2), 16));
}
const toHex = (rgb) => "#" + rgb.map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, "0")).join("");
const isLightColour = (rgb) => (0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2]) / 255 > 0.5;

/** Whether a background colour (a "#rrggbb" string) is light. A colour that cannot be read counts as light. */
export function isLightBackground(background) {
  const rgb = toRgb(background);
  return rgb ? isLightColour(rgb) : true;
}

/** The colour of the page for a page-colour name on a theme background; the background itself for "none". */
export function pageFill(name, background) {
  const at = PAGE_COLOURS.indexOf(name);
  const base = toRgb(background);
  if (at < 1 || !base) return background;
  if (isLightColour(base)) {
    const tint = toRgb(LIGHT_TINTS[at - 1]);
    return toHex(base.map((v, i) => (v * tint[i]) / 255));
  }
  // Mixed in rather than screened: screening a dark tint onto a dark grey page made the colours
  // too bright and muddy (peach turned brown), where OneNote's dark pages stay nearly black.
  const tint = toRgb(DARK_TINTS[at - 1]);
  return toHex(base.map((v, i) => v * (1 - DARK_MIX) + tint[i] * DARK_MIX));
}

/** The colours of the paper lines and the margin line on a page of this colour. */
export function paperInks(fill) {
  return isLightBackground(fill) ? { line: "#c9e0f0", margin: "#e0605a" } : { line: "#1f4a75", margin: "#8a2a2a" };
}

export const emptyCanvas = () => ({ items: [], paper: "none", page: "none" });

const isNumber = (value) => typeof value === "number" && Number.isFinite(value);
const isObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const inRange = (value) => isNumber(value) && Math.abs(value) <= LIMITS.coordinate;
const validCorner = (corner) => Array.isArray(corner) && corner.length === 2 && corner.every(inRange);
const validWidth = (width) => isNumber(width) && width > 0 && width <= 100;

function validStroke(item, tools) {
  if (!tools.includes(item.tool) || !PEN_COLOURS.includes(item.color) || !validWidth(item.width)) return false;
  const points = item.points;
  if (!Array.isArray(points) || points.length === 0 || points.length > LIMITS.pointsPerStroke) return false;
  return points.every((point) => Array.isArray(point) && point.length === 3 && inRange(point[0]) && inRange(point[1]) && isNumber(point[2]) && point[2] >= 0 && point[2] <= 1);
}

function validShape(item) {
  return SHAPES.includes(item.kind) && PEN_COLOURS.includes(item.color) && validWidth(item.width) && validCorner(item.a) && validCorner(item.b);
}

function validNote(item) {
  const size = (value) => isNumber(value) && value >= LIMITS.noteMin && value <= LIMITS.noteMax;
  return PEN_COLOURS.includes(item.color) && inRange(item.x) && inRange(item.y) && size(item.w) && size(item.h) && typeof item.text === "string" && item.text.length <= LIMITS.noteText;
}

function validItem(item, tools) {
  if (!isObject(item)) return false;
  if (item.tool === "shape") return tools.includes("shape") && validShape(item);
  if (item.tool === "note") return tools.includes("note") && validNote(item);
  return validStroke(item, tools);
}

// Builds a clean copy that holds only the fields the format knows, so nothing else in the file
// (an unknown key, a `__proto__`) is carried into the program.
function cleanItem(item) {
  if (item.tool === "shape") return { tool: "shape", kind: item.kind, color: item.color, width: item.width, a: [...item.a], b: [...item.b] };
  if (item.tool === "note") return { tool: "note", color: item.color, x: item.x, y: item.y, w: item.w, h: item.h, text: item.text };
  return { tool: item.tool, color: item.color, width: item.width, points: item.points.map((p) => [p[0], p[1], p[2]]) };
}

/**
 * Reads the text of a `.canvas.json` file. Returns `{ canvas }` when all of it is understood, or
 * `{ problem }` (a short code) when it is not, in which case nothing may be saved over it.
 */
export function parseCanvas(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return { problem: "broken" };
  }
  if (!isObject(data)) return { problem: "broken" };
  if (!Number.isInteger(data.format) || data.format < 1) return { problem: "broken" };
  if (data.format > FORMAT) return { problem: "newer" };
  const old = data.format === 1;
  const list = old ? data.strokes : data.items;
  if (!Array.isArray(list)) return { problem: "broken" };
  if (list.length > LIMITS.items) return { problem: "too-big" };
  const tools = old ? ["pen"] : ["pen", "highlighter", "shape", "note"];
  // The paper and page colour exist from format 3 on. A value this version does not know makes
  // the whole drawing read-only, like a bad item, so it is never saved over.
  const paper = data.format >= 3 && data.paper !== undefined ? data.paper : "none";
  const page = data.format >= 3 && data.page !== undefined ? data.page : "none";
  if (!PAPERS.includes(paper) || !PAGE_COLOURS.includes(page)) return { problem: "broken" };
  let total = 0;
  for (const item of list) {
    if (!validItem(item, tools)) return { problem: "broken" };
    if (item.points) total += item.points.length;
  }
  if (total > LIMITS.totalPoints) return { problem: "too-big" };
  return { canvas: { items: list.map(cleanItem), paper, page } };
}

const round = (value, places) => Number(value.toFixed(places));
const corner = ([x, y]) => [round(x, 1), round(y, 1)];

function itemLine(item) {
  if (item.tool === "shape") return JSON.stringify({ tool: "shape", kind: item.kind, color: item.color, width: item.width, a: corner(item.a), b: corner(item.b) });
  if (item.tool === "note") return JSON.stringify({ tool: "note", color: item.color, x: round(item.x, 1), y: round(item.y, 1), w: round(item.w, 1), h: round(item.h, 1), text: item.text });
  return JSON.stringify({ tool: item.tool, color: item.color, width: item.width, points: item.points.map(([x, y, p]) => [round(x, 1), round(y, 1), round(p, 2)]) });
}

/** The text to write: one item per line, so a change to one item is a small change in the file. */
export function serializeCanvas(canvas) {
  const lines = canvas.items.map(itemLine);
  const body = lines.length ? "\n" + lines.join(",\n") + "\n" : "";
  const paper = canvas.paper && canvas.paper !== "none" ? canvas.paper : null;
  const page = canvas.page && canvas.page !== "none" ? canvas.page : null;
  if (paper || page) {
    const extra = (paper ? `,"paper":${JSON.stringify(paper)}` : "") + (page ? `,"page":${JSON.stringify(page)}` : "");
    return `{"format":${FORMAT},"items":[${body}]${extra}}\n`;
  }
  const penOnly = canvas.items.every((item) => item.tool === "pen");
  return penOnly ? `{"format":1,"strokes":[${body}]}\n` : `{"format":2,"items":[${body}]}\n`;
}

/** The number of stroke points in the whole drawing, to stop a drawing from growing without limit. */
export function totalPoints(canvas) {
  return canvas.items.reduce((sum, item) => sum + (item.points ? item.points.length : 0), 0);
}

/** True when one more item with `points` stroke points (0 for a shape or note) still fits the limits. */
export function canAddItem(canvas, points = 0) {
  return canvas.items.length < LIMITS.items && points <= LIMITS.pointsPerStroke && totalPoints(canvas) + points <= LIMITS.totalPoints;
}

// ---- geometry ----

// Distance from point (px, py) to the segment (ax, ay)-(bx, by).
function distanceToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const lengthSquared = dx * dx + dy * dy;
  const t = lengthSquared === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lengthSquared));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/** The line width a stroke is drawn with before pressure: a highlighter is a broad marker. */
export function drawnWidth(item) {
  return item.tool === "highlighter" ? item.width * HIGHLIGHT_FACTOR : item.width;
}

// ---- tidy highlights ----
// A highlighter stroke that covers a figure (a rectangle, an ellipse or a sticky note) and only
// goes a little over its edge is cut off at the edge when it is drawn. The stroke in the file is
// not changed, so moving the figure or the stroke away shows the stroke as it was drawn.
// A stroke that goes well outside is left alone, so a highlight can still be put beside a figure.

/** Extra distance, in drawing units, a highlight may go outside a figure beyond half its width. */
export const HIGHLIGHT_SLACK = 12;
const HIGHLIGHT_INSIDE = 0.6; // share of the stroke that must lie inside the figure
const HIGHLIGHT_SAMPLES = 64; // enough to judge a stroke; keeps drawing fast with long strokes

/** The figure of an item as `{kind, x, y, w, h}`, or null when it is not a closed figure. */
export function figureOf(item) {
  if (item.tool === "note") return item.w > 0 && item.h > 0 ? { kind: "rect", x: item.x, y: item.y, w: item.w, h: item.h } : null;
  if (item.tool !== "shape" || (item.kind !== "rect" && item.kind !== "ellipse")) return null;
  const { x, y, w, h } = boxOf(item.a, item.b);
  return w > 0 && h > 0 ? { kind: item.kind, x, y, w, h } : null;
}

// How far a point is outside a figure; 0 inside. For an ellipse this is an estimate that is
// close for the small distances that matter here.
function distanceOutside(figure, px, py) {
  if (figure.kind === "rect") {
    return Math.hypot(Math.max(figure.x - px, 0, px - (figure.x + figure.w)), Math.max(figure.y - py, 0, py - (figure.y + figure.h)));
  }
  const rx = figure.w / 2;
  const ry = figure.h / 2;
  const r = Math.hypot((px - figure.x - rx) / rx, (py - figure.y - ry) / ry);
  return r <= 1 ? 0 : (r - 1) * Math.min(rx, ry);
}

/**
 * The figure a highlighter stroke should be cut to, or null. `items` are all the items of the
 * drawing. When several figures fit, the smallest one wins (a box inside a box).
 */
export function highlightFigure(stroke, items) {
  const points = stroke.points;
  if (!points.length) return null;
  const step = Math.max(1, Math.ceil(points.length / HIGHLIGHT_SAMPLES));
  const allowed = drawnWidth(stroke) / 2 + HIGHLIGHT_SLACK;
  let best = null;
  for (const item of items) {
    const figure = figureOf(item);
    if (!figure) continue;
    let inside = 0;
    let total = 0;
    let farthest = 0;
    for (let i = 0; i < points.length; i += step) {
      const out = distanceOutside(figure, points[i][0], points[i][1]);
      total++;
      if (out === 0) inside++;
      if (out > farthest) farthest = out;
    }
    if (inside / total < HIGHLIGHT_INSIDE || farthest > allowed) continue;
    if (!best || figure.w * figure.h < best.w * best.h) best = figure;
  }
  return best;
}

/** The corner and size of the box between two corners, whichever way they were dragged. */
export function boxOf(a, b) {
  return { x: Math.min(a[0], b[0]), y: Math.min(a[1], b[1]), w: Math.abs(a[0] - b[0]), h: Math.abs(a[1] - b[1]) };
}

/** The outline of an ellipse in the box between two corners, as a closed list of points. */
export function ellipseOutline(a, b, steps = 48) {
  const { x, y, w, h } = boxOf(a, b);
  const points = [];
  for (let i = 0; i < steps; i++) {
    const angle = (i / steps) * Math.PI * 2;
    points.push([x + w / 2 + (w / 2) * Math.cos(angle), y + h / 2 + (h / 2) * Math.sin(angle)]);
  }
  return points;
}

// The line pieces that make up the outline of a shape, as [x1, y1, x2, y2].
function shapeSegments(item) {
  const [ax, ay] = item.a;
  const [bx, by] = item.b;
  if (item.kind === "line" || item.kind === "arrow") return [[ax, ay, bx, by]];
  if (item.kind === "rect") return [[ax, ay, bx, ay], [bx, ay, bx, by], [bx, by, ax, by], [ax, by, ax, ay]];
  const outline = ellipseOutline(item.a, item.b);
  return outline.map((point, i) => [point[0], point[1], outline[(i + 1) % outline.length][0], outline[(i + 1) % outline.length][1]]);
}

/** The two short lines that make the head of an arrow ending at `b`. */
export function arrowHead(a, b, size) {
  const angle = Math.atan2(b[1] - a[1], b[0] - a[0]);
  const spread = Math.PI / 7;
  return [angle + Math.PI - spread, angle + Math.PI + spread].map((turn) => [b[0] + size * Math.cos(turn), b[1] + size * Math.sin(turn)]);
}

/** Whether the eraser circle (centre x, y, radius) touches the stroke. */
export function strokeTouched(stroke, x, y, radius) {
  const reach = radius + drawnWidth(stroke) / 2;
  const points = stroke.points;
  if (points.length === 1) return Math.hypot(x - points[0][0], y - points[0][1]) <= reach;
  for (let i = 1; i < points.length; i++) {
    if (distanceToSegment(x, y, points[i - 1][0], points[i - 1][1], points[i][0], points[i][1]) <= reach) return true;
  }
  return false;
}

/** Whether the eraser circle touches an item of any kind. */
export function itemTouched(item, x, y, radius) {
  if (item.tool === "shape") {
    const reach = radius + item.width / 2;
    return shapeSegments(item).some(([ax, ay, bx, by]) => distanceToSegment(x, y, ax, ay, bx, by) <= reach);
  }
  if (item.tool === "note") return x >= item.x - radius && x <= item.x + item.w + radius && y >= item.y - radius && y <= item.y + item.h + radius;
  return strokeTouched(item, x, y, radius);
}

/** The indexes of the items the eraser circle touches. */
export function itemsTouched(canvas, x, y, radius) {
  const hit = [];
  canvas.items.forEach((item, index) => {
    if (itemTouched(item, x, y, radius)) hit.push(index);
  });
  return hit;
}

/** The smallest box around an item, with half the line width added. Returns { minX, minY, maxX, maxY }. */
export function itemBounds(item) {
  if (item.tool === "note") return { minX: item.x, minY: item.y, maxX: item.x + item.w, maxY: item.y + item.h };
  const half = (item.tool === "shape" ? item.width : drawnWidth(item)) / 2;
  const points = item.tool === "shape" ? [item.a, item.b] : item.points;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of points) {
    minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
  }
  return { minX: minX - half, minY: minY - half, maxX: maxX + half, maxY: maxY + half };
}

/** The box around several items. Returns null when there are none. */
export function boundsOf(items) {
  if (!items.length) return null;
  const all = items.map(itemBounds);
  return {
    minX: Math.min(...all.map((b) => b.minX)),
    minY: Math.min(...all.map((b) => b.minY)),
    maxX: Math.max(...all.map((b) => b.maxX)),
    maxY: Math.max(...all.map((b) => b.maxY)),
  };
}

// A few points that stand for an item when asking whether a loop encloses it. A long stroke is
// sampled, so selecting stays fast with thousands of points.
function samples(item) {
  if (item.tool === "note") {
    const { x, y, w, h } = item;
    return [[x, y], [x + w, y], [x, y + h], [x + w, y + h], [x + w / 2, y + h / 2]];
  }
  if (item.tool === "shape") {
    const [ax, ay] = item.a;
    const [bx, by] = item.b;
    if (item.kind === "line" || item.kind === "arrow") return [[ax, ay], [bx, by], [(ax + bx) / 2, (ay + by) / 2]];
    const { x, y, w, h } = boxOf(item.a, item.b);
    if (item.kind === "rect") return [[x, y], [x + w, y], [x, y + h], [x + w, y + h], [x + w / 2, y + h / 2]];
    return [[x + w / 2, y], [x + w, y + h / 2], [x + w / 2, y + h], [x, y + h / 2], [x + w / 2, y + h / 2]];
  }
  const step = Math.max(1, Math.ceil(item.points.length / 100));
  const picked = [];
  for (let i = 0; i < item.points.length; i += step) picked.push(item.points[i]);
  picked.push(item.points[item.points.length - 1]);
  return picked;
}

/** Whether point (x, y) lies inside the closed loop of [x, y] points. */
export function pointInLoop(x, y, loop) {
  let inside = false;
  for (let i = 0, j = loop.length - 1; i < loop.length; j = i++) {
    const [xi, yi] = loop[i];
    const [xj, yj] = loop[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/**
 * The indexes of the items a loop selects: those with at least half of their points inside it.
 * Half, not all, because a loop drawn by hand rarely encloses every last point of a line.
 */
export function itemsInLoop(canvas, loop) {
  if (loop.length < 3) return [];
  const chosen = [];
  canvas.items.forEach((item, index) => {
    const points = samples(item);
    const inside = points.filter(([x, y]) => pointInLoop(x, y, loop)).length;
    if (inside * 2 >= points.length) chosen.push(index);
  });
  return chosen;
}

/** Moves an item by (dx, dy), in place. */
export function moveItem(item, dx, dy) {
  if (item.tool === "note") {
    item.x += dx;
    item.y += dy;
  } else if (item.tool === "shape") {
    item.a = [item.a[0] + dx, item.a[1] + dy];
    item.b = [item.b[0] + dx, item.b[1] + dy];
  } else {
    for (const point of item.points) {
      point[0] += dx;
      point[1] += dy;
    }
  }
}

/** True when moving the items by (dx, dy) keeps every one of them inside the allowed coordinates. */
export function canMove(items, dx, dy) {
  const box = boundsOf(items);
  if (!box) return false;
  const limit = LIMITS.coordinate;
  return box.minX + dx >= -limit && box.maxX + dx <= limit && box.minY + dy >= -limit && box.maxY + dy <= limit;
}

/**
 * The pen's line width at a point: thinner for a light touch and thicker for a firm one. A mouse
 * reports a fixed 0.5, which gives exactly the plain width.
 */
export function widthAt(base, pressure) {
  return base * (0.4 + 1.2 * pressure);
}

/**
 * Breaks note text into lines that fit `maxWidth`. `measure(text)` gives the width of a piece of
 * text; it is passed in so this needs no screen. A new line in the text is kept; a word wider
 * than the line is cut where it no longer fits.
 */
export function wrapText(text, maxWidth, measure) {
  const lines = [];
  for (const paragraph of text.split("\n")) {
    let line = "";
    for (const word of paragraph.split(" ")) {
      const tryLine = line ? `${line} ${word}` : word;
      if (measure(tryLine) <= maxWidth) {
        line = tryLine;
        continue;
      }
      if (line) lines.push(line);
      line = "";
      let rest = word;
      while (measure(rest) > maxWidth && rest.length > 1) {
        let cut = rest.length - 1;
        while (cut > 1 && measure(rest.slice(0, cut)) > maxWidth) cut--;
        lines.push(rest.slice(0, cut));
        rest = rest.slice(cut);
      }
      line = rest;
    }
    lines.push(line);
  }
  return lines;
}

/** The height a note needs for its text: at least the minimum, plus padding around the lines. */
// The height the text itself needs. A note is never shorter than this, so no text is hidden,
// but it may be taller: its size is what the person drew or dragged it to.
export function noteTextHeight(lineCount) {
  return lineCount * NOTE.lineHeight + 2 * NOTE.padding;
}

// Takes an item out by identity. A missing item is ignored: splice(-1, 1) would remove the last one.
function removeItem(canvas, item) {
  const index = canvas.items.indexOf(item);
  if (index >= 0) canvas.items.splice(index, 1);
}

/**
 * Undo and redo for a drawing. Each entry is one whole gesture and is one of:
 *   { add: item }                          one item drawn
 *   { remove: [{ index, item }] }          items erased or deleted, with their places
 *   { move: { items, dx, dy } }            items moved
 *   { edit: { item, before, after } }      some fields of one item changed (a note's text)
 */
export class DrawingHistory {
  constructor(limit = 200) {
    this.limit = limit;
    this.undoList = [];
    this.redoList = [];
  }

  record(entry) {
    this.undoList.push(entry);
    if (this.undoList.length > this.limit) this.undoList.shift();
    this.redoList = [];
  }

  /** Reverses the last gesture on `canvas`. Returns false when there is nothing to undo. */
  undo(canvas) {
    const entry = this.undoList.pop();
    if (!entry) return false;
    if (entry.add) removeItem(canvas, entry.add);
    // Items go back at their old places, lowest index first, so every index is right again.
    for (const { index, item } of [...(entry.remove || [])].sort((a, b) => a.index - b.index)) canvas.items.splice(index, 0, item);
    if (entry.move) for (const item of entry.move.items) moveItem(item, -entry.move.dx, -entry.move.dy);
    if (entry.edit) Object.assign(entry.edit.item, entry.edit.before);
    if (entry.setting) canvas[entry.setting.key] = entry.setting.before;
    this.redoList.push(entry);
    return true;
  }

  redo(canvas) {
    const entry = this.redoList.pop();
    if (!entry) return false;
    if (entry.add) canvas.items.push(entry.add);
    for (const { item } of entry.remove || []) removeItem(canvas, item);
    if (entry.move) for (const item of entry.move.items) moveItem(item, entry.move.dx, entry.move.dy);
    if (entry.edit) Object.assign(entry.edit.item, entry.edit.after);
    if (entry.setting) canvas[entry.setting.key] = entry.setting.after;
    this.undoList.push(entry);
    return true;
  }

  get canUndo() {
    return this.undoList.length > 0;
  }

  get canRedo() {
    return this.redoList.length > 0;
  }
}

// Shapes can snap to a grid so that two shapes drawn at different times line up exactly,
// instead of one edge missing the other by a pixel. The grid is in drawing space (not screen
// pixels), so it is the same at every zoom level and in every session.
export const SHAPE_GRID = 20;
export function snapToGrid(value, step = SHAPE_GRID) {
  return Math.round(value / step) * step;
}

// Moving a selection with the loop tool snaps too. One corner of the first shape or note in the
// selection (the "anchor") is put on the grid, and everything else in the selection moves by the
// same amount, so the picture keeps its shape. Pen lines are not on the grid and just follow.
export function moveAnchor(items) {
  const item = items.find((one) => one.tool === "shape" || one.tool === "note");
  if (!item) return null;
  return item.tool === "note" ? [item.x, item.y] : [item.a[0], item.a[1]];
}

/** How far to move so that an anchor that was dragged by (dx, dy) ends up exactly on the grid. */
export function snappedShift(anchor, dx, dy, step = SHAPE_GRID) {
  return [snapToGrid(anchor[0] + dx, step) - anchor[0], snapToGrid(anchor[1] + dy, step) - anchor[1]];
}
