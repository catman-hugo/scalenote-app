// The Tags box: every tag in the notes folder with the number of pages, and the pages of the
// tag you choose. Nothing in here changes a page; opening a page closes the box.

import { buildTagList, clickTag, pageTitle, parentTags, tagRows } from "./tagindex.js";
import { icon } from "./icons.js";
import { strings } from "./strings.js";

// Drawing thousands of rows would make the box slow on a phone, so only this many are drawn.
const MAX_ROWS = 300;

function make(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function fill(text, values) {
  return text.replace(/\{(\w+)\}/g, (_, key) => String(values[key] ?? ""));
}

const countText = (n) => (n === 1 ? strings.tags.pageCountOne : fill(strings.tags.pageCount, { count: n }));

/**
 * Opens the Tags box in `dialog`. `load()` returns the page index ({ pages, truncated }),
 * `open(path)` opens a page, `onError(error)` logs a problem and returns the sentence to show,
 * and `select` is the tag to show first (when a tag in a page was clicked).
 */
export async function openTags(dialog, { load, open, onError, select }) {
  const t = strings.tags;
  let list = [];
  let truncated = false;
  let message = "";
  let selected = select ? select.replace(/^#/, "").toLowerCase() : "";
  let filter = "";
  // The main tags whose subtags are showing. Every main tag starts folded.
  let unfolded = new Set();

  const input = make("input", "tags-filter");
  // A plain text box, not type="search": in a search box the first Escape only clears the text.
  input.type = "text";
  input.autocomplete = "off";
  input.placeholder = t.filterLabel;
  input.setAttribute("aria-label", t.filterLabel);
  input.maxLength = 100;
  const listBox = make("div", "tags-list-box");

  function pageRows(item) {
    const pages = make("ul", "tag-pages");
    pages.setAttribute("aria-label", fill(t.pagesLabel, { tag: `#${item.name}` }));
    for (const path of item.pages.slice(0, MAX_ROWS)) {
      const row = make("li");
      const go = make("button", "tag-page");
      go.type = "button";
      go.append(make("span", "", pageTitle(path)));
      const folder = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
      if (folder) go.append(make("span", "tag-page-folder", folder));
      go.addEventListener("click", () => {
        dialog.close();
        open(path);
      });
      row.append(go);
      pages.append(row);
    }
    if (item.pages.length > MAX_ROWS) pages.append(make("li", "tags-note", fill(t.morePages, { count: MAX_ROWS })));
    return pages;
  }

  function drawList() {
    listBox.replaceChildren();
    if (message) {
      const problem = make("p", "tags-error", message);
      problem.setAttribute("role", "alert");
      listBox.append(problem);
    }
    if (truncated) listBox.append(make("p", "tags-note", t.truncated));
    if (!list.length) {
      if (!message) listBox.append(make("p", "tags-empty", t.empty));
      return;
    }
    const shown = tagRows(list, filter, unfolded);
    if (!shown.length) {
      listBox.append(make("p", "tags-empty", t.noMatch));
      return;
    }
    const ul = make("ul", "tags-list");
    ul.setAttribute("aria-label", t.listLabel);
    let selectedRow = null;
    for (const item of shown.slice(0, MAX_ROWS)) {
      const li = make("li");
      const open = item.key === selected;
      const row = make("button", "tag-row" + (open ? " selected" : ""));
      row.type = "button";
      // For a main tag "expanded" means its subtags are showing; for any other, its pages.
      row.setAttribute("aria-expanded", String(item.parent ? item.unfolded : open));
      row.dataset.depth = String(Math.min(item.depth, 4));
      // An arrow in front of a main tag; the same room is left in front of the others, so
      // the names line up.
      const arrow = make("span", "tag-arrow");
      if (item.parent) {
        arrow.append(icon(item.unfolded ? "chevronDown" : "chevronRight"));
        row.dataset.parent = "";
      }
      const name = make("span", "tag-label");
      name.append(arrow, make("span", "tag-name", `#${item.name}`));
      row.append(name, make("span", "tag-count", countText(item.pages.length)));
      row.addEventListener("click", () => {
        ({ unfolded, selected } = clickTag(item, unfolded, selected));
        drawList();
        // Drawing the list again makes new buttons; keep the keyboard on the one pressed.
        const again = [...listBox.querySelectorAll(".tag-row")].find((b) => b.dataset.key === item.key);
        if (again) again.focus();
      });
      row.dataset.key = item.key;
      li.append(row);
      if (open) {
        li.append(pageRows(item));
        selectedRow = row;
      }
      ul.append(li);
    }
    listBox.append(ul);
    if (shown.length > MAX_ROWS) listBox.append(make("p", "tags-note", fill(t.moreTags, { count: MAX_ROWS })));
    if (selectedRow && select) selectedRow.scrollIntoView({ block: "nearest" });
  }

  input.addEventListener("input", () => {
    filter = input.value;
    drawList();
  });

  try {
    const index = await load();
    list = buildTagList(index.pages);
    truncated = Boolean(index.truncated);
  } catch (error) {
    message = onError(error) || t.loadFailed;
  }
  // A tag that was only just typed is not in the files yet: show it in the filter instead.
  if (selected && !list.some((item) => item.key === selected)) {
    filter = selected;
    input.value = select.replace(/^#/, "");
    selected = "";
  }
  // A tag opened from a page must be in view: unfold the tags it sits in, and itself.
  if (selected) unfolded = new Set([...parentTags(selected), selected]);

  const close = make("button", "primary", t.close);
  close.type = "button";
  close.addEventListener("click", () => dialog.close());
  const foot = make("div", "dialog-actions");
  foot.append(close);
  dialog.classList.add("tags-dialog");
  dialog.replaceChildren(make("h2", "", t.title), make("p", "setting-hint", t.hint), input, listBox, foot);
  drawList();
  if (!dialog.open) dialog.showModal();
  if (!select) input.focus();
}
