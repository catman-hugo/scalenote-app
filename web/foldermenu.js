// The folder menu under the folder name at the top of the page list: switch to a recent
// folder, pick another one, or go back to the default one.

import { COLOURS, COLOUR_HEX } from "./foldericons.js";
import { icon } from "./icons.js";
import { folderLabel } from "./recent.js";
import { strings } from "./strings.js";

function item(label, onPick, { current = false, title = "", colour = "none" } = {}) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "menu-item folder-menu-item";
  button.setAttribute("role", "menuitem");
  // A small square in the folder's colour, so folders can be told apart at a glance.
  const dot = document.createElement("span");
  dot.className = "folder-dot";
  if (colour !== "none" && COLOUR_HEX[colour]) dot.style.setProperty("--dot", COLOUR_HEX[colour]);
  else dot.classList.add("folder-dot-empty");
  button.append(dot);
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
export function openFolderMenu(anchor, { recent, current, colours = {}, onColour, canPick, onPick, onOther, onDefault }) {
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
    for (const path of recent) menu.append(item(folderLabel(path), run(() => onPick(path)), { current: path === current, title: path, colour: colours[path] || "none" }));
  }
  // The colour of the open folder: a row of squares, then "No colour". Picking one keeps the
  // menu open so the result is seen at once.
  if (current && onColour) {
    const label = document.createElement("div");
    label.className = "menu-label folder-menu-heading";
    label.textContent = f.colourHeading;
    const grid = document.createElement("div");
    grid.className = "icon-menu-colours folder-colours";
    const buttons = new Map();
    const paint = (now) => {
      for (const [name, button] of buttons) button.setAttribute("aria-pressed", String(name === now));
    };
    const choose = (name) => () => {
      onColour(name);
      paint(name);
      for (const dotEl of menu.querySelectorAll(".folder-menu-item[aria-current] .folder-dot")) {
        if (name === "none") {
          dotEl.style.removeProperty("--dot");
          dotEl.classList.add("folder-dot-empty");
        } else {
          dotEl.style.setProperty("--dot", COLOUR_HEX[name]);
          dotEl.classList.remove("folder-dot-empty");
        }
      }
    };
    for (const name of COLOURS) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "icon-menu-colour";
      button.dataset.folderColour = name;
      button.title = strings.folderIcon.colours[name];
      button.setAttribute("aria-label", strings.folderIcon.colours[name]);
      button.style.setProperty("--swatch", COLOUR_HEX[name]);
      button.addEventListener("click", choose(name));
      grid.append(button);
      buttons.set(name, button);
    }
    const none = document.createElement("button");
    none.type = "button";
    none.className = "menu-item icon-menu-none";
    none.dataset.folderColour = "none";
    none.textContent = f.colourNone;
    none.addEventListener("click", choose("none"));
    buttons.set("none", none);
    paint(colours[current] || "none");
    menu.append(label, grid, none);
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
