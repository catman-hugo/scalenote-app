// The note list: folders that open and close, notes that open the editor.

import { icon } from "./icons.js";
import { COLOUR_HEX, has } from "./foldericons.js";
import { strings } from "./strings.js";

// Turns the flat, sorted list from Rust into nested folders.
export function buildTree(entries) {
  const root = { path: "", children: [] };
  const folders = new Map([["", root]]);
  for (const entry of entries) {
    const slash = entry.path.lastIndexOf("/");
    const parent = folders.get(slash === -1 ? "" : entry.path.slice(0, slash)) || root;
    const node = { ...entry, children: [] };
    parent.children.push(node);
    if (entry.kind === "folder") folders.set(entry.path, node);
  }
  // Entries that are only on other devices (offline choices) come after the list from Rust; they
  // are put in place the way Rust orders a folder: folders first, then by name.
  if (entries.some((e) => e.missing)) {
    const order = (a, b) => (a.kind === "folder") !== (b.kind === "folder") ? (a.kind === "folder" ? -1 : 1) : a.name.toLowerCase() < b.name.toLowerCase() ? -1 : a.name.toLowerCase() > b.name.toLowerCase() ? 1 : 0;
    for (const folder of folders.values()) if (folder.children.some((c) => c.missing)) folder.children.sort(order);
  }
  return root;
}

/**
 * Draws the tree into `container`.
 * `state` holds { expanded: Set, currentPath, selectedFolder, icons, shared, pinned } (icons: folder
 * path -> look; shared: the paths shared with other people; pinned: top folders that go first, in
 * that order, such as the inbox and Shared with me, so they are seen straight away).
 * `actions` has { openNote, openMissing, toggleFolder, selectFolder, renameEntry, entryMenu, trashEntry }.
 * An entry with `missing` set is on another device only: it shows a cloud icon, and a page opens
 * through `openMissing(path)`, which brings it here first.
 * `entryMenu(node, x, y, button)` opens the right-click menu; `renameEntry(node, button)` renames in place.
 */
export function renderTree(container, entries, state, actions) {
  const root = buildTree(entries);
  container.replaceChildren();
  if (root.children.length === 0) {
    const empty = document.createElement("p");
    empty.className = "tree-empty";
    empty.textContent = strings.sidebar.empty;
    container.append(empty);
    return;
  }
  container.append(renderList(pinFirst(root.children, state.pinned || []), state, actions));
}

/** The top entries with the pinned folders first, in the order given; the rest keep their order. */
export function pinFirst(nodes, pinned) {
  const first = pinned.map((path) => nodes.find((node) => node.kind === "folder" && node.path === path)).filter(Boolean);
  return [...first, ...nodes.filter((node) => !first.includes(node))];
}

// The icon of a folder: its own style and colour from the folder icon file, or the plain folder.
export function folderGlyph(look) {
  // The picture called "line" in the icon set is the drawing tool, so the bar has its own name.
  const style = look ? look.style : "folder";
  const glyph = icon(style === "line" ? "bar" : style, { filled: style === "line" });
  if (look && look.colour !== "none") glyph.style.color = COLOUR_HEX[look.colour];
  return glyph;
}

// The look of a page: the same file and the same three choices as a folder, drawn as a page.
// "folder" is the plain page, which is also what pages were given before 0.6.9 had icons for them.
export function pageGlyph(look) {
  const style = look ? look.style : "folder";
  const glyph = style === "notebook" ? icon("notebook") : style === "line" ? icon("bar", { filled: true }) : icon("note");
  if (look && look.colour !== "none") glyph.style.color = COLOUR_HEX[look.colour];
  return glyph;
}

// The space of the open/close arrow, for a row that has none (a page, an empty folder), so its icon
// lines up with the folder icons above and below it.
function arrowSpace() {
  const space = document.createElement("span");
  space.className = "tree-arrow-space";
  space.setAttribute("aria-hidden", "true");
  return space;
}

function renderList(nodes, state, actions) {
  const list = document.createElement("ul");
  list.className = "tree-list";
  list.setAttribute("role", "group");
  for (const node of nodes) list.append(renderNode(node, state, actions));
  return list;
}

function renderNode(node, state, actions) {
  const item = document.createElement("li");
  item.setAttribute("role", "treeitem");
  const row = document.createElement("div");
  row.className = "tree-row";
  const button = document.createElement("button");
  button.type = "button";
  button.className = "tree-button";
  button.dataset.path = node.path;
  button.dataset.kind = node.kind === "folder" ? "folder" : "note";

  if (node.kind === "folder") {
    const open = state.expanded.has(node.path);
    // A folder with nothing in it has nothing to open: no arrow.
    const empty = node.children.length === 0;
    if (!empty) item.setAttribute("aria-expanded", String(open));
    button.append(empty ? arrowSpace() : icon(open ? "chevronDown" : "chevronRight"), folderGlyph(state.icons && has(state.icons, node.path) ? state.icons[node.path] : null), label(node.name));
    if (!empty) button.title = open ? strings.sidebar.collapse : strings.sidebar.expand;
    if (state.selectedFolder === node.path) row.classList.add("selected-folder");
    button.addEventListener("click", () => actions.toggleFolder(node.path));
    if (!node.missing) button.addEventListener("dblclick", () => actions.renameEntry(node, button));
    markShared(node, button, state.shared);
    markMissing(node, button, row);
    row.append(button);
    item.append(row);
    if (open && node.children.length) item.append(renderList(node.children, state, actions));
  } else {
    // A page has an icon in the same icon file as the folders, keyed by its path.
    const look = state.icons && has(state.icons, node.path) ? state.icons[node.path] : null;
    button.append(arrowSpace(), pageGlyph(look), label(node.name.replace(/\.md$/i, "")));
    if (state.currentPath === node.path) {
      row.classList.add("current");
      button.setAttribute("aria-current", "page");
    }
    button.addEventListener("click", () => (node.missing && actions.openMissing ? actions.openMissing(node.path, button) : actions.openNote(node.path)));
    markShared(node, button, state.shared);
    markMissing(node, button, row);
    row.append(button);
    item.append(row);
  }
  wireEntryMenu(button, node, actions);
  return item;
}

// An entry shared with other people (0.6.4): a small people mark after its name.
function markShared(node, button, shared) {
  if (!shared || !shared.has(node.path)) return;
  button.dataset.shared = "1";
  const mark = icon("people");
  mark.classList.add("tree-shared");
  mark.setAttribute("aria-label", strings.sharing.shared);
  mark.setAttribute("role", "img");
  button.append(mark);
}

// An entry that is only on other devices: dimmed, with a cloud icon after its name.
function markMissing(node, button, row) {
  if (!node.missing) return;
  row.classList.add("tree-missing");
  button.dataset.missing = "1";
  const cloud = icon("cloud");
  cloud.classList.add("tree-cloud");
  button.append(cloud);
  button.title = strings.offline.notHere;
}

// Right-click, a long press on a touch screen and the menu key all arrive as "contextmenu".
// F2 renames the focused entry and Delete moves it to the trash, the same shortcuts file
// managers use. Delete is safe to offer on a key because the trash can give the page back.
function wireEntryMenu(button, node, actions) {
  button.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    // From the keyboard the event has no useful position, so the menu opens under the entry.
    const box = button.getBoundingClientRect();
    const fromKeyboard = event.clientX === 0 && event.clientY === 0;
    actions.entryMenu(node, fromKeyboard ? box.left + 16 : event.clientX, fromKeyboard ? box.bottom : event.clientY, button);
  });
  button.addEventListener("keydown", (event) => {
    if (event.key === "F2" && !node.missing) {
      event.preventDefault();
      actions.renameEntry(node, button);
    } else if (event.key === "Delete" && !node.missing && !event.ctrlKey && !event.altKey && !event.metaKey) {
      event.preventDefault();
      actions.trashEntry(node, button);
    }
  });
}

function label(text) {
  const span = document.createElement("span");
  span.className = "tree-label";
  span.textContent = text;
  return span;
}
