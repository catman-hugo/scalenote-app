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

/** Fills the dialog and opens it. `current` is the look settings; `onChange(next)` is called after each change. */
export function openSettings(dialog, current, onChange, extra = []) {
  const s = strings.settings;
  let state = { ...current };
  const change = (patch) => {
    state = { ...state, ...patch };
    onChange(state);
  };
  dialog.replaceChildren();
  dialog.append(make("h2", "", s.title));
  const body = make("div", "settings-body");
  body.append(
    field(s.theme, select(THEMES.map((t) => [t, s.themes[t]]), state.theme, (v) => change({ theme: v }))),
    field(s.fontSize, select(FONT_SIZES.map((n) => [n, s.fontSizes[n]]), state.fontSize, (v) => change({ fontSize: Number(v) }))),
    field(s.editorWidth, select(Object.keys(EDITOR_WIDTHS).map((k) => [k, s.editorWidths[k]]), state.editorWidth, (v) => change({ editorWidth: v }))),
  );
  const slider = make("input");
  slider.type = "range";
  slider.min = String(SIDEBAR_MIN);
  slider.max = String(SIDEBAR_MAX);
  slider.step = String(SIDEBAR_STEP);
  slider.value = String(state.sidebarWidth);
  slider.addEventListener("input", () => change({ sidebarWidth: Number(slider.value) }));
  body.append(field(s.sidebarWidth, slider));
  for (const row of extra) body.append(row);
  const close = make("button", "primary", s.close);
  close.type = "button";
  close.addEventListener("click", () => dialog.close());
  dialog.append(body, close);
  if (!dialog.open) dialog.showModal();
}
