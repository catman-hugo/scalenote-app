// Opening a PDF with pdf.js and drawing its pages. This is the only file that touches the
// library, and the library is only loaded when a PDF is first used, so a vault without PDFs
// never pays for it.
//
// A PDF is untrusted. What keeps it contained: pdf.js runs in its own worker; it is only asked
// for the pictures of the pages (no scripts, forms or links are used); the worker, fonts and
// image decoders are files shipped with the app (nothing is fetched from the network); the
// size, page count and pixels per page are limited (pdfrules.js). The text of a page is only
// ever put into the page as plain text (never as markup), and how much of it is read is limited.

import { PDF_LIMITS, TEXT_LIMITS, pageScale } from "./pdfrules.js";

let library = null;

// Where build.mjs puts the worker, the fonts and the decoders, as full addresses (the worker
// resolves addresses against its own place, not the page's).
const here = (path) => new URL(path, document.baseURI).href;

function loadLibrary() {
  if (!library) {
    library = import("pdfjs-dist/legacy/build/pdf.mjs").then((lib) => {
      lib.GlobalWorkerOptions.workerSrc = here("pdf/pdf.worker.min.js");
      return lib;
    });
    // A failed load must not be remembered, or one bad moment would break PDFs until restart.
    library.catch(() => {
      library = null;
    });
  }
  return library;
}

/** Turns the `data:` address the Rust side gives into bytes. */
export function bytesOfDataUrl(url) {
  const comma = String(url).indexOf(",");
  if (comma === -1) throw new Error("not a data address");
  const text = atob(url.slice(comma + 1));
  if (text.length > PDF_LIMITS.bytes) throw new Error("too large");
  const bytes = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i);
  return bytes;
}

/**
 * Opens a PDF from its bytes. Resolves to `{ pages, pageSize(n), render(n, canvas, options),
 * destroy() }`. The bytes are given to the worker, so the caller must not use them again.
 */
export async function openPdf(bytes) {
  const lib = await loadLibrary();
  const task = lib.getDocument({
    data: bytes,
    standardFontDataUrl: here("pdf/standard_fonts/"),
    wasmUrl: here("pdf/wasm/"),
    useSystemFonts: false,
    // The image decoders run as plain script files (no WebAssembly), so the page policy needs
    // no "unsafe" entry. They are a little slower, which only matters for scanned pages.
    useWasm: false,
    // Nothing is needed from a PDF but what its pages look like.
    enableXfa: false,
    stopAtErrors: false,
    maxImageSize: 16_777_216,
    verbosity: 0,
  });
  const doc = await task.promise;
  let closed = false;

  async function size(n) {
    const page = await doc.getPage(n);
    const { width, height } = page.getViewport({ scale: 1 });
    page.cleanup();
    return { width, height };
  }

  return {
    pages: doc.numPages,
    pageSize: size,
    /**
     * Draws page `n` onto `canvas` so it is `cssWidth` pixels wide on the screen (at `ratio`
     * device pixels per pixel), or at its natural scale for a picture when `cssWidth` is not
     * given. Resolves to `{ width, height }` in canvas pixels. Cancelled by `cancel()` on the
     * returned `task`.
     */
    async render(n, canvas, { cssWidth, ratio = 1, task: hold } = {}) {
      const page = await doc.getPage(n);
      try {
        const base = page.getViewport({ scale: 1 });
        const wanted = cssWidth ? (cssWidth * ratio) / base.width : PDF_LIMITS.scale;
        const limit = cssWidth ? PDF_LIMITS.viewPixels : PDF_LIMITS.pagePixels;
        const viewport = page.getViewport({ scale: pageScale(base.width, base.height, limit, wanted) });
        canvas.width = Math.max(1, Math.floor(viewport.width));
        canvas.height = Math.max(1, Math.floor(viewport.height));
        const context = canvas.getContext("2d");
        // Paper is white whatever the theme is; a page with a transparent background would
        // otherwise turn black in a JPEG and unreadable in the dark theme.
        context.fillStyle = "#ffffff";
        context.fillRect(0, 0, canvas.width, canvas.height);
        const drawing = page.render({ canvas, canvasContext: context, viewport });
        if (hold) hold.cancel = () => drawing.cancel();
        await drawing.promise;
        return { width: canvas.width, height: canvas.height, ratio: base.height / base.width };
      } finally {
        page.cleanup();
      }
    },
    /**
     * Puts the selectable text of page `n` into `container` (an empty element laid over the
     * page, `cssWidth` pixels wide) as transparent words that line up with the drawn page.
     * Resolves to `{ layer, texts, cancel }`: `texts[i]` is the words of the i-th element of
     * `layer.textDivs`, which the find box uses to mark hits. Reading stops at TEXT_LIMITS.
     */
    async renderText(n, container, { cssWidth, task: hold } = {}) {
      const page = await doc.getPage(n);
      try {
        const base = page.getViewport({ scale: 1 });
        const scale = Math.max(50, cssWidth) / base.width;
        const viewport = page.getViewport({ scale });
        // pdf.js sizes the words by this variable; the page's own css supplies the rest.
        container.style.setProperty("--total-scale-factor", String(scale));
        const layer = new lib.TextLayer({ textContentSource: page.streamTextContent(), container, viewport });
        if (hold) hold.cancel = () => layer.cancel();
        await layer.render();
        const texts = layer.textContentItemsStr.slice(0, TEXT_LIMITS.itemsPerPage).map((t) => String(t).slice(0, TEXT_LIMITS.itemChars));
        return { layer, texts };
      } finally {
        page.cleanup();
      }
    },
    /** The text pieces of page `n` (cut to the TEXT_LIMITS), for searching. */
    async pageText(n) {
      const page = await doc.getPage(n);
      try {
        const content = await page.getTextContent();
        const out = [];
        let chars = 0;
        for (const item of content.items) {
          if (typeof item.str !== "string") continue;
          const piece = item.str.slice(0, TEXT_LIMITS.itemChars);
          out.push(piece);
          chars += piece.length;
          if (out.length >= TEXT_LIMITS.itemsPerPage || chars >= TEXT_LIMITS.pageChars) break;
        }
        return out;
      } finally {
        page.cleanup();
      }
    },
    async destroy() {
      if (closed) return;
      closed = true;
      try {
        await doc.destroy();
      } catch {
        // Already gone: nothing left to free.
      }
    },
  };
}

/** True for the error pdf.js raises when a drawing is cancelled on purpose. */
export function wasCancelled(error) {
  return Boolean(error) && (error.name === "RenderingCancelledException" || error.name === "AbortException");
}
