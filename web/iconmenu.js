// The menu for choosing how a folder looks: an icon style and one of sixteen colours.
// It stays open while choices are made, so a style and a colour can be tried one after the other,
// and closes with Escape or a click outside.

import { COLOURS, COLOUR_HEX, STYLES } from "./foldericons.js";
import { folderGlyph } from "./sidebar.js";
import { strings } from "./strings.js";

function heading(text) {
  const label = document.createElement("div");
  label.className = "menu-label";
  label.textContent = text;
  return label;
}

/**
 * Opens the menu at (x, y). `look` is the folder's current {style, colour}.
 * `choose(style, colour)` saves a choice and returns the look that is now in effect (or the old
 * one when saving failed). `close` is called with no argument when the menu is closed.
 */
export function openIconMenu(x, y, look, { choose, onClose, returnFocus }) {
  const t = strings.folderIcon;
  let current = { ...look };
  const menu = document.createElement("div");
  menu.className = "gutter-menu icon-menu";
  menu.setAttribute("role", "dialog");
  menu.setAttribute("aria-label", t.label);

  const styleButtons = new Map();
  const colourButtons = new Map();

  const styleRow = document.createElement("div");
  styleRow.className = "icon-menu-styles";
  for (const style of STYLES) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "icon-menu-style";
    button.dataset.iconStyle = style;
    button.title = t.styles[style];
    button.setAttribute("aria-label", t.styles[style]);
    styleRow.append(button);
    styleButtons.set(style, button);
  }

  const colourGrid = document.createElement("div");
  colourGrid.className = "icon-menu-colours";
  for (const name of COLOURS) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "icon-menu-colour";
    button.dataset.iconColour = name;
    button.title = t.colours[name];
    button.setAttribute("aria-label", t.colours[name]);
    button.style.setProperty("--swatch", COLOUR_HEX[name]);
    colourGrid.append(button);
    colourButtons.set(name, button);
  }
  const none = document.createElement("button");
  none.type = "button";
  none.className = "menu-item icon-menu-none";
  none.dataset.iconColour = "none";
  none.textContent = t.none;
  colourButtons.set("none", none);

  // Shows the current choice: the style buttons are drawn in the current colour.
  function refresh() {
    for (const [style, button] of styleButtons) {
      button.replaceChildren(folderGlyph({ style, colour: current.colour }));
      button.setAttribute("aria-pressed", String(style === current.style));
    }
    for (const [name, button] of colourButtons) button.setAttribute("aria-pressed", String(name === current.colour));
  }

  async function pick(style, colour) {
    current = (await choose(style, colour)) || current;
    refresh();
  }
  for (const [style, button] of styleButtons) button.addEventListener("click", () => pick(style, current.colour));
  for (const [name, button] of colourButtons) button.addEventListener("click", () => pick(current.style, name));

  menu.append(heading(t.style), styleRow, heading(t.colour), colourGrid, none);
  refresh();

  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    document.removeEventListener("pointerdown", outside, true);
    document.removeEventListener("keydown", keys, true);
    menu.remove();
    if (onClose) onClose(returnFocus);
  };
  function outside(event) {
    if (!menu.contains(event.target)) close();
  }
  function keys(event) {
    if (event.key === "Escape") {
      event.preventDefault();
      close();
    }
  }

  document.body.append(menu);
  menu.style.left = `${Math.max(8, Math.min(x, window.innerWidth - menu.offsetWidth - 8))}px`;
  menu.style.top = `${Math.max(8, Math.min(y, window.innerHeight - menu.offsetHeight - 8))}px`;
  document.addEventListener("pointerdown", outside, true);
  document.addEventListener("keydown", keys, true);
  styleButtons.get(current.style).focus();
  return close;
}
