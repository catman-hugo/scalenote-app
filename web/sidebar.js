// The note list: folders that open and close, notes that open the editor.

import { icon } from "./icons.js";
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
  return root;
}

/**
 * Draws the tree into `container`.
 * `state` holds { expanded: Set, currentPath, selectedFolder }.
 * `actions` has { openNote, toggleFolder, selectFolder, renameFolder }.
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
  container.append(renderList(root.children, state, actions));
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

  if (node.kind === "folder") {
    const open = state.expanded.has(node.path);
    item.setAttribute("aria-expanded", String(open));
    button.append(icon(open ? "chevronDown" : "chevronRight"), icon("folder"), label(node.name));
    button.title = open ? strings.sidebar.collapse : strings.sidebar.expand;
    if (state.selectedFolder === node.path) row.classList.add("selected-folder");
    button.addEventListener("click", () => actions.toggleFolder(node.path));
    button.addEventListener("dblclick", () => actions.renameFolder(node.path, button));
    row.append(button);
    item.append(row);
    if (open && node.children.length) item.append(renderList(node.children, state, actions));
  } else {
    button.append(icon("note"), label(node.name.replace(/\.md$/i, "")));
    if (state.currentPath === node.path) {
      row.classList.add("current");
      button.setAttribute("aria-current", "page");
    }
    button.addEventListener("click", () => actions.openNote(node.path));
    row.append(button);
    item.append(row);
  }
  return item;
}

function label(text) {
  const span = document.createElement("span");
  span.className = "tree-label";
  span.textContent = text;
  return span;
}
