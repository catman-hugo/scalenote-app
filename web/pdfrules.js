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
