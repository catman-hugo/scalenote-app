// Settings, Storage (0.6.5): how much room the notes folder takes on this device, per folder and
// per kind (text, ink, pictures, PDFs, other), and "Free up space". The counting and freeing
// happen in Rust (core/src/storage.rs, sync/keep.rs); this file only shows them.
//
// Freeing follows rule 2 of the 0.6 plan: only what this device does not keep by its offline
// choices, and only where another of your devices has the same version. What stays is said.

import { icon } from "./icons.js";
import { strings } from "./strings.js";

const PARTS = ["text", "ink", "pictures", "pdfs", "other"];

function make(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

const fill = (text, values) => text.replace(/\{(\w+)\}/g, (_, key) => (key in values ? String(values[key]) : `{${key}}`));

const sum = (bytes) => bytes.reduce((a, b) => a + b, 0);

/** A size in the units people know: B, KB, MB, GB (1024 based, one decimal from MB up). */
export function sizeText(bytes) {
  const t = strings.storage.units;
  if (bytes < 1024) return fill(t.b, { n: bytes });
  if (bytes < 1024 * 1024) return fill(t.kb, { n: Math.round(bytes / 1024) });
  if (bytes < 1024 * 1024 * 1024) return fill(t.mb, { n: (bytes / (1024 * 1024)).toFixed(1) });
  return fill(t.gb, { n: (bytes / (1024 * 1024 * 1024)).toFixed(1) });
}

// "Text 1.2 MB · Pictures 5.0 MB": only the kinds that take room.
function partsLine(bytes) {
  const t = strings.storage;
  const parts = PARTS.map((part, i) => [part, bytes[i]]).filter(([, n]) => n > 0);
  return parts.length ? parts.map(([part, n]) => `${t.parts[part]} ${sizeText(n)}`).join(" · ") : t.empty;
}

function rowName(row) {
  const t = strings.storage.rows;
  return row.kind === "folder" ? row.path.split("/").pop() : t[row.kind];
}

// One line: name, a bar as wide as its share of the biggest, and the size.
function usageRow(row, biggest, onOpen) {
  const total = sum(row.bytes);
  const line = make(onOpen ? "button" : "div", "storage-row");
  if (onOpen) {
    line.type = "button";
    line.addEventListener("click", onOpen);
  }
  line.dataset.path = row.path;
  line.dataset.kind = row.kind;
  line.title = partsLine(row.bytes);
  const bar = make("span", "storage-bar");
  const fillBar = make("span", "storage-bar-fill");
  fillBar.style.width = `${biggest ? Math.max(1, Math.round((total / biggest) * 100)) : 0}%`;
  bar.append(fillBar);
  const name = make("span", "storage-name", rowName(row));
  // A folder with folders inside shows that it opens.
  const more = onOpen ? icon("chevronRight") : make("span");
  more.classList.add("storage-more");
  line.append(name, bar, make("span", "storage-size", sizeText(total)), more);
  return line;
}

/**
 * The rows of the Storage tab. They fill in when the count arrives. `backend` gives
 * storageReport and storageFree; `chooseOffline()` opens the offline choices for the whole folder.
 */
export function storageRows({ backend, chooseOffline, logProblem }) {
  const t = strings.storage;
  const summary = make("p", "storage-total", t.counting);
  summary.id = "storageTotal";
  const parts = make("p", "setting-hint");
  parts.id = "storageParts";
  const list = make("div", "storage-list");
  list.id = "storageList";
  const freeHeading = make("h3", "setting-heading", t.freeHeading);
  const freeText = make("p", "setting-hint");
  freeText.id = "storageFreeText";
  const freeButton = make("button", "", t.freeButton);
  freeButton.type = "button";
  freeButton.id = "storageFree";
  freeButton.hidden = true;
  const chooseButton = make("button", "", t.choose);
  chooseButton.type = "button";
  chooseButton.id = "storageChoose";
  chooseButton.addEventListener("click", chooseOffline);
  const result = make("p", "setting-hint");
  result.id = "storageResult";
  const actions = make("div", "storage-actions");
  actions.append(freeButton, chooseButton);

  let report = null;
  let openFolder = ""; // the folder being looked into; "" is the top

  function drawList() {
    list.replaceChildren();
    let rows;
    if (!openFolder) {
      rows = report.rows;
    } else {
      const depth = openFolder.split("/").length + 1;
      rows = report.folders.filter((f) => f.path.startsWith(`${openFolder}/`) && f.path.split("/").length === depth).sort((a, b) => sum(b.bytes) - sum(a.bytes));
      const up = make("button", "storage-up", fill(t.back, { folder: openFolder }));
      up.type = "button";
      up.id = "storageUp";
      up.addEventListener("click", () => {
        openFolder = openFolder.includes("/") ? openFolder.slice(0, openFolder.lastIndexOf("/")) : "";
        drawList();
      });
      const here = report.folders.find((f) => f.path === openFolder);
      list.append(up, make("p", "setting-hint", here ? fill(t.inFolder, { size: sizeText(sum(here.bytes)), parts: partsLine(here.bytes) }) : ""));
    }
    const biggest = rows.reduce((m, r) => Math.max(m, sum(r.bytes)), 0);
    for (const row of rows) {
      const inside = row.kind === "folder" && report.folders.some((f) => f.path.startsWith(`${row.path}/`));
      list.append(usageRow(row, biggest, inside ? () => {
        openFolder = row.path;
        drawList();
      } : null));
    }
    if (!rows.length) list.append(make("p", "setting-hint", openFolder ? t.noFolders : t.empty));
  }

  function draw() {
    const total = sum(report.total);
    summary.textContent = fill(t.total, { size: sizeText(total), files: report.files });
    parts.textContent = partsLine(report.total) + (report.incomplete ? ` ${t.incomplete}` : "");
    drawList();
    if (report.keepsEverything) {
      freeText.textContent = t.keepsEverything;
      freeButton.hidden = true;
    } else if (report.canFreeFiles === 0) {
      freeText.textContent = t.nothingToFree;
      freeButton.hidden = true;
    } else {
      freeText.textContent = fill(t.canFree, { size: sizeText(report.canFreeBytes), count: report.canFreeFiles });
      freeButton.hidden = false;
    }
  }

  async function load() {
    try {
      report = await backend.storageReport();
      draw();
    } catch (error) {
      logProblem("counting storage failed", error);
      summary.textContent = t.failed;
    }
  }

  freeButton.addEventListener("click", async () => {
    freeButton.disabled = true;
    result.textContent = t.freeing;
    try {
      const done = await backend.storageFree();
      const said = [done.removed ? fill(t.freed, { size: sizeText(done.bytes), count: done.removed }) : t.freedNothing];
      if (done.onlyHere) said.push(fill(t.stayed, { count: done.onlyHere }));
      result.textContent = said.join(" ");
      await load();
    } catch (error) {
      logProblem("freeing space failed", error);
      result.textContent = t.freeFailed;
    }
    freeButton.disabled = false;
  });

  load();
  return [summary, parts, list, freeHeading, freeText, actions, result, make("p", "setting-hint", t.freeHint)];
}
