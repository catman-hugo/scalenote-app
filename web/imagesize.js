// The arithmetic of resizing a picture with its eight handles. Kept apart from the editor so
// it can be tested on its own.
//
// A picture is centred in the page, so a handle on the left or right edge moves both sides
// equally: the edge you hold then stays under the pointer. Heights grow downwards from the
// top of the picture, so a handle on the top or bottom edge changes the height by the distance
// dragged (up on the top edge makes it taller, down on the bottom edge makes it taller).
// Corners scale the picture and keep its proportions, following whichever of the two
// movements is larger.

export const MIN_SIDE = 50;
export const MAX_SIDE = 10000;
export const HANDLES = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];

const clamp = (n, low, high) => Math.min(high, Math.max(low, n));

/**
 * The size after dragging `handle` by (dx, dy) pixels from a picture that was `start.width` by
 * `start.height`. `start.explicitHeight` says whether the file gave a height of its own; when
 * it did not, a corner keeps the picture at its natural proportions by writing the width alone.
 * `maxWidth` is the room the page has for the picture. Returns `{ width, height }`, `height`
 * being null when only a width is needed.
 */
export function resizeBy(handle, start, rawDx, rawDy, maxWidth) {
  // A pointer that reports no number must not turn the size into NaN.
  const dx = Number.isFinite(rawDx) ? rawDx : 0;
  const dy = Number.isFinite(rawDy) ? rawDy : 0;
  const sx = handle.includes("e") ? 1 : handle.includes("w") ? -1 : 0;
  const sy = handle.includes("s") ? 1 : handle.includes("n") ? -1 : 0;
  const w0 = Math.max(1, start.width);
  const h0 = Math.max(1, start.height);
  const widthLimit = clamp(Math.floor(maxWidth) || MAX_SIDE, MIN_SIDE, MAX_SIDE);

  if (sx !== 0 && sy !== 0) {
    const fx = (w0 + 2 * sx * dx) / w0;
    const fy = (h0 + sy * dy) / h0;
    let factor = Math.abs(fx - 1) >= Math.abs(fy - 1) ? fx : fy;
    const low = Math.max(MIN_SIDE / w0, MIN_SIDE / h0);
    const high = Math.min(widthLimit / w0, MAX_SIDE / h0);
    factor = low > high ? low : clamp(factor, low, high);
    const width = Math.round(w0 * factor);
    return { width, height: start.explicitHeight ? Math.round(h0 * factor) : null };
  }
  if (sx !== 0) return { width: Math.round(clamp(w0 + 2 * sx * dx, MIN_SIDE, widthLimit)), height: Math.round(h0) };
  return { width: Math.round(w0), height: Math.round(clamp(h0 + sy * dy, MIN_SIDE, MAX_SIDE)) };
}

/** The distance a key press moves a handle, in pixels. */
export const KEY_STEP = 10;

/** The (dx, dy) a key press stands for, or null when the key does nothing. */
export function keyDelta(key) {
  switch (key) {
    case "ArrowRight": return [KEY_STEP, 0];
    case "ArrowLeft": return [-KEY_STEP, 0];
    case "ArrowDown": return [0, KEY_STEP];
    case "ArrowUp": return [0, -KEY_STEP];
    default: return null;
  }
}
