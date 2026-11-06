// The drawing of a page: what a stroke is, how it is read from and written to the page's
// `.canvas.json` file, and the geometry the eraser needs. No page or screen code in here, so
// the tests can load it on their own.
//
// The file is untrusted text (another program or an older version may have written it), so it
// is read by one strict function. If anything in it is wrong the drawing is NOT used and NOT
// saved over: the screen shows it read-only. Dropping the bad strokes and saving would silently
// destroy them.
//
// Coordinates are in "canvas units" on an unbounded sheet, not in screen pixels, so a drawing
// looks the same at any zoom or window size. Pressure is 0 to 1.

export const FORMAT = 1;
export const PEN_COLOURS = ["ink", "red", "blue", "green", "orange", "purple"];
export const PEN_WIDTHS = [2, 4, 8];
export const LIMITS = {
  strokes: 20_000,
  pointsPerStroke: 5_000,
  totalPoints: 1_000_000,
  coordinate: 1_000_000,
};

export const emptyCanvas = () => ({ strokes: [] });

const isNumber = (value) => typeof value === "number" && Number.isFinite(value);

function validStroke(stroke) {
  if (!stroke || typeof stroke !== "object" || Array.isArray(stroke)) return false;
  if (stroke.tool !== "pen") return false;
  if (!PEN_COLOURS.includes(stroke.color)) return false;
  if (!isNumber(stroke.width) || stroke.width <= 0 || stroke.width > 100) return false;
  const points = stroke.points;
  if (!Array.isArray(points) || points.length === 0 || points.length > LIMITS.pointsPerStroke) return false;
  return points.every(
    (point) =>
      Array.isArray(point) &&
      point.length === 3 &&
      point.every(isNumber) &&
      Math.abs(point[0]) <= LIMITS.coordinate &&
      Math.abs(point[1]) <= LIMITS.coordinate &&
      point[2] >= 0 &&
      point[2] <= 1,
  );
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
  if (!data || typeof data !== "object" || Array.isArray(data)) return { problem: "broken" };
  if (data.format !== FORMAT) return { problem: data.format > FORMAT ? "newer" : "broken" };
  if (!Array.isArray(data.strokes) || data.strokes.length > LIMITS.strokes) return { problem: "too-big" };
  let total = 0;
  for (const stroke of data.strokes) {
    if (!validStroke(stroke)) return { problem: "broken" };
    total += stroke.points.length;
  }
  if (total > LIMITS.totalPoints) return { problem: "too-big" };
  return { canvas: { strokes: data.strokes.map((s) => ({ tool: "pen", color: s.color, width: s.width, points: s.points.map((p) => [p[0], p[1], p[2]]) })) } };
}

const round = (value, places) => Number(value.toFixed(places));

/** The text to write: one stroke per line, so a change to one stroke is a small change in the file. */
export function serializeCanvas(canvas) {
  const lines = canvas.strokes.map((stroke) =>
    JSON.stringify({
      tool: stroke.tool,
      color: stroke.color,
      width: stroke.width,
      points: stroke.points.map(([x, y, p]) => [round(x, 1), round(y, 1), round(p, 2)]),
    }),
  );
  return `{"format":${FORMAT},"strokes":[${lines.length ? "\n" + lines.join(",\n") + "\n" : ""}]}\n`;
}

/** The number of points in the whole drawing, to stop a drawing from growing without limit. */
export function totalPoints(canvas) {
  return canvas.strokes.reduce((sum, stroke) => sum + stroke.points.length, 0);
}

/** True when one more stroke of `points` points still fits the limits. */
export function canAddStroke(canvas, points) {
  return canvas.strokes.length < LIMITS.strokes && points <= LIMITS.pointsPerStroke && totalPoints(canvas) + points <= LIMITS.totalPoints;
}

// Distance from point (px, py) to the segment (ax, ay)-(bx, by).
function distanceToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const lengthSquared = dx * dx + dy * dy;
  const t = lengthSquared === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lengthSquared));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/** Whether the eraser circle (centre x, y, radius) touches the stroke. */
export function strokeTouched(stroke, x, y, radius) {
  const reach = radius + stroke.width / 2;
  const points = stroke.points;
  if (points.length === 1) return Math.hypot(x - points[0][0], y - points[0][1]) <= reach;
  for (let i = 1; i < points.length; i++) {
    if (distanceToSegment(x, y, points[i - 1][0], points[i - 1][1], points[i][0], points[i][1]) <= reach) return true;
  }
  return false;
}

/** The indexes of the strokes the eraser circle touches. */
export function strokesTouched(canvas, x, y, radius) {
  const hit = [];
  canvas.strokes.forEach((stroke, index) => {
    if (strokeTouched(stroke, x, y, radius)) hit.push(index);
  });
  return hit;
}

/**
 * The line width at a point: the pen's width, thinner for a light touch and thicker for a firm
 * one. A mouse reports a fixed 0.5, which gives exactly the plain width.
 */
export function widthAt(base, pressure) {
  return base * (0.4 + 1.2 * pressure) / 1;
}

/** Undo and redo for a drawing. Each entry is one whole gesture (one stroke, or one erase). */
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
    if (entry.add) canvas.strokes.splice(canvas.strokes.indexOf(entry.add), 1);
    // Strokes go back at their old places, lowest index first, so every index is right again.
    for (const { index, stroke } of [...(entry.remove || [])].sort((a, b) => a.index - b.index)) canvas.strokes.splice(index, 0, stroke);
    this.redoList.push(entry);
    return true;
  }

  redo(canvas) {
    const entry = this.redoList.pop();
    if (!entry) return false;
    if (entry.add) canvas.strokes.push(entry.add);
    for (const { stroke } of entry.remove || []) canvas.strokes.splice(canvas.strokes.indexOf(stroke), 1);
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
