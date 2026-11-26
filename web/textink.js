// Ink drawn over the text of a page: which block of the text a stroke belongs to, and how its
// points are stored so they stay on the same words when the window is wider or narrower.
// No page or screen code in here, so the tests can load it on their own.
//
// Why blocks and fractions: the text re-flows when the width changes, so a pixel position on the
// page would drift off the words. A stroke is instead tied to the block (paragraph, heading, list,
// table, ...) it was drawn on, and each point is stored as a share of that block's width and
// height. The block is found again by its place in the page and a short fingerprint of its text.
// If the text is edited so the fingerprint no longer matches anywhere, the stroke is not drawn
// but it is NOT deleted: it comes back if the words come back, and nothing is lost silently.

// How much of a block's text goes into its fingerprint. Enough to tell blocks apart, short enough
// that typing at the end of a long paragraph does not detach its ink.
export const TAG_LENGTH = 40;

/** A short fingerprint of a block: its kind and the first words of its text. */
export function blockTag(kind, text) {
  const clean = String(text).replace(/\s+/g, " ").trim().slice(0, TAG_LENGTH);
  return `${kind}:${clean}`;
}

/**
 * The index of the block an anchor belongs to now, or -1 when none matches. `tags` are the
 * fingerprints of the blocks of the page as it is. The block at the remembered place wins; when
 * blocks were added or removed above it, the nearest block with the same fingerprint is used.
 *
 * `fixed[i]` is true for a block whose fingerprint is its file name or id instead of its words (a
 * PDF, a canvas region; see `inkText` in inklayer.js). Ink drawn on such a block before 0.6.7 has
 * an older fingerprint made of whatever the block showed at that moment, so when nothing matches
 * exactly, a fixed block of the same kind at the remembered place takes the ink.
 */
export function findBlock(tags, anchor, fixed = []) {
  if (tags[anchor.block] === anchor.tag) return anchor.block;
  let best = -1;
  for (let i = 0; i < tags.length; i++) {
    if (tags[i] !== anchor.tag) continue;
    if (best < 0 || Math.abs(i - anchor.block) < Math.abs(best - anchor.block)) best = i;
  }
  if (best < 0 && fixed[anchor.block] && kindOfTag(tags[anchor.block]) === kindOfTag(anchor.tag)) return anchor.block;
  return best;
}

// The kind part of a fingerprint ("figure" of "figure:attachments/a.pdf").
const kindOfTag = (tag) => String(tag).split(":", 1)[0];

/**
 * The block a stroke that starts at height `y` belongs to: the one that contains `y`, or the
 * nearest one when `y` is in the space between blocks. `rects` are `{ top, bottom }` in the same
 * space as `y`. Returns -1 when there are no blocks.
 */
export function blockAtY(rects, y) {
  let best = -1;
  let bestDistance = Infinity;
  rects.forEach((rect, index) => {
    const distance = y < rect.top ? rect.top - y : y > rect.bottom ? y - rect.bottom : 0;
    if (distance < bestDistance) {
      best = index;
      bestDistance = distance;
    }
  });
  return best;
}

/**
 * Cuts a stroke into the pieces that lie on each block. Every piece belongs to one block, so a long
 * stroke across a page stays on the words it was drawn over, and its points stay near their block
 * (the drawing file refuses points that are very far from the block they belong to). A piece
 * also takes the first point of the next one, so the line stays joined. Returns
 * `[{ block, points }]`; `rects` are `{ top, bottom }` in the same space as the points.
 */
export function splitByBlock(points, rects) {
  const pieces = [];
  let current = null;
  for (const point of points) {
    const block = blockAtY(rects, point[1]);
    if (block < 0) return [];
    if (!current || current.block !== block) {
      if (current) current.points.push(point);
      current = { block, points: [point] };
      pieces.push(current);
    } else {
      current.points.push(point);
    }
  }
  return pieces;
}

// How far outside its block a point may be, in block sizes. The drawing file refuses more than
// 300. A limit of 20 flattened strokes drawn in the empty space below the last block into a
// horizontal line, so it is set high enough for a whole screen below a one-line block.
export const FRACTION_LIMIT = 299;
const keep = (value) => Math.max(-FRACTION_LIMIT, Math.min(FRACTION_LIMIT, value));

// A block that is empty or has no height would divide by nothing.
const span = (value) => Math.max(1, value);

/** A point on the screen as fractions of a block: `rect` is `{ left, top, width, height }`. */
export function toFractions(x, y, rect) {
  return [(x - rect.left) / span(rect.width), (y - rect.top) / span(rect.height)];
}

/** The inverse of `toFractions`. */
export function fromFractions(fx, fy, rect) {
  return [rect.left + fx * span(rect.width), rect.top + fy * span(rect.height)];
}

// Ink keeps its shape and its size next to the text (0.5.7). The same paragraph is wider and has
// fewer lines on a computer than on a tablet, and until 0.5.7 the width and the height of the
// block were scaled separately, which stretched handwriting sideways and squashed it. Ink now
// also stores the block's size and text size when it was drawn (`size`: [width, height, text
// size], CSS pixels) and keeps its distance from the block's top left corner, grown or shrunk
// only with the text size (a bigger font setting or zoom on a phone). Text does not get bigger
// when a page is wider, so ink does not either; a word written on a tablet looks the same on a
// computer. Where the text wraps differently the ink cannot follow every word, in neither way.
// Ink from before has no size and is drawn as before.
const tenth = (value) => Math.round(value * 10) / 10;

/**
 * Turns a stroke drawn in screen positions into stroke ink: `points` are `[x, y, pressure]` on
 * the screen, `rect` is the block the first point is in (`{ left, top, width, height, em }`,
 * em being its text size), `anchor` says which block that is.
 */
export function inkFromScreen(stroke, rect, anchor) {
  return {
    tool: stroke.tool,
    color: stroke.color,
    width: stroke.width,
    anchor: { block: anchor.block, tag: anchor.tag },
    size: [tenth(span(rect.width)), tenth(span(rect.height)), tenth(rect.em || 16)],
    points: stroke.points.map(([x, y, pressure]) => [...toFractions(x, y, rect).map(keep), pressure]),
  };
}

/** The screen positions `[x, y, pressure]` of a piece of ink, for the block it is on now. */
export function inkToScreen(item, rect) {
  if (!item.size) return item.points.map(([fx, fy, pressure]) => [...fromFractions(fx, fy, rect), pressure]);
  const [drawnWidth, drawnHeight, drawnEm] = item.size;
  const scale = (rect.em || drawnEm) / drawnEm;
  return item.points.map(([fx, fy, pressure]) => [rect.left + fx * drawnWidth * scale, rect.top + fy * drawnHeight * scale, pressure]);
}

function distanceToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const lengthSquared = dx * dx + dy * dy;
  const t = lengthSquared === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lengthSquared));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/** Whether a circle at (x, y) with `radius` touches a line through `points` (screen positions). */
export function lineTouched(points, x, y, radius) {
  if (points.length === 1) return Math.hypot(x - points[0][0], y - points[0][1]) <= radius;
  for (let i = 1; i < points.length; i++) {
    if (distanceToSegment(x, y, points[i - 1][0], points[i - 1][1], points[i][0], points[i][1]) <= radius) return true;
  }
  return false;
}
