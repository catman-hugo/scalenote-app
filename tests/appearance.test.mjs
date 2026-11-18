// Tests for the mode and theme-card rules in appearance.js. They call the real functions.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { DARK_THEMES, DEFAULT_APPEARANCE, LIGHT_THEMES, THEMES, THEME_KIND, applyAppearance, effectiveTheme, modeOf, normalizeAppearance, pickMode, pickTheme } from "../web/appearance.js";

// A stand-in for the <html> element: only the two attribute calls applyAppearance uses.
function fakeRoot() {
  const attrs = new Map();
  return { attrs, style: { setProperty() {} }, setAttribute: (k, v) => attrs.set(k, v), removeAttribute: (k) => attrs.delete(k) };
}

test("every theme is listed as light or dark, and True black is a dark one", () => {
  for (const t of THEMES.filter((x) => x !== "system")) assert.ok(THEME_KIND[t], t);
  assert.ok(DARK_THEMES.includes("black"));
  assert.equal(LIGHT_THEMES.length + DARK_THEMES.length, THEMES.length - 1);
});

test("the kind of each theme matches the colour scheme declared in themes.css", () => {
  const css = readFileSync(new URL("../web/themes.css", import.meta.url), "utf8");
  for (const [name, kind] of Object.entries(THEME_KIND)) {
    const block = new RegExp(`:root\\[data-theme="${name}"\\][^{]*\\{([^}]*)\\}`).exec(css);
    assert.ok(block, name);
    assert.match(block[1], new RegExp(`color-scheme:\\s*${kind}`), name);
  }
});

test("normalizing keeps the card of a fixed theme as the choice for its kind and drops bad values", () => {
  assert.deepEqual(normalizeAppearance({}), DEFAULT_APPEARANCE);
  const a = normalizeAppearance({ theme: "black", darkTheme: "forest", lightTheme: "black" });
  assert.equal(a.darkTheme, "black");
  assert.equal(a.lightTheme, "light");
  assert.equal(normalizeAppearance({ lightTheme: "midnight" }).lightTheme, "light");
});

test("modes: auto, light and dark", () => {
  assert.equal(modeOf({ theme: "system" }), "auto");
  assert.equal(modeOf({ theme: "sepia" }), "light");
  assert.equal(modeOf({ theme: "black" }), "dark");
  assert.deepEqual(pickMode({ lightTheme: "sage", darkTheme: "black" }, "dark"), { theme: "black" });
  assert.deepEqual(pickMode({ lightTheme: "sage", darkTheme: "black" }, "light"), { theme: "sage" });
  assert.deepEqual(pickMode({ theme: "black" }, "auto"), { theme: "system" });
});

test("picking a card: in Auto the mode stays, in light or dark it switches at once", () => {
  assert.deepEqual(pickTheme({ theme: "system" }, "black"), { darkTheme: "black" });
  assert.deepEqual(pickTheme({ theme: "light" }, "black"), { darkTheme: "black", theme: "black" });
  assert.deepEqual(pickTheme({ theme: "dark" }, "sepia"), { lightTheme: "sepia", theme: "sepia" });
  assert.deepEqual(pickTheme({}, "nonsense"), {});
});

test("the theme shown follows the system in Auto and ignores it otherwise", () => {
  const a = { theme: "system", lightTheme: "sage", darkTheme: "black" };
  assert.equal(effectiveTheme(a, true), "black");
  assert.equal(effectiveTheme(a, false), "sage");
  assert.equal(effectiveTheme({ theme: "sepia" }, true), "sepia");
});

test("applying: Auto always sets the card that matches the system, so Light never falls back to other colours", () => {
  const root = fakeRoot();
  applyAppearance(root, { theme: "system", lightTheme: "light", darkTheme: "dark" });
  assert.ok(["light", "dark"].includes(root.attrs.get("data-theme")), "plain Auto also sets light or dark");
  applyAppearance(root, { theme: "system", lightTheme: "light", darkTheme: "midnight" });
  assert.ok(["light", "midnight"].includes(root.attrs.get("data-theme")));
  applyAppearance(root, { theme: "black" });
  assert.equal(root.attrs.get("data-theme"), "black");
});
