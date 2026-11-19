// The settings dialog. Changes are applied as they are made and handed to `onChange`,
// which saves them. Nothing here is typed text: every label comes from strings.js.

import { DARK_THEMES, EDITOR_WIDTHS, FONT_SIZES, LIGHT_THEMES, ZOOMS, SIDEBAR_MAX, SIDEBAR_MIN, SIDEBAR_STEP, modeOf, normalizeAppearance, pickMode, pickTheme } from "./appearance.js";
import { strings } from "./strings.js";
import { addLayer } from "./backlayers.js";

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

// The mode switch (Auto, Light, Dark) and the theme cards. Each card shows the theme's own colours in a
// small swatch (themes.css paints it through data-card). The chosen card of each kind is marked, so True
// black is listed under Dark themes where it can be seen instead of hidden in a drop-down.
function themePicker(state, change) {
  const s = strings.settings;
  const box = make("div", "setting-row theme-picker");
  const modeLabel = make("span", "setting-label", s.mode);
  const modes = make("div", "mode-switch");
  modes.setAttribute("role", "radiogroup");
  modes.setAttribute("aria-label", s.mode);
  const cards = make("div", "theme-groups");

  const paint = () => {
    const a = normalizeAppearance(state());
    const mode = modeOf(a);
    for (const button of modes.children) button.setAttribute("aria-checked", String(button.dataset.mode === mode));
    for (const card of cards.querySelectorAll(".theme-card")) {
      const name = card.dataset.theme;
      const chosen = a.theme === name || (a.theme === "system" && (a.lightTheme === name || a.darkTheme === name));
      card.setAttribute("aria-checked", String(chosen));
    }
  };
  for (const mode of ["auto", "light", "dark"]) {
    const button = make("button", "mode-option", s.modes[mode]);
    button.type = "button";
    button.dataset.mode = mode;
    button.setAttribute("role", "radio");
    button.addEventListener("click", () => {
      change(pickMode(state(), mode));
      paint();
    });
    modes.append(button);
  }
  const group = (title, names) => {
    const section = make("div", "theme-group");
    section.append(make("h3", "theme-group-title", title));
    const grid = make("div", "theme-grid");
    for (const name of names) {
      const card = make("button", "theme-card");
      card.type = "button";
      card.dataset.theme = name;
      card.setAttribute("role", "radio");
      const swatch = make("span", "theme-swatch");
      swatch.dataset.card = name;
      swatch.setAttribute("aria-hidden", "true");
      swatch.append(make("span", "swatch-text"), make("span", "swatch-accent"));
      card.append(swatch, make("span", "theme-name", s.themes[name]));
      card.addEventListener("click", () => {
        change(pickTheme(state(), name));
        paint();
      });
      grid.append(card);
    }
    section.append(grid);
    return section;
  };
  cards.append(group(s.lightThemes, LIGHT_THEMES), group(s.darkThemes, DARK_THEMES));
  const hint = make("p", "setting-hint", s.modeHint);
  box.append(modeLabel, modes, hint, cards);
  paint();
  return box;
}

const TAB_ORDER = ["pages", "drawing", "updates", "sync", "files", "device", "shortcuts", "about"];

// The tab that was open last, kept while the app runs so the box opens where it was left.
let lastTab = "look";
// A tab asked for from outside (Ctrl / opens Shortcuts): it opens as its own page, also on a phone.
let askedTab = null;
export function openSettingsAt(id) {
  askedTab = id;
}

/**
 * Fills the dialog and opens it. `current` is the look settings; `onChange(next)` is called after each
 * change. `groups` maps a tab name (pages, drawing, updates, sync, files) to the rows that belong on it.
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
    themePicker(() => state, change),
    field(s.fontSize, select(FONT_SIZES.map((n) => [n, s.fontSizes[n]]), state.fontSize, (v) => change({ fontSize: Number(v) }))),
    field(s.zoom, select(ZOOMS.map((n) => [n, `${n}%`]), state.zoom || 100, (v) => change({ zoom: Number(v) }))),
    make("p", "setting-hint", s.zoomHint),
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
  const asked = askedTab;
  askedTab = null;
  if (asked && tabs.some(([id]) => id === asked)) lastTab = asked;
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
  // On a phone the tabs are a full-screen list and a tab opens as its own page with a Back button.
  // style.css reads data-view; on a wide screen the attribute has no effect.
  // On a phone an open group is a layer of its own (backlayers.js), so the back gesture returns
  // to the list instead of closing Settings. On a wide screen there is no list to go back to.
  let leaveGroup = null;
  const phone = window.matchMedia("(max-width: 640px)");
  const setView = (view) => {
    layout.dataset.view = view;
    if (view === "page" && !leaveGroup && phone.matches) {
      leaveGroup = addLayer(() => {
        leaveGroup = null;
        layout.dataset.view = "list";
      });
    } else if (view === "list" && leaveGroup) {
      leaveGroup();
      leaveGroup = null;
    }
  };
  layout.dataset.view = asked ? "page" : "list";
  const back = make("button", "settings-back", s.back);
  back.type = "button";
  back.addEventListener("click", () => setView("list"));
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
    button.addEventListener("click", () => {
      show(id);
      setView("page");
    });
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

  // A box to find a setting by its words. While it holds text, every tab's rows that do not
  // match are hidden (with a class, so rows that hide themselves for other reasons stay as they are).
  const search = make("input", "settings-search");
  search.type = "search";
  search.id = "settingsSearch";
  search.autocomplete = "off";
  search.maxLength = 60;
  search.placeholder = s.searchPlaceholder;
  search.setAttribute("aria-label", s.search);
  const nothing = make("p", "setting-hint settings-nomatch", s.searchNone);
  nothing.hidden = true;
  const filter = () => {
    const wanted = search.value.trim().toLowerCase();
    nav.classList.toggle("is-searching", wanted !== "");
    if (wanted) setView("page");
    if (!wanted) {
      for (const rows of tabs.map(([, r]) => r)) rows.forEach((row) => row.classList.remove("search-miss"));
      nothing.hidden = true;
      show(lastTab);
      return;
    }
    let found = 0;
    for (const [id, rows] of tabs) {
      let here = 0;
      // A hint under a setting is shown with that setting and never found on its own, so a
      // paragraph about something else is not left standing alone.
      let previous = false;
      for (const row of rows) {
        const isHint = row.classList.contains("setting-hint");
        const hit = isHint ? previous : row.textContent.toLowerCase().includes(wanted);
        if (!isHint) previous = hit;
        row.classList.toggle("search-miss", !hit);
        if (hit) here += 1;
      }
      panels.get(id).hidden = here === 0;
      found += here;
    }
    for (const button of buttons.values()) button.setAttribute("aria-selected", "false");
    heading.textContent = s.searchResults;
    nothing.hidden = found > 0;
  };
  search.addEventListener("input", filter);
  search.addEventListener("keydown", (event) => {
    // Escape empties the box first; only an empty box lets Escape close the window.
    if (event.key === "Escape" && search.value) {
      event.preventDefault();
      event.stopPropagation();
      search.value = "";
      filter();
    }
  });

  const close = make("button", "primary", s.close);
  close.type = "button";
  close.addEventListener("click", () => dialog.close());
  main.append(back, search, heading, nothing, ...panels.values(), close);
  layout.append(nav, main);
  dialog.append(layout);
  show(lastTab);
  if (!dialog.open) dialog.showModal();
}
