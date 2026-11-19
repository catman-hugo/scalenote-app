// The words of an imported PDF page, kept next to its picture so the page's find bar can find
// them and mark them on the picture.
//
// When a PDF is imported as pictures, the words of each page are read once (pdf.js knows where
// every piece of text sits) and written to a small file beside the picture:
//   attachments/notes-p01.jpg  ->  attachments/notes-p01.jpg.text.json
// The note itself is not changed, so other programs (Obsidian) see the same plain picture link.
//
// File format 1: { "format": 1, "items": [[text, x, y, w, h], ...] }
// x, y, w and h are parts of the picture's width and height (0 to 1), y measured from the top,
// so a box stays on its words at any size the picture is shown.
//
// The file may come from another device, so reading it trusts nothing: wrong shapes are skipped,
// numbers are kept inside the picture, and sizes are limited.

import { findAll } from "./findrules.js";

export const FORMAT = 1;
export const TEXT_SUFFIX = ".text.json";
export const LIMITS = { items: 20_000, itemChars: 500, chars: 200_000, fileBytes: 1_000_000, hits: 2_000 };

const clamp01 = (n) => Math.min(1, Math.max(0, n));
const isNumber = (n) => typeof n === "number" && Number.isFinite(n);

/** The file that holds the words of the picture at `path`. */
export const textPathOf = (path) => `${path}${TEXT_SUFFIX}`;

/**
 * Builds the file text from pdf.js text items already turned into page boxes:
 * `items` is `[{ text, x, y, w, h }]` in page pixels, `width` and `height` the page's size.
 * Empty pieces are left out. Returns null when the page has no words (no file is written).
 */
export function encodePageText(items, width, height) {
  if (!(width > 0 && height > 0)) return null;
  const out = [];
  let chars = 0;
  for (const item of items || []) {
    const text = String(item.text || "").slice(0, LIMITS.itemChars);
    if (!text.trim()) continue;
    const round = (n) => Math.round(clamp01(n) * 10000) / 10000;
    out.push([text, round(item.x / width), round(item.y / height), round(item.w / width), round(item.h / height)]);
    chars += text.length;
    if (out.length >= LIMITS.items || chars >= LIMITS.chars) break;
  }
  return out.length ? JSON.stringify({ format: FORMAT, items: out }) : null;
}

/** Reads a file's text. Returns `[{ text, x, y, w, h }]`; anything unreadable gives `[]`. */
export function decodePageText(raw) {
  if (typeof raw !== "string" || raw.length > LIMITS.fileBytes) return [];
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return [];
  }
  // A newer format is not guessed at.
  if (!data || data.format !== FORMAT || !Array.isArray(data.items)) return [];
  const out = [];
  let chars = 0;
  for (const item of data.items) {
    if (!Array.isArray(item) || typeof item[0] !== "string" || !item.slice(1, 5).every(isNumber)) continue;
    const text = item[0].slice(0, LIMITS.itemChars);
    const x = clamp01(item[1]);
    const y = clamp01(item[2]);
    out.push({ text, x, y, w: clamp01(Math.min(item[3], 1 - x)), h: clamp01(Math.min(item[4], 1 - y)) });
    chars += text.length;
    if (out.length >= LIMITS.items || chars >= LIMITS.chars) break;
  }
  return out;
}

/**
 * Every hit of `word` in the words of a page, as boxes on the picture `{ x, y, w, h }` (parts of
 * its size), in reading order. The box covers about the letters that were typed, not the whole
 * piece: `measure(text)` gives the width of a text in any unit (the page uses the width in an
 * ordinary font); without it every letter counts as equally wide. A hit split over two pieces is
 * not found, like in a PDF shown in a page.
 */
export function hitsOnPicture(items, word, limit = LIMITS.hits, measure = (text) => text.length) {
  const hits = [];
  for (const item of items) {
    const whole = measure(item.text);
    if (!(whole > 0)) continue;
    for (const hit of findAll(item.text, word, limit - hits.length)) {
      const from = measure(item.text.slice(0, hit.start)) / whole;
      const to = measure(item.text.slice(0, hit.end)) / whole;
      hits.push({ x: item.x + item.w * from, y: item.y, w: item.w * (to - from), h: item.h });
    }
    if (hits.length >= limit) break;
  }
  return hits;
}
