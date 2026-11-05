// Tests the real rules for text styles (web/inlinestyles.js) and checks the palette as data against
// the theme file and the stylesheet, so a colour that became unreadable or lost its CSS fails here.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { PALETTE, colorOpenTag, hasStyleSyntax, paletteEntry, sameStyles, styleSignature, withoutStyleSyntax } from "../web/inlinestyles.js";
import { strings } from "../web/strings.js";

const themesCss = fs.readFileSync(new URL("../web/themes.css", import.meta.url), "utf8");
const styleCss = fs.readFileSync(new URL("../web/style.css", import.meta.url), "utf8");

function luminance(hex) {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
const contrast = (a, b) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

test("the palette is eight distinct lower-case colour codes with names and labels", () => {
  assert.equal(PALETTE.length, 8);
  assert.equal(new Set(PALETTE.map((c) => c.hex)).size, 8);
  assert.equal(new Set(PALETTE.map((c) => c.name)).size, 8);
  for (const { name, hex } of PALETTE) {
    assert.match(hex, /^#[0-9a-f]{6}$/);
    assert.ok(strings.format.colours[name], `a label for ${name}`);
  }
  assert.deepEqual(Object.keys(strings.format.colours).sort(), PALETTE.map((c) => c.name).sort());
});

test("only palette colours are known, in any letter case", () => {
  assert.equal(paletteEntry("#F72525").name, "red");
  assert.equal(paletteEntry("#123456"), null);
  assert.equal(paletteEntry(null), null);
  assert.equal(paletteEntry("red"), null);
  assert.equal(colorOpenTag("#f72525"), '<span style="color: #f72525">');
});

test("every palette colour is readable on every theme background and on the system defaults", () => {
  const backgrounds = [...themesCss.matchAll(/--bg:\s*(#[0-9a-f]{6});/g)].map((m) => m[1]);
  assert.equal(backgrounds.length, 8, "eight themes");
  // The two system defaults in style.css: the first --bg is light, the one in the dark media query is dark.
  backgrounds.push(...[...styleCss.matchAll(/--bg:\s*(#[0-9a-f]{6});/g)].map((m) => m[1]));
  assert.ok(backgrounds.length >= 10);
  for (const { name, hex } of PALETTE) {
    for (const bg of backgrounds) assert.ok(contrast(hex, bg) >= 3.4, `${name} ${hex} on ${bg} is ${contrast(hex, bg).toFixed(2)}`);
  }
});

test("the stylesheet draws every palette colour, as text and as a swatch, with the same code", () => {
  for (const { name, hex } of PALETTE) {
    assert.ok(styleCss.includes(`.tc-${name} { color: ${hex}; }`), `.tc-${name}`);
    assert.ok(styleCss.includes(`.swatch-${name} { background: ${hex}; }`), `.swatch-${name}`);
  }
});

test("style markers are found, and taking them out leaves the text they wrap", () => {
  assert.equal(hasStyleSyntax("plain text"), false);
  assert.equal(hasStyleSyntax("a ==b== c"), true);
  assert.equal(hasStyleSyntax("a <U>b</U>"), true);
  assert.equal(hasStyleSyntax("a == b == c"), false, "spaced == is not a highlight");
  assert.equal(withoutStyleSyntax("a ==b== <u>c</u> <sub>d</sub><sup>e</sup>"), "a b c de");
  assert.equal(withoutStyleSyntax('<span style="color:#F72525;">x</span>'), "x");
  assert.equal(withoutStyleSyntax("a <b>b</b> ==c =="), "a <b>b</b> ==c ==", "other html and malformed highlights stay");
  assert.equal(withoutStyleSyntax("==x = 5=="), "x = 5");
});

test("the signature is the style markers in order, in one spelling", () => {
  assert.deepEqual(styleSignature("a <U>b</u> ==c== <sub>d</sub>"), ["<u>", "</u>", "<h>", "</h>", "<sub>", "</sub>"]);
  assert.deepEqual(styleSignature('<span style="color:#F72525;">x</span>'), ["<c:#f72525>", "</c>"]);
  assert.deepEqual(styleSignature("==a <u>b</u>=="), ["<h>", "<u>", "</u>", "</h>"]);
  assert.deepEqual(styleSignature("no styles, a == b"), []);
});

test("two texts have the same styles when the markers match, whatever the spelling", () => {
  assert.ok(sameStyles('<span style="color:#F72525">x</span> y', '<span style="color: #f72525">x</span> y'));
  assert.ok(sameStyles("a <U>b</U>", "a <u>b</u>"));
  assert.ok(!sameStyles("a <u>b c", "a b c"), "a lost marker is seen");
  assert.ok(!sameStyles("<u>a <sub>b</u> c</sub>", "<u>a b</u> c"), "a crossed pair changed by the editor is seen");
  assert.ok(!sameStyles('<span style="color:#123456">x</span>', "x"), "a colour outside the palette is seen");
});
