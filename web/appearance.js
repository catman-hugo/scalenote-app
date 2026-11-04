// The look settings: theme, text size, editor width and list width. Kept apart from the
// screens so the rules (what values are allowed, how they reach the page) can be tested.

export const THEMES = ["system", "light", "dark", "sepia", "midnight", "sage", "forest", "lavender", "dusk"];
// Percent of the normal text size. Everything is sized in rem, so one number scales the app.
export const FONT_SIZES = [80, 90, 100, 112, 125];
// Width of the note column. "full" lets it use all the room.
export const EDITOR_WIDTHS = { narrow: "36rem", medium: "46rem", wide: "60rem", full: "none" };
export const SIDEBAR_MIN = 200;
export const SIDEBAR_MAX = 420;
export const SIDEBAR_STEP = 20;

export const DEFAULT_APPEARANCE = { theme: "system", fontSize: 100, editorWidth: "medium", sidebarWidth: 280 };

/** Reads the look settings from untrusted json: anything not allowed becomes the default. */
export function normalizeAppearance(raw) {
  const source = raw && typeof raw === "object" ? raw : {};
  const d = DEFAULT_APPEARANCE;
  const width = Number(source.sidebarWidth);
  return {
    theme: THEMES.includes(source.theme) ? source.theme : d.theme,
    fontSize: FONT_SIZES.includes(source.fontSize) ? source.fontSize : d.fontSize,
    editorWidth: Object.hasOwn(EDITOR_WIDTHS, source.editorWidth) ? source.editorWidth : d.editorWidth,
    sidebarWidth: Number.isFinite(width) ? Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, Math.round(width / SIDEBAR_STEP) * SIDEBAR_STEP)) : d.sidebarWidth,
  };
}

/** Puts the settings on the page. `root` is the <html> element. */
export function applyAppearance(root, appearance) {
  const a = normalizeAppearance(appearance);
  // With "system" there is no attribute, and style.css follows the system's light or dark setting.
  if (a.theme === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", a.theme);
  root.style.fontSize = `${a.fontSize}%`;
  root.style.setProperty("--editor-width", EDITOR_WIDTHS[a.editorWidth]);
  root.style.setProperty("--sidebar-width", `${a.sidebarWidth}px`);
}
