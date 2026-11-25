// What can be done with one paired device in the Sync tab: Sync now, Compare (what would
// change, without changing anything), Rename, and the panel that shows the answer.
//
// The list of devices is redrawn from time to time, so what is shown for each device (a
// preview, a result, the rename box) is kept in `views`, outside the drawing, and drawn again.

import { BackendError, backend } from "./backend.js";
import { actionLabel, previewLines, previewTotal, reportLine } from "./syncrules.js";
import { strings } from "./strings.js";

const SHOWN_FILES = 40;
const views = new Map(); // device id -> { view, busy, render }

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

function errorSentence(error) {
  const code = error instanceof BackendError ? error.code : "unknown";
  return strings.errors[code] || strings.errors.unknown;
}

function wifiRow(peer, wifi, text, logProblem) {
  const row = element("label", "", "setting-row sync-wifi-row");
  const box = element("input");
  box.type = "checkbox";
  box.className = "sync-wifi-only";
  box.checked = peer.wifiOnly === true;
  box.addEventListener("change", async () => {
    try {
      await wifi.change(peer.id, box.checked);
    } catch (error) {
      logProblem("changing Wi-Fi only failed", error);
      box.checked = !box.checked;
    }
  });
  row.append(element("span", text.wifiOnly, "setting-label"), box);
  return row;
}

// `ask` holds `start` when the panel asks before a first sync; `close` always hides the panel.
function previewPanel(peer, preview, ask, close, text) {
  const box = element("div", "", "sync-panel");
  box.append(element("h4", fill(preview.first ? text.previewFirstHeading : text.previewHeading, { name: peer.name }), "sync-panel-title"));
  if (preview.first) box.append(element("p", text.previewFirstHint, "setting-hint"));
  const lines = previewLines(preview, peer.name, text);
  if (lines.length === 0) box.append(element("p", text.previewNothing, "setting-hint"));
  const list = element("ul", "", "pair-list");
  for (const line of lines) list.append(element("li", line));
  box.append(list);
  if (preview.items.length > 0) {
    const files = element("ul", "", "pair-list sync-files");
    for (const item of preview.items.slice(0, SHOWN_FILES)) files.append(element("li", `${item.path} (${actionLabel(item.action, text)})`));
    if (preview.items.length > SHOWN_FILES || preview.itemsTruncated) {
      const more = Math.max(preview.items.length - SHOWN_FILES, 0);
      files.append(element("li", more > 0 ? fill(text.previewMore, { n: more }) + (preview.itemsTruncated ? "…" : "") : "…"));
    }
    box.append(files);
  }
  const row = element("div", "", "sync-panel-buttons");
  if (ask) row.append(button(text.previewStart, ask.start, true));
  // After Compare there is nothing to start, but Cancel still closes the panel.
  row.append(button(text.previewCancel, close, false));
  box.append(row);
  return box;
}

/**
 * The buttons and the answer panel for one paired device. `done(report)` is called after a sync
 * ran, so the screen and the page list can be refreshed.
 */
export function peerControls(peer, { logProblem, done, paused, wifi = null }) {
  const text = strings.settings;
  const state = views.get(peer.id) || { view: null, busy: false, render: null };
  views.set(peer.id, state);
  const buttons = element("div", "", "sync-peer-buttons");
  const panel = element("div", "", "sync-peer-panel");
  panel.setAttribute("role", "status");
  const wrapper = element("div", "", "sync-peer");
  wrapper.append(buttons);
  // Only where the app can tell the kind of network (the Android app).
  if (wifi && wifi.available) wrapper.append(wifiRow(peer, wifi, text, logProblem));
  wrapper.append(panel);

  const syncButton = button(text.syncNow, () => run(false));
  const compareButton = button(text.syncCompare, () => compare());
  const renameButton = button(text.syncRename, () => show({ type: "rename" }));
  syncButton.className = "sync-now";
  compareButton.className = "sync-compare";
  renameButton.className = "sync-rename";
  buttons.append(syncButton, compareButton, renameButton);

  function show(view) {
    state.view = view;
    state.render();
  }

  state.render = () => {
    const disabled = state.busy || paused;
    for (const node of [syncButton, compareButton]) node.disabled = disabled;
    panel.replaceChildren();
    const view = state.view;
    if (!view) return;
    if (view.type === "message") panel.append(element("p", view.text, "setting-hint"));
    if (view.type === "error") panel.append(element("p", view.text, "setting-hint sync-error"));
    if (view.type === "preview") panel.append(previewPanel(peer, view.preview, view.ask ? { start: () => run(true) } : null, () => show(null), text));
    if (view.type === "rename") panel.append(renameBox());
  };

  function renameBox() {
    const box = element("div", "", "sync-panel");
    const input = element("input");
    input.type = "text";
    input.className = "sync-rename-input";
    input.maxLength = 40;
    input.value = peer.name;
    input.setAttribute("aria-label", text.renameLabel);
    const save = button(text.renameSave, async () => {
      try {
        await backend.syncRenamePeer(peer.id, input.value);
        show(null);
        await done(null);
      } catch (error) {
        logProblem("renaming a device failed", error);
        show({ type: "error", text: text.renameFailed });
      }
    }, true);
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") save.click();
      if (event.key === "Escape") {
        // Closes this box only, not the Settings window around it.
        event.preventDefault();
        event.stopPropagation();
        show(null);
      }
    });
    box.append(element("p", text.renameHint, "setting-hint"), input, save, button(text.renameCancel, () => show(null)));
    queueMicrotask(() => input.focus());
    return box;
  }

  async function busy(label, work) {
    state.busy = true;
    const old = label.textContent;
    label.textContent = label === syncButton ? text.syncRunning : text.syncComparing;
    state.render();
    try {
      await work();
    } catch (error) {
      logProblem("sync action failed", error);
      show({ type: "error", text: errorSentence(error) });
    } finally {
      state.busy = false;
      label.textContent = old;
      state.render();
    }
  }

  function compare() {
    return busy(compareButton, async () => show({ type: "preview", preview: await backend.syncCompare(peer.id), ask: false }));
  }

  function run(approved) {
    return busy(syncButton, async () => {
      const result = await backend.syncRun(peer.id, approved);
      if (result.needsApproval) {
        show({ type: "preview", preview: result.preview, ask: true });
        return;
      }
      const report = result.report;
      let sentence = reportLine(report, peer.name, text);
      if (report.conflicts > 0) sentence += ` ${fill(text.reportConflicts, { n: report.conflicts })}`;
      show({ type: "message", text: sentence });
      await done(report);
    });
  }

  state.render();
  return wrapper;
}
