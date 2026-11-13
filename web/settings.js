// The settings dialog. Changes are applied as they are made and handed to `onChange`,
// which saves them. Nothing here is typed text: every label comes from strings.js.

import { EDITOR_WIDTHS, FONT_SIZES, SIDEBAR_MAX, SIDEBAR_MIN, SIDEBAR_STEP, THEMES } from "./appearance.js";
import { strings } from "./strings.js";

function make(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function field(labelText, control) {
  const row = make("label", "setting-row");
  row.append(make("span", "setting-label", labelText), control);
  return row;
}

function select(options, value, onPick) {
  const control = make("select");
  for (const [optionValue, text] of options) {
    const option = make("option", "", text);
    option.value = String(optionValue);
    control.append(option);
  }
  control.value = String(value);
  control.addEventListener("change", () => onPick(control.value));
  return control;
}

const TAB_ORDER = ["pages", "drawing", "updates", "files"];

// The tab that was open last, kept while the app runs so the box opens where it was left.
let lastTab = "look";

/**
 * Fills the dialog and opens it. `current` is the look settings; `onChange(next)` is called after each
 * change. `groups` maps a tab name (pages, drawing, updates, files) to the rows that belong on it.
 * The tabs are a list on the left on a wide screen and a row on top on a phone (see style.css).
 */
export function openSettings(dialog, current, onChange, groups = {}) {
  const s = strings.settings;
  let state = { ...current };
  const change = (patch) => {
    state = { ...state, ...patch };
    onChange(state);
  };

  const look = [
    field(s.theme, select(THEMES.map((t) => [t, s.themes[t]]), state.theme, (v) => change({ theme: v }))),
    field(s.fontSize, select(FONT_SIZES.map((n) => [n, s.fontSizes[n]]), state.fontSize, (v) => change({ fontSize: Number(v) }))),
    field(s.editorWidth, select(Object.keys(EDITOR_WIDTHS).map((k) => [k, s.editorWidths[k]]), state.editorWidth, (v) => change({ editorWidth: v }))),
  ];
  const slider = make("input");
  slider.type = "range";
  slider.min = String(SIDEBAR_MIN);
  slider.max = String(SIDEBAR_MAX);
  slider.step = String(SIDEBAR_STEP);
  slider.value = String(state.sidebarWidth);
  slider.addEventListener("input", () => change({ sidebarWidth: Number(slider.value) }));
  look.push(field(s.sidebarWidth, slider));

  // A tab with no rows (the Obsidian copy is not offered on Android, say) is left out.
  const tabs = [["look", look], ...TAB_ORDER.map((id) => [id, groups[id] || []])].filter(([, rows]) => rows.length > 0);
  if (!tabs.some(([id]) => id === lastTab)) lastTab = "look";

  dialog.replaceChildren();
  dialog.classList.add("settings-dialog");
  const layout = make("div", "settings-layout");
  const nav = make("div", "settings-tabs");
  nav.setAttribute("role", "tablist");
  nav.setAttribute("aria-orientation", "vertical");
  nav.setAttribute("aria-label", s.title);
  const main = make("div", "settings-main");
  const heading = make("h2");
  const buttons = new Map();
  const panels = new Map();

  function show(id) {
    lastTab = id;
    for (const [tabId, button] of buttons) {
      const on = tabId === id;
      button.setAttribute("aria-selected", String(on));
      button.tabIndex = on ? 0 : -1;
      panels.get(tabId).hidden = !on;
    }
    heading.textContent = s.tabs[id];
  }

  for (const [id, rows] of tabs) {
    const button = make("button", "settings-tab", s.tabs[id]);
    button.type = "button";
    button.id = `settingsTab-${id}`;
    button.setAttribute("role", "tab");
    button.setAttribute("aria-controls", `settingsPanel-${id}`);
    button.addEventListener("click", () => show(id));
    buttons.set(id, button);
    nav.append(button);
    const panel = make("div", "settings-body");
    panel.id = `settingsPanel-${id}`;
    panel.setAttribute("role", "tabpanel");
    panel.setAttribute("aria-labelledby", button.id);
    panel.append(...rows);
    panels.set(id, panel);
  }
  // Up and down (left and right on a phone) move between the tabs, like the tab lists of other apps.
  nav.addEventListener("keydown", (event) => {
    const ids = [...buttons.keys()];
    const at = ids.indexOf(lastTab);
    const step = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 }[event.key];
    if (!step) return;
    event.preventDefault();
    const next = ids[(at + step + ids.length) % ids.length];
    show(next);
    buttons.get(next).focus();
  });

  const close = make("button", "primary", s.close);
  close.type = "button";
  close.addEventListener("click", () => dialog.close());
  main.append(heading, ...panels.values(), close);
  layout.append(nav, main);
  dialog.append(layout);
  show(lastTab);
  if (!dialog.open) dialog.showModal();
}
