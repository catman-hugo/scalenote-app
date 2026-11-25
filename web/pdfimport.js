// Adding a PDF to a page, in the two ways ScaleNote v1 had:
//   - "Scroll through": the PDF file is copied into the vault and shown in the page as a block
//     that can be scrolled (pdfblock.js).
//   - "Pages as images": every page becomes a picture in the vault, placed one after another
//     with an empty line after each, so the person can draw and type next to a page.
// A question box asks which one. Nothing is put in the page until everything was stored, so
// stopping half way leaves the page as it was.

import { backend } from "./backend.js";
import { checkPicture, readAsBase64 } from "./images.js";
import { openPdf } from "./pdfdoc.js";
import { encodePageText } from "./imagetext.js";
import { PDF_LIMITS, checkPdf, describeSize, estimatePagesBytes, longPdfNeedsAsking, pageFileName, pdfTitle, roundEstimate, secondsLeft } from "./pdfrules.js";
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
 * unused). For a long PDF (more than `PDF_LIMITS.warnPages` pages, or pictures of more than
 * `PDF_LIMITS.warnPictureBytes`), `confirmLong({ pages, bytes })` is asked first, with a guess of
 * the space the pictures will take; when it says no, nothing is made and this resolves to null,
 * like Stop. There is no page limit.
 *
 * Why it is built as two lanes: painting a page uses the screen's own thread, while turning the
 * painting into a JPEG, and saving it, mostly wait for other threads. So while page N is being
 * encoded and saved, page N + 1 is already being painted. Two canvases take turns for this. The
 * pictures are the same as doing one page at a time (same size, same JPEG quality). Painting two
 * pages at once was tried and was not faster, so it is not done.
 */
export async function importPages(file, { progress = () => {}, stopped = () => false, confirmLong = null } = {}) {
  const problem = checkPdf(file);
  if (problem) throw fail(problem === "unsupported_type" ? "unsupported_pdf" : problem);
  // How long each step took, written to the app's log at the end (About, "Copy the app's log"),
  // because a phone was found much slower than a computer and the cause has to be measured on
  // the phone itself. The steps overlap (see the two lanes above), so they add up to more than
  // the whole.
  const clock = { started: performance.now(), open: 0, paint: 0, jpeg: 0, save: 0, words: 0, pixels: "" };
  const timed = async (step, work) => {
    const start = performance.now();
    try {
      return await work();
    } finally {
      clock[step] += performance.now() - start;
    }
  };
  let pdf;
  try {
    pdf = await timed("open", async () => openPdf(new Uint8Array(await file.arrayBuffer())));
  } catch {
    throw fail("pdf_failed");
  }
  let finished = 0;
  const canvases = [document.createElement("canvas"), document.createElement("canvas")];
  try {
    const title = pdfTitle(file.name);
    const total = pdf.pages;
    if (total > 1 && confirmLong) {
      // One page from the middle is drawn and turned into a picture to guess the size; it is
      // not saved. The cover page is often much plainer or much busier than the rest.
      let base64;
      try {
        await pdf.render(Math.ceil(total / 2), canvases[0]);
        base64 = jpegOf(canvases[0]);
      } catch {
        throw fail("pdf_failed");
      }
      const bytes = estimatePagesBytes(base64.length, total);
      if (longPdfNeedsAsking(total, bytes) && !(await confirmLong({ pages: total, bytes }))) return null;
    }
    const made = new Array(total);
    const saves = [];
    let failure = null;
    let done = 0;
    progress(0, total);

    // Encodes and saves one drawn page. A failure is kept and thrown by the main loop, so a
    // rejected promise is never left without someone listening.
    //
    // Why toDataURL and not toBlob: measured on an Android phone (0.5.7), toBlob took about 5
    // seconds a page against 25 ms on a computer, for the same page and the same JPEG quality.
    // The browser engine makes the toBlob picture in the main thread's idle moments, and while
    // the page is busy (the progress card, the page itself) there are few of them. toDataURL
    // makes it at once, which takes a fraction of a second on a phone, and it gives the text form
    // that saving needs anyway (no second step through a FileReader).
    const save = async (canvas, page) => {
      try {
        const name = pageFileName(file.name, page, total);
        const base64 = await timed("jpeg", async () => jpegOf(canvas));
        const path = await timed("save", () => storePageBase64(name, base64));
        await timed("words", () => keepWords(path, page));
        made[page - 1] = { path, alt: fill(strings.pdf.pageAlt, { page, name: title }) };
        done++;
        finished = done;
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
        await timed("paint", () => pdf.render(page, canvas));
        if (!clock.pixels) clock.pixels = `${canvas.width}x${canvas.height}`;
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
    logTimes(clock, finished, pdf.pages);
    // Free the page memory at once; a long PDF's last page would otherwise stay in memory.
    for (const canvas of canvases) {
      canvas.width = 0;
      canvas.height = 0;
    }
    await pdf.destroy();
  }
}

/** The canvas as a JPEG, in base64 without the "data:" part. Throws when the canvas is empty. */
function jpegOf(canvas) {
  const url = canvas.toDataURL("image/jpeg", PDF_LIMITS.jpegQuality);
  const comma = url.indexOf(",");
  if (!url.startsWith("data:image/jpeg") || comma < 0) throw fail("pdf_failed");
  return url.slice(comma + 1);
}

/** Saves a page picture given as base64, with the same checks as any picture. */
async function storePageBase64(name, base64) {
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  const size = Math.floor((base64.length * 3) / 4) - padding;
  const problem = checkPicture({ name, type: "image/jpeg", size });
  if (problem) throw fail(problem);
  return backend.saveAttachment(name, base64);
}

function logTimes(clock, done, total) {
  const seconds = (ms) => (ms / 1000).toFixed(1);
  const whole = performance.now() - clock.started;
  backend.log(
    "info",
    `pdf import: ${done} of ${total} pages in ${seconds(whole)} s (open ${seconds(clock.open)}, painting ${seconds(clock.paint)}, jpeg ${seconds(clock.jpeg)}, saving ${seconds(clock.save)}, words ${seconds(clock.words)}; page ${clock.pixels || "-"} px)`,
  );
}

/**
 * Shows the question box in `dialog` and resolves to "scroll", "pages" or null (cancelled).
 * The box stays open afterwards: `showProgress` turns it into the progress view.
 */
export function askPdfMode(dialog, name, size = 0) {
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
    // A large file is not refused, only said: it takes that space on every device that syncs it.
    const large = size > PDF_LIMITS.warnBytes ? [make("p", "setting-hint pdf-large", fill(t.largeFile, { size: describeSize(size) }))] : [];
    dialog.replaceChildren(make("h2", "", t.askTitle), make("p", "", fill(t.askText, { name: pdfTitle(name) })), ...large, options, actions);
    dialog.addEventListener("cancel", onCancel);
    if (!dialog.open) dialog.showModal();
    options.querySelector("button").focus();
  });
}

/**
 * Asks before turning a long PDF into pictures: how many pages, and about how much space they
 * will take here and on every device that syncs the notes. Resolves to true to go on.
 */
export function askLongPdf(dialog, name, { pages, bytes }) {
  const t = strings.pdf;
  return new Promise((resolve) => {
    let answered = false;
    const answer = (value) => {
      if (answered) return;
      answered = true;
      dialog.removeEventListener("cancel", onCancel);
      dialog.close();
      resolve(value);
    };
    const onCancel = () => answer(false);
    const cancel = make("button", "", t.cancel);
    cancel.type = "button";
    cancel.addEventListener("click", () => answer(false));
    const go = make("button", "primary", fill(t.longGo, { pages }));
    go.type = "button";
    go.id = "pdfLongGo";
    go.addEventListener("click", () => answer(true));
    const actions = make("div", "dialog-actions");
    actions.append(cancel, go);
    const text = fill(t.longText, { name: pdfTitle(name), pages, size: describeSize(bytes) });
    dialog.replaceChildren(make("h2", "", t.longTitle), make("p", "", text), make("p", "setting-hint", t.longHint), actions);
    dialog.addEventListener("cancel", onCancel);
    if (!dialog.open) dialog.showModal();
    cancel.focus();
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
