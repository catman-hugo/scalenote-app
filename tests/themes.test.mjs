// Checks the theme file as data: every theme defines every colour, and the colours that carry
// text are readable (WCAG contrast). It parses web/themes.css itself, so a theme edited by
// hand is checked the same way.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { applyAppearance, DEFAULT_APPEARANCE, normalizeAppearance, THEMES } from "../web/appearance.js";

const css = fs.readFileSync(new URL("../web/themes.css", import.meta.url), "utf8");
const themes = {};
for (const [, name, body] of css.matchAll(/:root\[data-theme="([a-z]+)"\]\s*\{([^}]*)\}/g)) {
  themes[name] = Object.fromEntries([...body.matchAll(/([a-z-]+):\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));
}

const TOKENS = ["--bg", "--bg-side", "--bg-hover", "--bg-code", "--text", "--text-soft", "--line", "--accent", "--accent-text", "--accent-soft", "--warn-bg", "--warn-text", "--bad", "--kind-ok", "--kind-warn", "--kind-info", "--highlight"];

function luminance(hex) {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

test("there is a theme block for every named theme (the system choice has none)", () => {
  assert.deepEqual(Object.keys(themes).sort(), THEMES.filter((t) => t !== "system").sort());
  assert.equal(Object.keys(themes).length, 8);
});

for (const name of Object.keys(themes)) {
  test(`theme ${name}: all colours are solid and defined, and text is readable`, () => {
    const t = themes[name];
    for (const token of TOKENS) assert.match(t[token] || "", /^#[0-9a-f]{6}$/, `${name} ${token}`);
    assert.ok(["light", "dark"].includes(t["color-scheme"]));
    const surfaces = ["--bg", "--bg-side", "--bg-hover"];
    for (const surface of surfaces) {
      for (const token of ["--text", "--text-soft", "--accent", "--bad", "--kind-ok", "--kind-warn", "--kind-info"]) {
        const need = token === "--text" ? 7 : 4.5;
        assert.ok(contrast(t[token], t[surface]) >= need, `${name}: ${token} on ${surface} is ${contrast(t[token], t[surface]).toFixed(2)}`);
      }
    }
    assert.ok(contrast(t["--accent-text"], t["--accent"]) >= 4.5, `${name}: text on accent`);
    assert.ok(contrast(t["--warn-text"], t["--warn-bg"]) >= 4.5, `${name}: warning text`);
    assert.ok(contrast(t["--text"], t["--accent-soft"]) >= 7, `${name}: text on soft accent`);
    assert.ok(contrast(t["--text"], t["--bg-code"]) >= 7, `${name}: text on code background`);
    assert.ok(contrast(t["--text"], t["--highlight"]) >= 7, `${name}: text on highlight`);
    // The border has to be visible against the page, but is not text.
    assert.ok(contrast(t["--line"], t["--bg"]) >= 1.2, `${name}: border visible`);
  });
}

test("no theme uses a gradient, glow, blur or translucent colour", () => {
  assert.doesNotMatch(css, /gradient|blur|rgba?\(|box-shadow|text-shadow/);
});

test("look settings from an untrusted file fall back to safe values", () => {
  assert.deepEqual(normalizeAppearance(undefined), DEFAULT_APPEARANCE);
  assert.deepEqual(normalizeAppearance({ theme: "<script>", fontSize: 9999, editorWidth: "__proto__", sidebarWidth: "wide" }), DEFAULT_APPEARANCE);
  assert.equal(normalizeAppearance({ sidebarWidth: 5 }).sidebarWidth, 200);
  assert.equal(normalizeAppearance({ sidebarWidth: 99999 }).sidebarWidth, 420);
  assert.equal(normalizeAppearance({ theme: "sage" }).theme, "sage");
  assert.equal(normalizeAppearance("text").theme, "system");
});

test("applying the settings sets the theme attribute and removes it for the system choice", () => {
  const attrs = new Map();
  const props = new Map();
  const root = { style: { fontSize: "", setProperty: (k, v) => props.set(k, v) }, setAttribute: (k, v) => attrs.set(k, v), removeAttribute: (k) => attrs.delete(k) };
  applyAppearance(root, { theme: "lavender", fontSize: 125, editorWidth: "wide", sidebarWidth: 300 });
  assert.equal(attrs.get("data-theme"), "lavender");
  assert.equal(root.style.fontSize, "125%");
  assert.equal(props.get("--editor-width"), "60rem");
  assert.equal(props.get("--sidebar-width"), "300px");
  applyAppearance(root, { theme: "system" });
  assert.equal(attrs.has("data-theme"), false);
});
