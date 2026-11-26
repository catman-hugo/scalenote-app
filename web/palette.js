// The search and command box (Ctrl+K, or the Search button in the page list).
//
// It follows the ARIA "combobox with a listbox" pattern: the text field keeps the focus the
// whole time and points at the highlighted row with aria-activedescendant, so a screen reader
// reads the rows while the person keeps typing. Everything shown from a page (its title and
// the matching line) is put in with textContent, never as html.

import { icon } from "./icons.js";
import { strings } from "./strings.js";

const SEARCH_DELAY_MS = 150;
const SEARCH_LIMIT = 30;
const MAX_RECENT = 8;

function make(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function fill(text, values) {
  return text.replace(/\{(\w+)\}/g, (_, key) => String(values[key] ?? ""));
}

function titleOf(path) {
  return path.slice(path.lastIndexOf("/") + 1).replace(/\.md$/i, "");
}

function folderOf(path) {
  const slash = path.lastIndexOf("/");
  return slash === -1 ? "" : path.slice(0, slash);
}

// A command matches when every word of the query is in its name.
function commandMatches(command, query) {
  const label = command.label.toLowerCase();
  return query.toLowerCase().split(/\s+/).filter(Boolean).every((word) => label.includes(word));
}

/**
 * Opens the box in `dialog`.
 * `recent()` gives page paths opened in this session (newest first), `commands` is a list of
 * { label, run }, `search(query)` resolves to { hits, truncated, notHere, notHereCount } and
 * `openPage(path, away)` opens one (`away`: it is not on this device). `searchElsewhere(query)`, when given, asks the person's other devices
 * to search the text of the pages that are not here (0.6.5): [{ device, hits, truncated }].
 */
export function openPalette(dialog, { recent, commands, search, openPage, searchElsewhere }) {
  const s = strings.search;
  dialog.replaceChildren();
  dialog.classList.add("palette");
  dialog.setAttribute("aria-label", s.title);

  const input = make("input", "palette-input");
  input.type = "text";
  input.autocomplete = "off";
  input.spellcheck = false;
  input.maxLength = 200;
  input.placeholder = s.placeholder;
  input.setAttribute("role", "combobox");
  input.setAttribute("aria-label", s.inputLabel);
  input.setAttribute("aria-expanded", "true");
  input.setAttribute("aria-controls", "palette-list");
  input.setAttribute("aria-autocomplete", "list");
  const list = make("ul", "palette-list");
  list.id = "palette-list";
  list.setAttribute("role", "listbox");
  list.setAttribute("aria-label", s.listLabel);
  // Read aloud when the results change; hidden from the screen.
  const status = make("p", "visually-hidden");
  status.setAttribute("role", "status");
  const note = make("p", "palette-note");
  const foot = make("p", "palette-hint", s.hint);
  dialog.append(input, list, note, status, foot);

  let rows = []; // { node, run }
  let active = -1;
  let pages = []; // page hits for the current query
  let truncated = false;
  // Pages not on this device: those whose title fits, and how many there are at all (0.6.5).
  let notHere = [];
  let notHereCount = 0;
  // Asking the other devices: idle, asking, done or failed, with what each device found.
  let elsewhere = { state: "idle", groups: [] };
  let failed = false;
  let searching = false;
  let counter = 0; // answers that arrive late for an older query are thrown away
  let timer = null;
  let latest = null; // the search that was started last

  function setActive(at, scroll = true) {
    active = rows.length ? (at + rows.length) % rows.length : -1;
    rows.forEach((row, i) => {
      row.node.setAttribute("aria-selected", String(i === active));
      row.node.classList.toggle("active", i === active);
    });
    if (active >= 0) {
      input.setAttribute("aria-activedescendant", rows[active].node.id);
      if (scroll) rows[active].node.scrollIntoView({ block: "nearest" });
    } else {
      input.removeAttribute("aria-activedescendant");
    }
  }

  function choose(run) {
    dialog.close();
    run();
  }

  function addHeading(text) {
    const heading = make("li", "palette-heading", text);
    heading.setAttribute("role", "presentation");
    list.append(heading);
  }

  // `keepOpen`: the row does its job without closing the box (asking other devices).
  function addRow(node, run, keepOpen = false) {
    node.id = `palette-row-${rows.length}`;
    node.setAttribute("role", "option");
    node.setAttribute("aria-selected", "false");
    if (keepOpen) node.dataset.keepOpen = "1";
    node.addEventListener("click", () => (keepOpen ? run() : choose(run)));
    node.addEventListener("pointermove", () => {
      const at = rows.findIndex((r) => r.node === node);
      if (at !== active) setActive(at, false);
    });
    list.append(node);
    rows.push({ node, run });
  }

  function pageRow(path, snippet, away = false) {
    const row = make("li", "palette-row");
    const folder = folderOf(path);
    const title = make("span", "palette-title", titleOf(path));
    if (away) {
      // Not on this device: opening it brings it from another device.
      const cloud = icon("cloud");
      cloud.classList.add("palette-cloud");
      title.append(cloud);
      row.dataset.away = "1";
    }
    row.append(title, make("span", "palette-where", folder || s.topLevel));
    if (snippet && snippet.length) {
      const line = make("span", "palette-snippet");
      for (const [text, matched] of snippet) line.append(matched ? make("mark", "", text) : document.createTextNode(text));
      row.append(line);
    }
    row.title = away ? s.notHereTitle : fill(s.inFolder, { folder: folder || s.topLevel });
    addRow(row, () => openPage(path, away));
  }

  async function askElsewhere(query) {
    const mine = counter;
    elsewhere = { state: "asking", groups: [] };
    render();
    try {
      const groups = await searchElsewhere(query);
      if (mine !== counter) return;
      elsewhere = { state: "done", groups: groups || [] };
    } catch {
      if (mine !== counter) return;
      elsewhere = { state: "failed", groups: [] };
    }
    render();
  }

  function elsewhereNote() {
    if (elsewhere.state === "asking") return s.asking;
    if (elsewhere.state === "failed") return s.noDevice;
    if (elsewhere.state === "done" && !elsewhere.groups.some((g) => g.hits.length)) return s.nothingElsewhere;
    if (elsewhere.state === "idle" && notHereCount) return fill(s.onlyHere, { count: notHereCount });
    return "";
  }

  function commandRow(command) {
    addRow(make("li", "palette-row palette-command", command.label), command.run);
  }

  function render() {
    const query = input.value.trim();
    list.replaceChildren();
    rows = [];
    if (!query) {
      const recentPaths = recent().slice(0, MAX_RECENT);
      if (recentPaths.length) addHeading(s.recentHeading);
      for (const path of recentPaths) pageRow(path, null);
      addHeading(s.commandsHeading);
      for (const command of commands) commandRow(command);
    } else {
      if (pages.length) addHeading(s.pagesHeading);
      for (const hit of pages) pageRow(hit.path, hit.snippet);
      const shown = new Set();
      for (const group of elsewhere.groups) {
        const hits = group.hits.filter((h) => !shown.has(h.path));
        if (!hits.length) continue;
        addHeading(fill(s.foundOn, { device: group.device }));
        for (const hit of hits) {
          shown.add(hit.path);
          pageRow(hit.path, hit.snippet, true);
        }
      }
      const titlesOnly = notHere.filter((h) => !shown.has(h.path));
      if (titlesOnly.length) addHeading(s.notHereHeading);
      for (const hit of titlesOnly) pageRow(hit.path, null, true);
      if (searchElsewhere && notHereCount && elsewhere.state === "idle" && !searching) {
        addRow(make("li", "palette-row palette-command palette-elsewhere", s.askElsewhere), () => askElsewhere(query), true);
      }
      const matching = commands.filter((c) => commandMatches(c, query));
      if (matching.length) addHeading(s.commandsHeading);
      for (const command of matching) commandRow(command);
    }
    const away = query && !failed ? elsewhereNote() : "";
    note.textContent = failed ? s.failed : truncated && query ? s.partial : away || (!rows.length && query && !searching ? s.nothingFound : "");
    note.hidden = !note.textContent;
    status.textContent = searching ? s.searching : query ? (rows.length === 1 ? s.oneResult : fill(s.resultCount, { count: rows.length })) : "";
    setActive(rows.length ? 0 : -1);
  }

  function runSearch(query) {
    latest = searchNow(query);
    return latest;
  }

  async function searchNow(query) {
    const mine = ++counter;
    searching = true;
    try {
      const result = await search(query);
      if (mine !== counter) return;
      pages = result.hits;
      truncated = result.truncated;
      notHere = result.notHere || [];
      notHereCount = result.notHereCount || 0;
      elsewhere = { state: "idle", groups: [] };
      failed = false;
    } catch {
      if (mine !== counter) return;
      pages = [];
      truncated = false;
      notHere = [];
      notHereCount = 0;
      failed = true;
    }
    searching = false;
    render();
  }

  input.addEventListener("input", () => {
    clearTimeout(timer);
    const query = input.value.trim();
    if (!query) {
      counter++; // anything still on its way is no longer wanted
      pages = [];
      notHere = [];
      notHereCount = 0;
      elsewhere = { state: "idle", groups: [] };
      truncated = false;
      failed = false;
      searching = false;
      render();
      return;
    }
    // Commands show at once; the pages follow when the person stops typing for a moment.
    searching = true;
    pages = [];
    notHere = [];
    elsewhere = { state: "idle", groups: [] };
    counter++; // an answer from the other devices for the old words is no longer wanted
    render();
    timer = setTimeout(() => {
      timer = null;
      runSearch(query);
    }, SEARCH_DELAY_MS);
  });

  input.addEventListener("keydown", async (event) => {
    if (event.isComposing) return; // a word still being composed (Japanese, Chinese) is not ours
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      setActive(active + (event.key === "ArrowDown" ? 1 : -1));
    } else if (event.key === "Enter") {
      event.preventDefault();
      // Enter straight after typing must open the page that was typed for, not whatever row
      // happens to be there while the search is still running: wait for the answer first.
      if (searching) {
        if (timer) {
          clearTimeout(timer);
          timer = null;
          runSearch(input.value.trim());
        }
        await latest;
        if (!dialog.open) return;
      }
      if (active >= 0) {
        const row = rows[active];
        if (row.node.dataset.keepOpen) row.run();
        else choose(row.run);
      }
    }
  });

  // The box is left as it is. The close event arrives a moment after closing, and the same
  // dialog element is used again, so an event from the earlier closing can arrive after the box
  // was opened anew. If it were obeyed it would cancel the new box's search and leave it on
  // "Searching" for good, so an event that arrives while the box is open is ignored.
  const onClose = () => {
    if (dialog.open) return;
    dialog.removeEventListener("close", onClose);
    clearTimeout(timer);
    counter++;
  };
  dialog.addEventListener("close", onClose);

  render();
  dialog.showModal();
  input.focus();
}

export { SEARCH_LIMIT };
