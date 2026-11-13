// The plain rules of PDF import: what a file may be, how big a page picture gets, what the
// pictures are called. No browser or library in here, so all of it can be tested alone.

export const PDF_LIMITS = {
  // The Rust side refuses a bigger PDF too (MAX_PDF_BYTES); this only gives a friendly answer first.
  bytes: 25 * 1024 * 1024,
  // "Pages as images" makes one picture file per page, so a very long PDF is refused.
  importPages: 100,
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
 * pieces pdf.js reports (a word, a line); resolves to `[{ page, piece, offset }]` in reading
 * order, one entry per hit, never more than TEXT_LIMITS.hits. Case is ignored. A hit that is
 * split over two pieces is not found; that is rare for ordinary text and keeps the marked
 * words on screen exactly the ones that were counted.
 */
export function findInPages(pages, query) {
  const needle = String(query || "").trim().toLowerCase();
  const hits = [];
  if (!needle) return hits;
  for (let i = 0; i < pages.length; i++) {
    const pieces = pages[i] || [];
    for (let j = 0; j < pieces.length; j++) {
      const hay = String(pieces[j]).toLowerCase();
      let from = 0;
      for (;;) {
        const at = hay.indexOf(needle, from);
        if (at === -1) break;
        hits.push({ page: i + 1, piece: j, offset: at });
        if (hits.length >= TEXT_LIMITS.hits) return hits;
        from = at + needle.length;
      }
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
