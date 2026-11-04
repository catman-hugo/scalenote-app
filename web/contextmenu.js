// A small menu that opens at the pointer (right-click, long press on a touch screen, or the
// menu key) for one entry in the page list. It only holds the actions that exist today.

import { strings } from "./strings.js";

/**
 * Opens a menu at (x, y). `items` is a list of { label, run, indent } (indent is how many levels to push it in). Returns a function that closes it.
 * Closes on Escape, a click or touch outside, or after an item is chosen.
 */
export function openContextMenu(x, y, items, { returnFocus = null, label = strings.contextMenu.label } = {}) {
  const menu = document.createElement("div");
  menu.className = "gutter-menu context-menu";
  menu.setAttribute("role", "menu");
  menu.setAttribute("aria-label", label);

  let closed = false;
  const close = (refocus = true) => {
    if (closed) return;
    closed = true;
    document.removeEventListener("pointerdown", outside, true);
    document.removeEventListener("keydown", keys, true);
    window.removeEventListener("blur", close);
    menu.remove();
    if (refocus && returnFocus && returnFocus.isConnected) returnFocus.focus();
  };
  function outside(event) {
    if (!menu.contains(event.target)) close(false);
  }
  function keys(event) {
    if (event.key === "Escape") {
      event.preventDefault();
      close();
    } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const buttons = [...menu.querySelectorAll("button")];
      const at = buttons.indexOf(document.activeElement);
      buttons[(at + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length].focus();
    }
  }

  for (const entry of items) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "menu-item";
    button.setAttribute("role", "menuitem");
    button.textContent = entry.label;
    if (entry.indent) button.style.paddingLeft = `calc(var(--space-3) + ${entry.indent} * var(--space-3))`;
    // The menu is closed before the action runs, so an action that opens an input can take the focus.
    button.addEventListener("click", () => {
      close(false);
      entry.run();
    });
    menu.append(button);
  }

  document.body.append(menu);
  // Keep the menu inside the window, also when the entry is near the right or bottom edge.
  menu.style.left = `${Math.max(8, Math.min(x, window.innerWidth - menu.offsetWidth - 8))}px`;
  menu.style.top = `${Math.max(8, Math.min(y, window.innerHeight - menu.offsetHeight - 8))}px`;
  document.addEventListener("pointerdown", outside, true);
  document.addEventListener("keydown", keys, true);
  window.addEventListener("blur", close);
  menu.querySelector("button")?.focus();
  return close;
}
