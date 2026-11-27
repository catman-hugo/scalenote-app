// The animation block in the markdown (0.7.0): a fenced block that names an animation in the page's
// drawing and says how the text shows it.
//
//     ```scalenote-animation
//     id: k3j9x2ab
//     show: steps
//     fps: 2
//     ```
//
// Obsidian and other editors show it as a plain code block, which loses nothing. The drawing itself
// lives in the page's drawing file; the block only holds the id and the display choices, so the same
// animation can be shown as steps in one place and as a loop in another.
//
// Lines this version does not know (a "key: value" a later version may add) are kept as they were,
// in their order, after the known ones. Anything that does not look like this block at all, or a
// known line with a value this version cannot use, leaves the whole fence an ordinary code block,
// so nothing in it is ever changed or lost.

export const SHOWS = ["steps", "video", "loop"];
export const SPEEDS = [1, 2, 4, 8, 12, 24];
export const FPS_LIMITS = { min: 0.5, max: 30 };
export const DEFAULT_FPS = 2;
const MAX_LINES = 20;
const ID = /^[a-z0-9]{6,16}$/;
const LINE = /^([a-z][a-z0-9-]{0,30}): ?([^\n]{0,200})$/;

/** Whether `value` is a speed this version can use: 0.5 to 30 steps a second, up to two decimals. */
export function validFps(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= FPS_LIMITS.min && value <= FPS_LIMITS.max && Math.round(value * 100) === value * 100;
}

/** A speed typed by a person ("1,5", " 3 "), or null when it is not one this version can use. */
export function parseFps(text) {
  const cleaned = String(text).trim().replace(",", ".");
  if (!/^\d{1,2}(\.\d{1,2})?$/.test(cleaned)) return null;
  const value = Number(cleaned);
  return validFps(value) ? value : null;
}

/** The text of a speed in the file: "2", "1.5", "0.75". */
const fpsText = (value) => String(Number(value.toFixed(2)));

/**
 * Reads a whole fence (from its opening to its closing line, `\n` line ends). Returns the block's
 * attributes `{ id, show, fps, rest }` or null when it is not an animation block this version can
 * read. `rest` is the unknown lines, joined with `\n`.
 */
export function readAnimationFence(src) {
  const lines = String(src).split("\n");
  if (lines.length < 3 || lines[0] !== "```scalenote-animation" || lines[lines.length - 1] !== "```") return null;
  const inner = lines.slice(1, -1);
  if (inner.length > MAX_LINES) return null;
  const seen = new Set();
  let id = null;
  let show = "steps";
  let fps = DEFAULT_FPS;
  const rest = [];
  for (const line of inner) {
    const match = LINE.exec(line);
    if (!match) return null;
    const [, key, value] = match;
    if (key === "id" || key === "show" || key === "fps") {
      // A known line twice is not something this version wrote: left as a code block.
      if (seen.has(key)) return null;
      seen.add(key);
    }
    if (key === "id") {
      if (!ID.test(value)) return null;
      id = value;
    } else if (key === "show") {
      if (!SHOWS.includes(value)) return null;
      show = value;
    } else if (key === "fps") {
      const parsed = /^\d{1,2}(\.\d{1,2})?$/.test(value) ? Number(value) : NaN;
      if (!validFps(parsed)) return null;
      fps = parsed;
    } else {
      rest.push(line);
    }
  }
  if (!id) return null;
  return { id, show, fps, rest: rest.join("\n") };
}

/** Writes the block: the known lines first, then the lines this version did not know. */
export function writeAnimationFence(attrs) {
  const a = attrs || {};
  const lines = ["```scalenote-animation", `id: ${a.id || ""}`, `show: ${SHOWS.includes(a.show) ? a.show : "steps"}`, `fps: ${fpsText(validFps(a.fps) ? a.fps : DEFAULT_FPS)}`];
  if (a.rest) lines.push(...String(a.rest).split("\n"));
  lines.push("```");
  return lines.join("\n");
}
