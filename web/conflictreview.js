// The conflict review: the copies that a sync saved when two devices changed the same page, the
// page and its copy side by side, and a choice to keep one. The one that is not kept goes to the
// trash (it can be restored), and the next sync carries the result to the other devices.

import { BackendError, backend } from "./backend.js";
import { strings } from "./strings.js";

function fill(template, values) {
  return template.replace(/\{(\w+)\}/g, (_, key) => String(values[key] ?? ""));
}

function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text) node.textContent = text;
  if (className) node.className = className;
  return node;
}

function button(text, onClick, primary) {
  const node = element("button", text, primary ? "primary" : "");
  node.type = "button";
  node.addEventListener("click", onClick);
  return node;
}

async function textOf(path) {
  try {
    return (await backend.readNote(path)).text;
  } catch {
    return null;
  }
}

/** Opens the review. `onSettled` is called after a copy was settled (to refresh the page list). */
export async function openConflictReview({ logProblem, onSettled }) {
  const text = strings.settings;
  const dialog = element("dialog", "", "dialog conflict-dialog");
  dialog.setAttribute("aria-label", text.conflictsHeading);
  const body = element("div", "", "conflict-body");
  const close = button(text.conflictsClose, () => dialog.close(), true);
  close.id = "conflictsClose";
  dialog.append(element("h2", text.conflictsHeading), element("p", text.conflictsHint, "setting-hint"), body, close);
  dialog.addEventListener("close", () => dialog.remove());
  document.body.append(dialog);
  dialog.showModal();

  async function draw(message) {
    body.replaceChildren(element("p", text.conflictsLoading, "setting-hint"));
    let items;
    try {
      items = await backend.conflictsList();
    } catch (error) {
      logProblem("listing conflict copies failed", error);
      body.replaceChildren(element("p", text.conflictsFailed, "setting-hint sync-error"));
      return;
    }
    body.replaceChildren();
    if (message) body.append(element("p", message, "setting-hint conflict-message"));
    if (items.length === 0) body.append(element("p", text.conflictsNone, "setting-hint"));
    for (const item of items) body.append(await row(item));
  }

  async function row(item) {
    const box = element("section", "", "conflict-item");
    box.append(element("h3", item.original, "setting-heading"));
    const sides = element("div", "", "conflict-sides");
    if (item.isPage) {
      const [page, copy] = await Promise.all([textOf(item.original), textOf(item.copy)]);
      const side = (label, content) => {
        const column = element("div", "", "conflict-side");
        column.append(element("h4", label, "conflict-side-title"));
        const pre = element("pre", content === null || content === "" ? text.conflictEmpty : content, "conflict-text");
        column.append(pre);
        return column;
      };
      sides.append(side(text.conflictPage, page), side(fill(text.conflictCopy, { device: item.device, date: item.date }), copy));
    } else {
      sides.append(element("p", text.conflictNotText, "setting-hint"));
    }
    box.append(sides);
    const settle = async (keep) => {
      try {
        const done = await backend.conflictSettle(item.copy, keep);
        await onSettled();
        await draw(done ? text.conflictSettled : text.conflictChanged);
      } catch (error) {
        logProblem("settling a conflict copy failed", error);
        const code = error instanceof BackendError ? error.code : "unknown";
        await draw(strings.errors[code] || strings.errors.unknown);
      }
    };
    const keepPage = button(text.conflictKeepPage, () => settle("page"));
    keepPage.className = "keep-page";
    const buttons = element("div", "", "sync-panel-buttons");
    buttons.append(keepPage);
    if (item.isPage) {
      const keepCopy = button(text.conflictKeepCopy, () => settle("copy"));
      keepCopy.className = "keep-copy";
      buttons.append(keepCopy);
    }
    box.append(buttons);
    return box;
  }

  await draw("");
  close.focus();
}
