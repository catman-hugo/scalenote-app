// The look settings: theme, text size, editor width and list width. Kept apart from the
// screens so the rules (what values are allowed, how they reach the page) can be tested.

export const THEMES = ["system", "light", "dark", "sepia", "midnight", "sage", "forest", "lavender", "dusk", "white", "black"];
// Whether each named theme is a light or a dark one. A test compares this with the colour scheme
// each block in themes.css declares. The order is the order of the cards: matching colours sit above each
// other (Sage over Forest, Lavender over Dusk) and the two true themes come last., so the two cannot drift apart.
export const THEME_KIND = { light: "light", sepia: "light", sage: "light", lavender: "light", white: "light", dark: "dark", midnight: "dark", forest: "dark", dusk: "dark", black: "dark" };
export const LIGHT_THEMES = Object.keys(THEME_KIND).filter((t) => THEME_KIND[t] === "light");
export const DARK_THEMES = Object.keys(THEME_KIND).filter((t) => THEME_KIND[t] === "dark");

// Percent of the normal text size. Everything is sized in rem, so one number scales the app.
export const FONT_SIZES = [80, 90, 100, 112, 125];
// Width of the note column. "full" lets it use all the room.
export const EDITOR_WIDTHS = { narrow: "36rem", medium: "46rem", wide: "60rem", full: "none" };
export const SIDEBAR_MIN = 200;
export const SIDEBAR_MAX = 420;
export const SIDEBAR_STEP = 20;

// `theme` is "system" (Auto) or one fixed theme. `lightTheme` and `darkTheme` are the themes used in light
// and dark mode, and by Auto when the system is light or dark.
export const DEFAULT_APPEARANCE = { theme: "system", lightTheme: "light", darkTheme: "dark", fontSize: 100, editorWidth: "medium", sidebarWidth: 280 };

/** Reads the look settings from untrusted json: anything not allowed becomes the default. */
export function normalizeAppearance(raw) {
  const source = raw && typeof raw === "object" ? raw : {};
  const d = DEFAULT_APPEARANCE;
  const width = Number(source.sidebarWidth);
  const theme = THEMES.includes(source.theme) ? source.theme : d.theme;
  // A fixed theme is also the one chosen for its kind, so the picker never shows another card as chosen.
  let lightTheme = LIGHT_THEMES.includes(source.lightTheme) ? source.lightTheme : d.lightTheme;
  let darkTheme = DARK_THEMES.includes(source.darkTheme) ? source.darkTheme : d.darkTheme;
  if (THEME_KIND[theme] === "light") lightTheme = theme;
  if (THEME_KIND[theme] === "dark") darkTheme = theme;
  return {
    theme,
    lightTheme,
    darkTheme,
    fontSize: FONT_SIZES.includes(source.fontSize) ? source.fontSize : d.fontSize,
    editorWidth: Object.hasOwn(EDITOR_WIDTHS, source.editorWidth) ? source.editorWidth : d.editorWidth,
    sidebarWidth: Number.isFinite(width) ? Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, Math.round(width / SIDEBAR_STEP) * SIDEBAR_STEP)) : d.sidebarWidth,
  };
}

/** "auto", "light" or "dark": which of the three the person picked in the mode switch. */
export function modeOf(appearance) {
  const { theme } = normalizeAppearance(appearance);
  return theme === "system" ? "auto" : THEME_KIND[theme];
}

/** The change to make when a mode is picked. Light and dark use the theme chosen for them. */
export function pickMode(appearance, mode) {
  const a = normalizeAppearance(appearance);
  if (mode === "light") return { theme: a.lightTheme };
  if (mode === "dark") return { theme: a.darkTheme };
  return { theme: "system" };
}

/**
 * The change to make when a theme card is picked. The card becomes the choice for its kind. In Auto the
 * mode stays Auto (the card is used when the system is of that kind); in light or dark mode the page
 * switches to the card at once, which also changes the mode if the card is of the other kind.
 */
export function pickTheme(appearance, name) {
  const a = normalizeAppearance(appearance);
  if (!Object.hasOwn(THEME_KIND, name)) return {};
  const patch = THEME_KIND[name] === "light" ? { lightTheme: name } : { darkTheme: name };
  if (a.theme !== "system") patch.theme = name;
  return patch;
}

/** The theme the page shows now. `systemDark` says whether the system is set to dark. */
export function effectiveTheme(appearance, systemDark) {
  const a = normalizeAppearance(appearance);
  if (a.theme !== "system") return a.theme;
  return systemDark ? a.darkTheme : a.lightTheme;
}

function systemIsDark() {
  return typeof globalThis.matchMedia === "function" && globalThis.matchMedia("(prefers-color-scheme: dark)").matches;
}

/** Calls `redraw` when the system switches between light and dark (it matters in Auto). Returns a stop function. */
export function followSystem(redraw) {
  if (typeof globalThis.matchMedia !== "function") return () => {};
  const query = globalThis.matchMedia("(prefers-color-scheme: dark)");
  query.addEventListener("change", redraw);
  return () => query.removeEventListener("change", redraw);
}

/** Puts the settings on the page. `root` is the <html> element. */
export function applyAppearance(root, appearance) {
  const a = normalizeAppearance(appearance);
  // The attribute is always set, also in Auto (then from the system's light or dark setting), so
  // the Light card always looks like Light. Without it the page fell back to the older built-in
  // colours in style.css, which are nearly white, so Auto with Light and Dark looked like True white.
  root.setAttribute("data-theme", effectiveTheme(a, systemIsDark()));
  // The chosen size times the screen's own scale (style.css makes it smaller on a phone). The
  // browser works this out again whenever the window changes size or the phone is turned.
  root.style.fontSize = `calc(${a.fontSize}% * var(--screen-scale, 1))`;
  root.style.setProperty("--editor-width", EDITOR_WIDTHS[a.editorWidth]);
  root.style.setProperty("--sidebar-width", `${a.sidebarWidth}px`);
}
