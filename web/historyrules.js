// The line comparison behind page history: what changed between the page now and an older
// version, in parts that can be put back one by one. No editor or page code in here, so the
// tests can load it on their own.
//
// Lines are compared exactly, line ending included, and kept with their line endings, so
// joining the lines of any result gives back exact text and a restore cannot change a byte
// that was not part of the chosen part.

import { splitBlocks, splitFrontmatter, withNoteId } from "./blocks.js";

// Comparing two long texts line by line costs (lines x lines). Above this many cells the part
// that differs is shown as one change instead, which is less detailed but never slow.
const MAX_CELLS = 4_000_000;

const splitLines = (text) => (text === "" ? [] : text.split(/(?<=\n)/));

/**
 * Cuts a page into whole blocks instead of lines, for comparing versions as the page looks: a
 * list, a table or a toggle is one piece, so it can be shown (and put back) as a whole. The
 * properties block and blank lines stay one line each. Joining the pieces gives the exact text.
 */
export function splitPageBlocks(text) {
  const { front, body } = splitFrontmatter(text);
  const { lead, blocks } = splitBlocks(body);
  const pieces = [...splitLines(front), ...splitLines(lead)];
  for (const { src, gap } of blocks) {
    // The block with the line break that ends it; any blank lines after it are pieces of their own.
    const firstBreak = gap.indexOf("\n");
    const end = firstBreak === -1 ? gap.length : firstBreak + 1;
    pieces.push(src + gap.slice(0, end), ...splitLines(gap.slice(end)));
  }
  return pieces;
}

/** How many lines a list of pieces holds. */
export function lineCount(pieces) {
  return pieces.reduce((sum, piece) => sum + Math.max(1, (piece.match(/\n/g) || []).length), 0);
}

// The lines that are in both, found by the longest-common-subsequence table. Returns a list of
// [index in a, index in b] pairs that match, in order.
function matches(a, b) {
  const rows = a.length + 1;
  const cols = b.length + 1;
  const table = new Uint32Array(rows * cols);
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      table[i * cols + j] = a[i] === b[j] ? table[(i + 1) * cols + j + 1] + 1 : Math.max(table[(i + 1) * cols + j], table[i * cols + j + 1]);
    }
  }
  const pairs = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      pairs.push([i, j]);
      i++;
      j++;
    } else if (table[(i + 1) * cols + j] >= table[i * cols + j + 1]) i++;
    else j++;
  }
  return pairs;
}

/**
 * Compares the page as it is now with an older version. Returns the parts in order:
 * `{ same: [lines] }` for lines that are in both and `{ current: [lines], version: [lines] }`
 * for a stretch that differs (either side may be empty: lines added or removed since).
 * `split` cuts a text into the pieces that are compared: lines, unless something else is given
 * (see `splitPageBlocks`). Whatever it is, its pieces must join back into the exact text.
 */
export function diffLines(currentText, versionText, split = splitLines) {
  const a = split(currentText);
  const b = split(versionText);
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  const parts = [];
  if (start > 0) parts.push({ same: a.slice(0, start) });
  if (midA.length * midB.length > MAX_CELLS) {
    parts.push({ current: midA, version: midB });
  } else {
    let i = 0;
    let j = 0;
    for (const [mi, mj] of [...matches(midA, midB), [midA.length, midB.length]]) {
      if (mi > i || mj > j) parts.push({ current: midA.slice(i, mi), version: midB.slice(j, mj) });
      if (mi < midA.length) parts.push({ same: [midA[mi]] });
      i = mi + 1;
      j = mj + 1;
    }
  }
  if (endA < a.length) parts.push({ same: a.slice(endA) });
  // Neighbouring "same" lines are one part.
  const merged = [];
  for (const part of parts) {
    const last = merged[merged.length - 1];
    if (part.same && last && last.same) last.same = last.same.concat(part.same);
    else merged.push(part);
  }
  return merged;
}

/** The number of parts that differ. */
export function countChanges(parts) {
  return parts.filter((part) => !part.same).length;
}

/**
 * The text with the chosen changed parts taken from the older version and everything else as it
 * is now. `chosen` is a set of indexes into `parts`; with every change chosen the result is
 * exactly the older version.
 */
export function applyChosen(parts, chosen) {
  return parts.map((part, index) => (part.same ? part.same : chosen.has(index) ? part.version : part.current).join("")).join("");
}

const idOf = (front) => /^id:[ \t]*(.*?)[ \t]*\r?$/m.exec(front)?.[1] ?? null;

/**
 * An older version can have a different `id:` than the page has now (or none, if it is from
 * before the page got one). The page's history is kept under its id, so a restored page keeps
 * the id it has now.
 */
export function keepPageId(restoredText, currentText) {
  const id = idOf(splitFrontmatter(currentText).front);
  if (!id) return restoredText;
  const { front, body } = splitFrontmatter(restoredText);
  const had = idOf(front);
  if (had === id) return restoredText;
  if (had === null) return withNoteId(front, id) + body;
  return front.replace(/^id:[^\r\n]*/m, `id: ${id}`) + body;
}
