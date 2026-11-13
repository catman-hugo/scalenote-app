// Adding a PDF to a page, in the two ways ScaleNote v1 had:
//   - "Scroll through": the PDF file is copied into the vault and shown in the page as a block
//     that can be scrolled (pdfblock.js).
//   - "Pages as images": every page becomes a picture in the vault, placed one after another
//     with an empty line after each, so the person can draw and type next to a page.
// A question box asks which one. Nothing is put in the page until everything was stored, so
// stopping half way leaves the page as it was.

import { backend } from "./backend.js";
import { readAsBase64, storePicture } from "./images.js";
import { openPdf } from "./pdfdoc.js";
import { PDF_LIMITS, checkPdf, pageFileName, pdfTitle } from "./pdfrules.js";
import { strings } from "./strings.js";

function make(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

const fill = (text, values) => text.replace(/\{(\w+)\}/g, (_, key) => String(values[key] ?? ""));
const fail = (code) => Object.assign(new Error(code), { code });

/** Opens the system's file chooser and resolves to the chosen PDF, or null. */
export function choosePdf() {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "application/pdf,.pdf";
    input.hidden = true;
    input.addEventListener("change", () => {
      resolve(input.files && input.files[0] ? input.files[0] : null);
      input.remove();
    });
    input.addEventListener("cancel", () => {
      resolve(null);
      input.remove();
    });
    document.body.append(input);
    input.click();
  });
}

/** True for the files a drop or choice may treat as a PDF. */
export const looksLikePdf = (file) => checkPdf(file) === null;

/** Copies the PDF file into the vault. Resolves to its path in the vault. */
export async function storePdf(file) {
  const problem = checkPdf(file);
  if (problem) throw fail(problem === "unsupported_type" ? "unsupported_pdf" : problem);
  try {
    return await backend.saveAttachment(file.name || "document.pdf", await readAsBase64(file));
  } catch (error) {
    // The Rust side says "too_large" for any attachment; for a PDF the limit is a different one.
    if (error && error.code === "too_large") throw fail("too_large_pdf");
    if (error && error.code === "unsupported_type") throw fail("unsupported_pdf");
    throw error;
  }
}

/**
 * Turns every page into a picture in the vault. Resolves to `[{ path, alt }]` in page order.
 * `progress(page, total)` is told before each page, and `stopped()` says whether the person
 * pressed Stop (the pictures already made stay in the vault, unused).
 */
export async function importPages(file, { progress = () => {}, stopped = () => false } = {}) {
  const problem = checkPdf(file);
  if (problem) throw fail(problem === "unsupported_type" ? "unsupported_pdf" : problem);
  let pdf;
  try {
    pdf = await openPdf(new Uint8Array(await file.arrayBuffer()));
  } catch {
    throw fail("pdf_failed");
  }
  try {
    if (pdf.pages > PDF_LIMITS.importPages) throw fail("pdf_too_many_pages");
    const title = pdfTitle(file.name);
    const canvas = document.createElement("canvas");
    const made = [];
    for (let page = 1; page <= pdf.pages; page++) {
      if (stopped()) return null;
      progress(page, pdf.pages);
      try {
        await pdf.render(page, canvas);
      } catch {
        throw fail("pdf_failed");
      }
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", PDF_LIMITS.jpegQuality));
      if (!blob) throw fail("pdf_failed");
      const picture = new File([blob], pageFileName(file.name, page, pdf.pages), { type: "image/jpeg" });
      const path = await storePicture(picture);
      made.push({ path, alt: fill(strings.pdf.pageAlt, { page, name: title }) });
    }
    // Free the page memory at once; a long PDF's last page would otherwise stay in memory.
    canvas.width = 0;
    canvas.height = 0;
    return made;
  } finally {
    await pdf.destroy();
  }
}

/**
 * Shows the question box in `dialog` and resolves to "scroll", "pages" or null (cancelled).
 * The box stays open afterwards: `showProgress` turns it into the progress view.
 */
export function askPdfMode(dialog, name) {
  const t = strings.pdf;
  return new Promise((resolve) => {
    let answered = false;
    const answer = (value) => {
      if (answered) return;
      answered = true;
      dialog.removeEventListener("cancel", onCancel);
      resolve(value);
    };
    const onCancel = () => answer(null);
    const option = (title, hint, value) => {
      const button = make("button", "pdf-option");
      button.type = "button";
      button.append(make("span", "pdf-option-title", title), make("span", "pdf-option-hint", hint));
      button.addEventListener("click", () => answer(value));
      return button;
    };
    const cancel = make("button", "", t.cancel);
    cancel.type = "button";
    cancel.addEventListener("click", () => {
      answer(null);
      dialog.close();
    });
    const options = make("div", "pdf-options");
    options.append(option(t.scroll, t.scrollHint, "scroll"), option(t.pages, t.pagesHint, "pages"));
    const actions = make("div", "dialog-actions");
    actions.append(cancel);
    dialog.replaceChildren(make("h2", "", t.askTitle), make("p", "", fill(t.askText, { name: pdfTitle(name) })), options, actions);
    dialog.addEventListener("cancel", onCancel);
    if (!dialog.open) dialog.showModal();
    options.querySelector("button").focus();
  });
}

/**
 * Turns the open box into a progress view. Returns `{ update(page, total), stopped(), finish() }`;
 * Stop, or Escape, makes `stopped()` true, and `finish()` closes the box.
 */
export function showProgress(dialog, name) {
  const t = strings.pdf;
  let stop = false;
  const status = make("p", "pdf-progress", "");
  status.setAttribute("role", "status");
  const button = make("button", "", t.stop);
  button.type = "button";
  const end = () => {
    stop = true;
    button.disabled = true;
  };
  button.addEventListener("click", end);
  // Escape asks to stop instead of closing the box under a running import.
  const onEscape = (event) => {
    event.preventDefault();
    end();
  };
  dialog.addEventListener("cancel", onEscape);
  const actions = make("div", "dialog-actions");
  actions.append(button);
  dialog.replaceChildren(make("h2", "", fill(t.working, { name: pdfTitle(name) })), status, actions);
  return {
    update: (page, total) => {
      status.textContent = fill(t.progress, { page, total });
    },
    stopped: () => stop,
    // Gives Escape its normal job back and closes the box.
    finish: () => {
      dialog.removeEventListener("cancel", onEscape);
      dialog.close();
    },
  };
}
