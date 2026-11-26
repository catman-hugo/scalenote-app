// "Add to ScaleNote" (0.6.6): the box shown when something arrives from outside the window: files
// from "Open with" or "Send to", text, links, pictures and PDFs from Android's share menu, or
// files dropped on the page list. It says what arrived and asks where it goes: a new page in the
// inbox folder (chosen in Settings, Files) or the end of the page that is open. Rust checks and
// writes everything (core/src/capture.rs); this box only shows and asks.
//
// Names and text come from other apps, so they are only ever put in as text.

import { strings } from "./strings.js";

function make(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

const fill = (text, values) => text.replace(/\{(\w+)\}/g, (_, key) => (key in values ? String(values[key]) : `{${key}}`));

/** A size in KB or MB, for the list of files. */
function sizeText(bytes) {
  const t = strings.storage.units;
  if (bytes < 1024) return fill(t.b, { n: bytes });
  if (bytes < 1024 * 1024) return fill(t.kb, { n: Math.round(bytes / 1024) });
  return fill(t.mb, { n: (bytes / (1024 * 1024)).toFixed(1) });
}

/** The sentence for one thing that could not be added. */
export function refusedLine(name, reason) {
  const t = strings.capture.reasons;
  return fill(strings.capture.refusedOne, { name, reason: t[reason] || t.failed });
}

/**
 * Asks where `items` ([{ id, kind, label, size }]) go. `inbox` is the inbox folder, `openPage`
 * the path of the open page or null. `add(where)` does the adding (where: { toPage } or
 * { folder }) and resolves to Rust's answer; `dismiss()` drops the things. Resolves to the
 * answer, or null when the person chose not to add them.
 */
export function openCaptureDialog(dialog, { items, inbox, openPage, add, dismiss }) {
  const t = strings.capture;
  return new Promise((resolve) => {
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      dialog.removeEventListener("cancel", onCancel);
      dialog.close();
      resolve(value);
    };
    const onCancel = (event) => {
      event.preventDefault();
      dismiss();
      finish(null);
    };
    dialog.addEventListener("cancel", onCancel);

    const title = make("h2", "", items.length === 1 ? t.titleOne : fill(t.titleMany, { count: items.length }));
    const list = make("ul", "capture-list");
    list.id = "captureList";
    for (const item of items) {
      const line = make("li");
      line.append(make("span", "capture-name", item.kind === "text" ? item.label || t.text : item.label));
      if (item.kind === "file") line.append(make("span", "capture-size", sizeText(item.size)));
      list.append(line);
    }

    const choices = make("div", "capture-choices");
    const choice = (value, label, checked) => {
      const row = make("label", "setting-row capture-choice");
      const radio = document.createElement("input");
      radio.type = "radio";
      radio.name = "captureWhere";
      radio.value = value;
      radio.checked = checked;
      row.append(radio, make("span", "", label));
      choices.append(row);
      return radio;
    };
    const toInbox = choice("inbox", fill(t.newPageIn, { folder: inbox }), true);
    toInbox.id = "captureToInbox";
    let toPage = null;
    if (openPage) {
      toPage = choice("page", fill(t.endOf, { page: openPage.split("/").pop().replace(/\.md$/i, "") }), false);
      toPage.id = "captureToPage";
    }

    const status = make("p", "setting-hint");
    status.id = "captureStatus";
    const no = make("button", "", t.cancel);
    no.type = "button";
    no.id = "captureCancel";
    const yes = make("button", "primary", t.add);
    yes.type = "button";
    yes.id = "captureAdd";
    no.addEventListener("click", () => {
      dismiss();
      finish(null);
    });
    yes.addEventListener("click", async () => {
      yes.disabled = no.disabled = true;
      status.textContent = t.adding;
      try {
        const where = toPage && toPage.checked ? { toPage: openPage } : { folder: inbox };
        finish(await add(where));
      } catch (error) {
        yes.disabled = no.disabled = false;
        status.textContent = (error && strings.errors[error.code]) || t.failed;
      }
    });
    const actions = make("div", "dialog-actions");
    actions.append(no, yes);
    dialog.replaceChildren(title, list, choices, status, actions);
    if (!dialog.open) dialog.showModal();
    yes.focus();
  });
}

/**
 * The box for "New page from clipboard" when the clipboard cannot be read directly (some
 * systems ask first, some never allow it): a field to paste into. Resolves to the text, or null.
 */
export function openPasteDialog(dialog) {
  const t = strings.capture;
  return new Promise((resolve) => {
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      dialog.removeEventListener("cancel", onCancel);
      dialog.close();
      resolve(value);
    };
    const onCancel = (event) => {
      event.preventDefault();
      finish(null);
    };
    dialog.addEventListener("cancel", onCancel);
    const field = document.createElement("textarea");
    field.id = "pasteField";
    field.rows = 6;
    field.className = "capture-paste";
    field.setAttribute("aria-label", t.pasteLabel);
    const no = make("button", "", t.cancel);
    no.type = "button";
    no.addEventListener("click", () => finish(null));
    const yes = make("button", "primary", t.makePage);
    yes.type = "button";
    yes.id = "pasteMake";
    yes.addEventListener("click", () => finish(field.value.trim() ? field.value : null));
    const actions = make("div", "dialog-actions");
    actions.append(no, yes);
    dialog.replaceChildren(make("h2", "", t.pasteTitle), make("p", "setting-hint", t.pasteHint), field, actions);
    if (!dialog.open) dialog.showModal();
    field.focus();
  });
}
