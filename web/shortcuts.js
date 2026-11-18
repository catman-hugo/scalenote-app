// The keyboard shortcuts of the app, for the Shortcuts page in Settings and its printed sheet.
// Every entry here is a shortcut the app really has; the place it is made is noted next to each
// group, so a change there can be copied here. The words come from strings.js.

import { strings } from "./strings.js";

// [key of the description in strings.shortcuts.items, keys as shown]
export const SHORTCUTS = [
  // main.js (search, find, folder menu, zoom, this page) and the system's own print key.
  ["general", [
    ["search", "Ctrl K"],
    ["find", "Ctrl F"],
    ["folderMenu", "Ctrl Shift O"],
    ["shortcuts", "Ctrl /"],
    ["zoomIn", "Ctrl +"],
    ["zoomOut", "Ctrl −"],
    ["zoomReset", "Ctrl 0"],
    ["print", "Ctrl P"],
  ]],
  // The find bar (pagefind.js).
  ["findBar", [
    ["findNext", "Enter"],
    ["findPrevious", "Shift Enter"],
    ["findClose", "Esc"],
  ]],
  // The text editor (the editing library's own keys, inlinemarks.js and editor.js).
  ["text", [
    ["blocks", "/"],
    ["bold", "Ctrl B"],
    ["italic", "Ctrl I"],
    ["underline", "Ctrl U"],
    ["strike", "Ctrl Shift S"],
    ["code", "Ctrl E"],
    ["highlight", "Ctrl Shift H"],
    ["subscript", "Ctrl ,"],
    ["superscript", "Ctrl ."],
    ["link", "Ctrl K"],
    ["heading", "Ctrl Alt 1 … 6"],
    ["bullets", "Ctrl Shift 8"],
    ["numbers", "Ctrl Shift 7"],
    ["tasks", "Ctrl Shift 9"],
    ["quote", "Ctrl Shift B"],
    ["codeBlock", "Ctrl Alt C"],
    ["moveBlock", "Alt ↑ / Alt ↓"],
    ["undo", "Ctrl Z"],
    ["redo", "Ctrl Shift Z / Ctrl Y"],
  ]],
  // The canvas (canvasview.js).
  ["drawing", [
    ["drawUndo", "Ctrl Z"],
    ["drawRedo", "Ctrl Shift Z / Ctrl Y"],
    ["deleteSelection", "Delete"],
    ["clearSelection", "Esc"],
    ["pan", "Space + drag"],
    ["zoomSheet", "Ctrl + wheel"],
  ]],
];

/** The list as a table per group, ready to put on a page. */
export function shortcutTables() {
  const t = strings.shortcuts;
  return SHORTCUTS.map(([group, items]) => {
    const section = document.createElement("section");
    section.className = "shortcut-group";
    const heading = document.createElement("h3");
    heading.className = "setting-heading";
    heading.textContent = t.groups[group];
    const table = document.createElement("table");
    table.className = "shortcut-table";
    for (const [item, keys] of items) {
      const row = table.insertRow();
      row.insertCell().textContent = t.items[item];
      const cell = row.insertCell();
      const kbd = document.createElement("kbd");
      kbd.textContent = keys;
      cell.append(kbd);
    }
    section.append(heading, table);
    return section;
  });
}
