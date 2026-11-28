// Rules for the settings that belong to starting the app and to "Reset to defaults". Kept apart
// from the screens so they can be tested on their own.

import { DEFAULT_APPEARANCE } from "./appearance.js";

const CONTROL = /[\u0000-\u001f\u007f]/;

/** Reads "the page that was open last" from untrusted json: a folder and a page path, both plain text. */
export function cleanLastPage(raw) {
  if (!raw || typeof raw !== "object") return null;
  const { vault, path } = raw;
  const usable = (text) => typeof text === "string" && text.length > 0 && text.length <= 1024 && !CONTROL.test(text);
  if (!usable(vault) || !usable(path) || !path.endsWith(".md") || path.split("/").includes("..")) return null;
  return { vault, path };
}

// What "Reset to defaults" puts back. Not in the list on purpose: the open folder and recent
// folders, which devices are paired, what has been read or dismissed (the disclosure, the update
// notes), and the page that was open last. Resetting the look must never change what is stored
// or paired. What each page remembers (its view, its Linked from) is not a setting and stays.
export const RESETTABLE = {
  ...DEFAULT_APPEARANCE,
  updates: true,
  penButton: "erase",
  penKeyDown: "none",
  penKeyUp: "none",
  openIn: "text",
  snapShapes: true,
  pictureInk: false,
  onionSkin: false,
  canvasEdge: "open",
  reopenLast: true,
  showWhatsNew: true,
};

/** A copy of `settings` with the resettable ones at their defaults and everything else untouched. */
export function resetSettings(settings) {
  return { ...settings, ...RESETTABLE };
}
