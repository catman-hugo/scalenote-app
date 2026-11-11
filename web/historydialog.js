// The History box: older versions of the open page, what changed since, and putting back all
// of a version or only the parts you choose. This file only draws and collects choices; the
// restore itself (and the checks around it) is done by `restore` from main.js.

import { hideNoteId } from "./blocks.js";
import { applyChosen, countChanges, diffLines, lineCount, splitPageBlocks } from "./historyrules.js";
import { strings } from "./strings.js";

// Drawing everything of a huge page would freeze a phone, so only this much is drawn.
const MAX_CHANGES = 200;
const MAX_LINES = 400;
// Unchanged lines shown on each side of a change; the rest are folded into one note.
const CONTEXT = 2;

function make(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

const fill = (text, values) => text.replace(/\{(\w+)\}/g, (_, key) => String(values[key] ?? ""));

function sizeText(bytes) {
  const h = strings.history;
  return bytes < 1024 ? fill(h.sizeBytes, { n: bytes }) : fill(h.sizeKilobytes, { n: Math.round(bytes / 1024) });
}

const timeFormat = () => new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });

// Some lines of the page. With `render` (the History box was opened from the normal text) they
// are shown as the page looks; without it, as the markdown in the file.
function textOf(lines, render) {
  const text = lines.join("");
  if (!render) return make("pre", "history-lines", text);
  // Lines that are all blank would draw as nothing at all.
  if (text.trim() === "") return make("p", "history-note history-blank", lineCount(lines) === 1 ? strings.history.blankOne : fill(strings.history.blank, { count: lineCount(lines) }));
  return render(text);
}

// Lines of one side of a change. A part with no lines says so in words.
function linesBox(label, lines, kind, render) {
  const h = strings.history;
  const box = make("div", `history-side history-${kind}`);
  box.append(make("p", "history-side-label", label));
  const shown = lines.slice(0, MAX_LINES);
  box.append(shown.length ? textOf(shown, render) : make("pre", "history-lines", h.partNothing));
  if (lines.length > MAX_LINES) box.append(make("p", "history-note", fill(h.moreLines, { count: lines.length - MAX_LINES })));
  return box;
}

function unchangedNote(count) {
  const h = strings.history;
  return make("p", "history-fold", count === 1 ? h.unchangedOne : fill(h.unchanged, { count }));
}

// The page properties (the `---` block at the very top) are folded into one note, so they are
// not mistaken for text.
function propertyLines(lines) {
  if (!/^---[ \t]*\r?\n$/.test(lines[0] || "")) return 0;
  const end = lines.findIndex((line, i) => i > 0 && /^---[ \t]*\r?\n?$/.test(line));
  return end === -1 ? 0 : end + 1;
}

// Shows a few unchanged lines next to a change and folds the rest.
function sameLines(lines, before, after, first, render) {
  const wrap = make("div", "history-same");
  const props = first ? propertyLines(lines) : 0;
  if (props) {
    wrap.append(make("p", "history-fold", fill(strings.history.properties, { count: props })));
    const rest = lines.slice(props);
    if (rest.length) wrap.append(sameLines(rest, false, after, false, render));
    return wrap;
  }
  const need = (before ? CONTEXT : 0) + (after ? CONTEXT : 0);
  if (lines.length <= need + 1) {
    wrap.append(textOf(lines, render));
    return wrap;
  }
  if (before) wrap.append(textOf(lines.slice(0, CONTEXT), render));
  // A piece can be a whole block of several lines (see splitPageBlocks); the note counts lines.
  wrap.append(unchangedNote(lineCount(lines.slice(before ? CONTEXT : 0, lines.length - (after ? CONTEXT : 0)))));
  if (after) wrap.append(textOf(lines.slice(lines.length - CONTEXT), render));
  return wrap;
}

/**
 * Opens the History box in `dialog`.
 *  - `list()` returns the older versions, newest first ({ id, time, size }).
 *  - `read(id)` returns the text of one version, `current()` the text of the page on disk.
 *  - `restore(text, baseText)` writes the text to the page; it throws if the page changed
 *    since `baseText` was read. It returns once the page is back in the editor.
 *  - `onError(error)` logs a problem and returns the sentence to show.
 *  - `render(markdown)`, when given, returns an element showing the text as the page looks
 *    (pagetext.js). It is given when the box is opened from the normal text; from the Markdown
 *    view it is left out and the text is shown as it is in the file.
 */
export async function openHistory(dialog, { list, read, current, restore, onError, render }) {
  const h = strings.history;
  const formatter = timeFormat();
  let versions = [];
  let message = "";
  let chosenId = "";
  let view = "changes";
  let base = "";
  let versionText = "";
  let parts = [];
  const ticked = new Set();

  const listBox = make("div", "history-list-box");
  const detail = make("div", "history-detail");
  const status = make("p", "history-status");
  status.setAttribute("role", "status");

  const restoreChosen = make("button", "", h.restoreChosen);
  restoreChosen.type = "button";
  const restoreAll = make("button", "", h.restoreAll);
  restoreAll.type = "button";
  const close = make("button", "primary", h.close);
  close.type = "button";
  close.addEventListener("click", () => dialog.close());
  const foot = make("div", "dialog-actions");
  foot.append(restoreChosen, restoreAll, close);

  function setBusy(busy) {
    restoreAll.hidden = !chosenId;
    restoreChosen.hidden = !chosenId;
    restoreAll.disabled = busy || !chosenId;
    restoreChosen.disabled = busy || !chosenId || ticked.size === 0;
  }

  function drawList() {
    listBox.replaceChildren();
    if (message) {
      const problem = make("p", "history-error", message);
      problem.setAttribute("role", "alert");
      listBox.append(problem);
    }
    if (!versions.length) {
      if (!message) listBox.append(make("p", "history-empty", h.empty));
      return;
    }
    const ul = make("ul", "history-list");
    ul.setAttribute("aria-label", h.listLabel);
    for (const item of versions) {
      const li = make("li");
      const row = make("button", "history-row");
      row.type = "button";
      row.dataset.id = item.id;
      row.setAttribute("aria-pressed", String(item.id === chosenId));
      row.append(make("span", "", formatter.format(new Date(item.time * 1000))), make("span", "history-size", sizeText(item.size)));
      row.addEventListener("click", () => choose(item.id));
      li.append(row);
      ul.append(li);
    }
    listBox.append(ul);
  }

  function viewSwitch() {
    const bar = make("div", "history-views");
    bar.setAttribute("role", "group");
    bar.setAttribute("aria-label", h.viewLabel);
    for (const [key, label] of [["changes", h.viewChanges], ["text", h.viewText]]) {
      const b = make("button", "history-view", label);
      b.type = "button";
      b.setAttribute("aria-pressed", String(view === key));
      b.addEventListener("click", () => {
        view = key;
        drawDetail();
      });
      bar.append(b);
    }
    return bar;
  }

  function changeBox(part, index) {
    const box = make("div", "history-change");
    const label = make("label", "history-pick");
    const check = make("input");
    check.type = "checkbox";
    check.checked = ticked.has(index);
    check.addEventListener("change", () => {
      if (check.checked) ticked.add(index);
      else ticked.delete(index);
      setBusy(false);
    });
    label.append(check, make("span", "", h.putPartBack));
    box.append(label, linesBox(h.partNow, part.current, "now", render), linesBox(h.partThen, part.version, "then", render));
    return box;
  }

  function drawChanges() {
    if (!countChanges(parts)) return [make("p", "history-empty", h.same)];
    const out = [];
    let shown = 0;
    parts.forEach((part, index) => {
      if (part.same) {
        const before = index > 0;
        const after = index < parts.length - 1;
        out.push(sameLines(part.same, before, after, index === 0, render));
      } else if (shown < MAX_CHANGES) {
        shown++;
        out.push(changeBox(part, index));
      }
    });
    if (countChanges(parts) > MAX_CHANGES) out.push(make("p", "history-note", fill(h.moreChanges, { count: MAX_CHANGES })));
    return out;
  }

  function drawDetail() {
    detail.replaceChildren();
    if (!chosenId) return;
    detail.append(viewSwitch());
    if (view === "text") {
      const lines = hideNoteId(versionText).text.split(/(?<=\n)/).slice(0, MAX_LINES * 5);
      if (render) {
        // The properties block is not page text: it is one folded note, as in the changes view.
        const props = propertyLines(lines);
        if (props) detail.append(make("p", "history-fold", fill(h.properties, { count: props })));
        const whole = textOf(lines.slice(props), render);
        whole.classList.add("history-whole");
        detail.append(whole);
      } else {
        detail.append(make("pre", "history-lines history-whole", lines.join("")));
      }
    } else {
      detail.append(...drawChanges());
    }
    setBusy(false);
  }

  async function choose(id) {
    status.textContent = "";
    chosenId = id;
    ticked.clear();
    drawList();
    try {
      base = await current();
      versionText = await read(id);
      // As the page looks, versions are compared block by block, so every part is something
      // that can be shown whole; as markdown, line by line.
      parts = diffLines(base, versionText, render ? splitPageBlocks : undefined);
    } catch (error) {
      chosenId = "";
      drawList();
      detail.replaceChildren();
      status.textContent = onError(error) || h.readFailed;
      setBusy(false);
      return;
    }
    drawDetail();
  }

  async function run(text) {
    setBusy(true);
    status.textContent = "";
    try {
      await restore(text, base);
      dialog.close();
    } catch (error) {
      status.textContent = onError(error) || h.restoreFailed;
      setBusy(false);
    }
  }

  restoreAll.addEventListener("click", () => run(versionText));
  restoreChosen.addEventListener("click", () => run(applyChosen(parts, ticked)));

  try {
    versions = await list();
  } catch (error) {
    message = onError(error) || h.loadFailed;
  }
  dialog.classList.add("history-dialog");
  dialog.classList.toggle("history-as-page", Boolean(render));
  // The shown text is taken away again when the box closes, so nothing that looks like page
  // text is left behind where it cannot be seen.
  dialog.addEventListener("close", () => detail.replaceChildren(), { once: true });
  dialog.replaceChildren(make("h2", "", h.title), make("p", "setting-hint", h.hint), listBox, detail, status, foot);
  drawList();
  setBusy(false);
  if (!dialog.open) dialog.showModal();
  // With only one older version there is nothing to choose between, so it is opened at once.
  if (versions.length === 1) await choose(versions[0].id);
}
