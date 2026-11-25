// The plain rules of PDF import: what a file may be, how big a page picture gets, what the
// pictures are called. No browser or library in here, so all of it can be tested alone.

import { findAll } from "./findrules.js";

export const PDF_LIMITS = {
  // The largest PDF file: the most sync sends in one file, so every PDF reaches the other
  // devices (the Rust side checks it too, MAX_PDF_BYTES). Above `warnBytes` the person is told
  // the file is large, but it is not refused.
  bytes: 64 * 1024 * 1024,
  warnBytes: 25 * 1024 * 1024,
  // "Pages as images" makes one picture file per page. There is no page limit (since 0.6.1):
  // above `warnPages` pages, or when the pictures will take more than `warnPictureBytes`, the
  // person is told about how much space they will take (in the notes folder and on every device
  // that syncs it) and asked first.
  warnPages: 100,
  warnPictureBytes: 100 * 1024 * 1024,
  // A page picture is drawn at 1.5 times its size on paper (as v1 did), but never with more
  // pixels than this, so a poster-sized page cannot use all the memory of a phone.
  pagePixels: 4_000_000,
  scale: 1.5,
  jpegQuality: 0.8,
  // Pages drawn at once in the scroll view are cut to this many pixels each as well.
  viewPixels: 8_000_000,
};

// How much text of a page is read for selecting and searching, so a page crammed with millions
// of tiny words (or a hostile file) cannot use all the memory.
export const TEXT_LIMITS = { itemsPerPage: 20_000, itemChars: 500, pageChars: 200_000, hits: 2_000 };

/**
 * Finds `query` in the words of each page. `pages` is a list of pages, each a list of the text
 * pieces pdf.js reports (a word, a line); returns `[{ page, piece, start, end }]` in reading
 * order, one entry per hit, never more than TEXT_LIMITS.hits. `start` and `end` are the letters
 * of the hit inside its piece, so only those are marked. Case is ignored. A hit that is split
 * over two pieces is not found; that is rare for ordinary text and keeps the marked words on
 * screen exactly the ones that were counted.
 */
export function findInPages(pages, query) {
  const hits = [];
  for (let i = 0; i < pages.length; i++) {
    const pieces = pages[i] || [];
    for (let j = 0; j < pieces.length; j++) {
      for (const hit of findAll(String(pieces[j]), query, TEXT_LIMITS.hits - hits.length)) hits.push({ page: i + 1, piece: j, start: hit.start, end: hit.end });
      if (hits.length >= TEXT_LIMITS.hits) return hits;
    }
  }
  return hits;
}

/** The file name's extension in lower case, or "". */
function extensionOf(name) {
  const dot = String(name || "").lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

/**
 * Returns null when a file may be tried, or an error code from the language file.
 * `file` only needs `name`, `type` and `size`. The Rust side checks the real content again.
 */
export function checkPdf(file) {
  const byType = String(file.type || "").toLowerCase() === "application/pdf";
  const byName = extensionOf(file.name) === "pdf";
  if (!byType && !byName) return "unsupported_type";
  if (file.size === 0) return "unsupported_type";
  if (file.size > PDF_LIMITS.bytes) return "too_large_pdf";
  return null;
}

/** True when a path written in markdown is a PDF in the vault. */
export function isPdfPath(path) {
  return /\.pdf$/i.test(String(path || ""));
}

/**
 * How much to scale a page that is `width` by `height` points so the picture has the most
 * pixels allowed. Never more than `PDF_LIMITS.scale`, and never so small that nothing is left.
 */
export function pageScale(width, height, maxPixels = PDF_LIMITS.pagePixels, wanted = PDF_LIMITS.scale) {
  if (!(width > 0) || !(height > 0)) return wanted;
  const room = Math.sqrt(maxPixels / (width * height));
  return Math.max(0.1, Math.min(wanted, room));
}

/** A name without the extension and without anything that could break a markdown link. */
export function pdfTitle(name) {
  const base = String(name || "").split(/[\\/]/).pop() || "";
  const stem = base.replace(/\.pdf$/i, "");
  const clean = stem.replace(/[\[\]|\n\r]/g, " ").replace(/\s+/g, " ").trim();
  return clean.slice(0, 80) || "PDF";
}

/** The file name suggested for a page picture, for example `Lecture-1-p07.jpg`. */
export function pageFileName(name, page, total) {
  const digits = String(total).length;
  return `${pdfTitle(name)}-p${String(page).padStart(digits, "0")}.jpg`;
}

/**
 * How many seconds are left, worked out from the pages finished so far. Null until two pages
 * are done (one page says too little: the first is often slower than the rest) and when
 * nothing is left. The pace of the finished pages is applied to the pages still to do.
 */
export function secondsLeft(done, total, elapsedMs) {
  if (!(done >= 2) || !(total > done) || !(elapsedMs > 0)) return null;
  return Math.round(((elapsedMs / done) * (total - done)) / 1000);
}

/**
 * Rounds a number of seconds for showing as an estimate: to 5 seconds under a minute, then to
 * whole minutes (half minutes would look more exact than it is).
 * Returns { minutes, seconds }, one of them 0.
 */
export function roundEstimate(seconds) {
  const rounded = Math.max(5, Math.ceil(seconds / 5) * 5);
  if (rounded < 60) return { minutes: 0, seconds: rounded };
  return { minutes: Math.max(1, Math.round(seconds / 60)), seconds: 0 };
}

/**
 * How much space `pages` page pictures will take, from the size of one sample picture given as
 * base64 text. A page picture is drawn at the same size and quality for every page of a PDF, so
 * one page from the middle (not the cover) gives a fair guess; the person is told it is a guess.
 */
export function estimatePagesBytes(sampleBase64Length, pages) {
  const sample = Math.max(0, Math.floor((Number(sampleBase64Length) || 0) * 3 / 4));
  return sample * Math.max(0, Math.floor(Number(pages) || 0));
}

/** Whether making pictures of `pages` pages that take about `bytes` should be asked first. */
export function longPdfNeedsAsking(pages, bytes) {
  return pages > PDF_LIMITS.warnPages || bytes > PDF_LIMITS.warnPictureBytes;
}

/** A size as people say it: "about 45 MB", "about 1.2 GB", at least "about 1 MB". */
export function describeSize(bytes) {
  const mb = Math.max(1, Math.round((Number(bytes) || 0) / (1024 * 1024)));
  if (mb < 1000) return `${mb} MB`;
  return `${(mb / 1024).toFixed(1)} GB`;
}

/** The narrowest a PDF shown in a page can be made, in pixels. */
export const MIN_PDF_WIDTH = 240;

/**
 * The width of a PDF in a page after its side handle was dragged `dx` pixels. The box stays in
 * the middle, so it grows by twice the distance (like a picture). `side` is 1 for the right
 * handle and -1 for the left one; `room` is the width the page has. Returns null for "as wide as
 * the page" (nothing is written then), otherwise whole pixels between MIN_PDF_WIDTH and `room`.
 */
export function pdfWidthAfter(start, dx, side, room) {
  const wanted = start + 2 * side * dx;
  if (wanted >= room - 1) return null;
  return Math.round(Math.max(MIN_PDF_WIDTH, Math.min(room, wanted)));
}
