// The folder menu under the folder name at the top of the page list: switch to a recent
// folder, pick another one, or go back to the default one.

import { icon } from "./icons.js";
import { folderLabel } from "./recent.js";
import { strings } from "./strings.js";

function item(label, onPick, { current = false, title = "" } = {}) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "menu-item folder-menu-item";
  button.setAttribute("role", "menuitem");
  const text = document.createElement("span");
  text.className = "folder-menu-label";
  text.textContent = label;
  button.append(text);
  if (title) button.title = title;
  if (current) {
    button.setAttribute("aria-current", "true");
    button.append(icon("check"));
  }
  button.addEventListener("click", onPick);
  return button;
}

/**
 * Opens the menu under `anchor`. `recent` is a list of paths, `current` the open folder.
 * `onPick(path)`, `onOther()` and `onDefault()` do the work. Returns a function that closes it.
 */
export function openFolderMenu(anchor, { recent, current, canPick, onPick, onOther, onDefault }) {
  const f = strings.folders;
  const menu = document.createElement("div");
  menu.className = "gutter-menu folder-menu";
  menu.setAttribute("role", "menu");
  menu.setAttribute("aria-label", f.switchLabel);

  const close = () => {
    document.removeEventListener("pointerdown", outside, true);
    document.removeEventListener("keydown", keys, true);
    menu.remove();
    anchor.setAttribute("aria-expanded", "false");
    anchor.focus();
  };
  const run = (action) => () => {
    close();
    action();
  };
  function outside(event) {
    if (!menu.contains(event.target) && !anchor.contains(event.target)) close();
  }
  function keys(event) {
    if (event.key === "Escape") {
      event.preventDefault();
      close();
    } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const items = [...menu.querySelectorAll("button")];
      const at = items.indexOf(document.activeElement);
      const next = (at + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
      items[next].focus();
    }
  }

  if (recent.length) {
    const heading = document.createElement("div");
    heading.className = "menu-label folder-menu-heading";
    heading.textContent = f.recent;
    menu.append(heading);
    for (const path of recent) menu.append(item(folderLabel(path), run(() => onPick(path)), { current: path === current, title: path }));
  }
  const rule = document.createElement("div");
  rule.className = "menu-label folder-menu-heading";
  menu.append(rule);
  if (canPick) menu.append(item(f.openOther, run(onOther)));
  menu.append(item(f.useDefault, run(onDefault)));

  document.body.append(menu);
  anchor.setAttribute("aria-expanded", "true");
  const box = anchor.getBoundingClientRect();
  menu.style.left = `${Math.max(8, Math.min(box.left, window.innerWidth - menu.offsetWidth - 8))}px`;
  menu.style.top = `${Math.min(box.bottom + 4, Math.max(8, window.innerHeight - menu.offsetHeight - 8))}px`;
  document.addEventListener("pointerdown", outside, true);
  document.addEventListener("keydown", keys, true);
  const first = menu.querySelector("button");
  if (first) first.focus();
  return close;
}
