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
import { encodePageText } from "./imagetext.js";
import { PDF_LIMITS, checkPdf, pageFileName, pdfTitle, roundEstimate, secondsLeft } from "./pdfrules.js";
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
 * `progress(done, total)` is told when the import starts and after each page is saved, and
 * `stopped()` says whether the person pressed Stop (the pictures already made stay in the vault,
 * unused).
 *
 * Why it is built as two lanes: painting a page uses the screen's own thread, while turning the
 * painting into a JPEG, and saving it, mostly wait for other threads. So while page N is being
 * encoded and saved, page N + 1 is already being painted. Two canvases take turns for this. The
 * pictures are the same as doing one page at a time (same size, same JPEG quality). Painting two
 * pages at once was tried and was not faster, so it is not done.
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
  const canvases = [document.createElement("canvas"), document.createElement("canvas")];
  try {
    if (pdf.pages > PDF_LIMITS.importPages) throw fail("pdf_too_many_pages");
    const title = pdfTitle(file.name);
    const total = pdf.pages;
    const made = new Array(total);
    const saves = [];
    let failure = null;
    let done = 0;
    progress(0, total);

    // Encodes and saves one drawn page. A failure is kept and thrown by the main loop, so a
    // rejected promise is never left without someone listening.
    const save = async (canvas, page) => {
      try {
        const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", PDF_LIMITS.jpegQuality));
        if (!blob) throw fail("pdf_failed");
        const picture = new File([blob], pageFileName(file.name, page, total), { type: "image/jpeg" });
        const path = await storePicture(picture);
        await keepWords(path, page);
        made[page - 1] = { path, alt: fill(strings.pdf.pageAlt, { page, name: title }) };
        done++;
        progress(done, total);
      } catch (error) {
        failure = failure || (error && error.code ? error : fail("pdf_failed"));
      }
    };

    // The words of the page go in a small file beside its picture, so the find bar can find
    // them (see imagetext.js). This is extra: if it fails, the picture is still imported.
    const keepWords = async (path, page) => {
      try {
        const words = await pdf.pageTextBoxes(page);
        const text = encodePageText(words.items, words.width, words.height);
        if (text) await backend.writePageText(path, text);
      } catch {
        // A page whose words cannot be read is still a good picture; it is just not searchable.
      }
    };

    let cancelled = false;
    for (let page = 1; page <= total; page++) {
      if (stopped()) {
        cancelled = true;
        break;
      }
      // The canvas this page will use was used by the page before the previous one; its save
      // has to be finished (at most two pages are in flight at once, so memory stays small).
      if (page > 2) await saves[page - 3];
      if (failure) break;
      const canvas = canvases[(page - 1) % 2];
      try {
        await pdf.render(page, canvas);
      } catch {
        failure = failure || fail("pdf_failed");
        break;
      }
      saves.push(save(canvas, page));
    }
    await Promise.all(saves);
    if (failure) throw failure;
    return cancelled ? null : made;
  } finally {
    // Free the page memory at once; a long PDF's last page would otherwise stay in memory.
    for (const canvas of canvases) {
      canvas.width = 0;
      canvas.height = 0;
    }
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

/** The time left as words, for example "About 2 min left". */
export function describeTimeLeft(seconds) {
  const t = strings.pdf;
  if (seconds === null) return t.timeUnknown;
  const { minutes, seconds: rest } = roundEstimate(seconds);
  return fill(t.timeLeft, { time: minutes > 0 ? fill(t.minutes, { count: minutes }) : fill(t.seconds, { count: rest }) });
}

/**
 * Fills the small progress card that sits over the page (not a box: the person keeps working
 * while it runs). Returns `{ update(done, total), stopped(), finish() }`; Stop makes `stopped()`
 * true, and `finish()` hides the card.
 */
export function showProgress(card, name) {
  const t = strings.pdf;
  const began = performance.now();
  let stop = false;
  const title = make("p", "job-title", fill(t.working, { name: pdfTitle(name) }));
  const status = make("p", "job-status", "");
  const left = make("p", "job-left", t.timeUnknown);
  const button = make("button", "", t.stop);
  button.type = "button";
  button.addEventListener("click", () => {
    stop = true;
    button.disabled = true;
    left.textContent = t.stopping;
  });
  const actions = make("div", "job-actions");
  actions.append(button);
  card.replaceChildren(title, status, left, make("p", "job-hint", t.keepOpen), actions);
  card.hidden = false;
  return {
    update: (done, total) => {
      status.textContent = fill(t.progress, { done, total });
      if (!stop) left.textContent = describeTimeLeft(secondsLeft(done, total, performance.now() - began));
    },
    stopped: () => stop,
    finish: () => {
      card.hidden = true;
      card.replaceChildren();
    },
  };
}
