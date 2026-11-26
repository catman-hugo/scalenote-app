import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { INK_CONTRAST, PAGE_COLOURS, PEN_COLOURS, pageFill, readableInk } from "../web/canvasrules.js";

// The real colours: the pen palette from style.css and every theme's background from themes.css.
const styleCss = fs.readFileSync(new URL("../web/style.css", import.meta.url), "utf8");
const themesCss = fs.readFileSync(new URL("../web/themes.css", import.meta.url), "utf8");
const pens = Object.fromEntries(PEN_COLOURS.filter((n) => n !== "ink").map((n) => [n, new RegExp(`--pen-${n}: (#[0-9a-f]{6})`, "i").exec(styleCss)[1]]));
const themes = [...themesCss.matchAll(/:root\[data-theme="(\w+)"\][^{]*\{([^}]*)\}/g)].map(([, name, body]) => ({
  name,
  dark: /color-scheme: dark/.test(body),
  bg: /--bg: (#[0-9a-f]{6})/i.exec(body)[1],
}));

const rgb = (hex) => [1, 3, 5].map((at) => parseInt(hex.slice(at, at + 2), 16));
const lum = (hex) => {
  const c = rgb(hex).map((v) => (v / 255 <= 0.03928 ? v / 255 / 12.92 : ((v / 255 + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
};
const ratio = (a, b) => (Math.max(lum(a), lum(b)) + 0.05) / (Math.min(lum(a), lum(b)) + 0.05);

test("every pen colour can be seen on every dark theme and every dark page colour", () => {
  const dark = themes.filter((t) => t.dark);
  assert.ok(dark.length >= 4, "the dark themes were found");
  for (const theme of dark) {
    for (const page of PAGE_COLOURS) {
      const fill = pageFill(page, theme.bg);
      for (const [name, colour] of Object.entries(pens)) {
        const drawn = readableInk(colour, fill);
        assert.ok(ratio(drawn, fill) >= INK_CONTRAST - 0.01, `${name} on ${theme.name}/${page}: ${drawn} on ${fill}`);
      }
    }
  }
});

test("charcoal is drawn lighter on a dark page; colours that can already be seen stay as they are", () => {
  const darkBg = themes.find((t) => t.name === "dark").bg;
  assert.notEqual(readableInk(pens.charcoal, darkBg), pens.charcoal);
  assert.equal(readableInk(pens.yellow, darkBg), pens.yellow);
  assert.equal(readableInk(pens.silver, darkBg), pens.silver);
});

test("on light themes nothing changes, also the faint colours", () => {
  for (const theme of themes.filter((t) => !t.dark)) {
    for (const colour of Object.values(pens)) assert.equal(readableInk(colour, theme.bg), colour, theme.name);
  }
  assert.equal(readableInk("not a colour", "#000000"), "not a colour");
  assert.equal(readableInk("#373737", "rgb(0,0,0)"), "#373737", "a background that cannot be read changes nothing");
});
