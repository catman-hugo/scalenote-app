// Tests the real rules for text styles (web/inlinestyles.js) and checks the colour palette as data
// against the theme file, the stylesheet and the Rust converter, so a colour that became unreadable,
// lost its CSS or is missing in the Obsidian copy fails here.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { COLOURS, LEGACY_TEXT_HEX, colourOpenTag, hasStyleSyntax, isColour, parseColourTag, sameStyles, styleSignature, withoutStyleSyntax } from "../web/inlinestyles.js";
import { strings } from "../web/strings.js";

const themesCss = fs.readFileSync(new URL("../web/themes.css", import.meta.url), "utf8");
const styleCss = fs.readFileSync(new URL("../web/style.css", import.meta.url), "utf8");
const obsidianRs = fs.readFileSync(new URL("../src-tauri/core/src/obsidian.rs", import.meta.url), "utf8");

function luminance(hex) {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
const contrast = (a, b) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

// The themes: name, light or dark, and their own colours, read from themes.css as data.
const themes = {};
for (const [, name, body] of themesCss.matchAll(/:root\[data-theme="([a-z]+)"\]\s*\{([^}]*)\}/g)) {
  themes[name] = Object.fromEntries([...body.matchAll(/([a-z-]+):\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));
}
const schemeOf = (scheme) => Object.entries(themes).filter(([, t]) => t["color-scheme"] === scheme).map(([name]) => name);

// The colour variables in style.css: the light set, the dark set for a dark system, and the
// selector lists that decide which named themes get which set.
function setsFrom(body) {
  return Object.fromEntries([...body.matchAll(/--sn-(text|bg)-([a-z]+):\s*(#[0-9a-f]{6});/g)].map((m) => [`${m[1]}-${m[2]}`, m[3]]));
}
const lightRule = /(:root,[^{]*)\{([^}]*--sn-text-gray[^}]*)\}/.exec(styleCss);
const darkMedia = /@media \(prefers-color-scheme: dark\) \{\s*:root \{([^}]*--sn-text-gray[^}]*)\}/.exec(styleCss);
const darkRule = /(:root\[data-theme="dark"\][^{]*)\{([^}]*--sn-text-gray[^}]*)\}/.exec(styleCss);
const LIGHT = setsFrom(lightRule[2]);
const DARK = setsFrom(darkRule[2]);
const themeNamesIn = (selectors) => [...selectors.matchAll(/data-theme="([a-z]+)"/g)].map((m) => m[1]).sort();

// What Notion's palette looks like (measured from its own screenshots, in light and dark).
// ScaleNote uses these shades; the text shades listed in NUDGED were moved a little so they stay
// readable on all of ScaleNote's themes (Notion's own orange, yellow and green text is too faint on
// some of them).
const NOTION = {
  text: { gray: "#7d7a75", brown: "#9f765a", orange: "#d27b2d", yellow: "#cb9434", green: "#50946e", blue: "#387dc9", purple: "#9a6bb4", pink: "#c14c8a", red: "#cf5148" },
  bgLight: { gray: "#f0efed", brown: "#f5ede9", orange: "#fbebde", yellow: "#f9f3dc", green: "#e8f1ec", blue: "#e5f2fc", purple: "#f3ebf9", pink: "#fae9f1", red: "#fce9e7" },
  bgDark: { gray: "#383836", brown: "#45362d", orange: "#53361f", yellow: "#504425", green: "#263d30", blue: "#233850", purple: "#3c2d47", pink: "#4e2b3c", red: "#502c29" },
};
const NUDGED = { light: ["orange", "yellow", "green"], dark: ["gray", "blue", "pink", "red"] };

test("the colours are Notion's nine, each with a label for text and for background", () => {
  assert.deepEqual(COLOURS, ["gray", "brown", "orange", "yellow", "green", "blue", "purple", "pink", "red"]);
  for (const name of [...COLOURS, "default"]) {
    assert.ok(strings.format.textColours[name], `text label ${name}`);
    assert.ok(strings.format.backgroundColours[name], `background label ${name}`);
  }
  assert.equal(Object.keys(strings.format.textColours).length, 10);
  assert.equal(Object.keys(strings.format.backgroundColours).length, 10);
  assert.equal(isColour("red"), true);
  assert.equal(isColour("chartreuse"), false);
  assert.equal(isColour("default"), false, "default means no colour and is never written");
});

test("the Rust converter knows exactly the same colour names", () => {
  const list = /COLOUR_NAMES: \[&str; (\d+)\] =\s*\[([^\]]*)\]/.exec(obsidianRs);
  assert.ok(list, "COLOUR_NAMES found in obsidian.rs");
  const names = [...list[2].matchAll(/"([a-z]+)"/g)].map((m) => m[1]);
  assert.deepEqual([...names].sort(), [...COLOURS].sort());
  assert.equal(Number(list[1]), COLOURS.length);
});

test("a colour tag is read as text and/or background, in the new or the 0.2.9 form, and nothing else", () => {
  assert.deepEqual(parseColourTag("sn-text-red", undefined), { text: "red", bg: null });
  assert.deepEqual(parseColourTag("sn-bg-blue", undefined), { text: null, bg: "blue" });
  assert.deepEqual(parseColourTag("sn-text-red sn-bg-yellow", undefined), { text: "red", bg: "yellow" });
  assert.deepEqual(parseColourTag("sn-bg-yellow sn-text-red", undefined), { text: "red", bg: "yellow" }, "either order is read");
  assert.equal(parseColourTag("sn-text-red sn-text-blue", undefined), null, "the same kind twice");
  assert.equal(parseColourTag("sn-text-chartreuse", undefined), null);
  assert.equal(parseColourTag("other", undefined), null);
  assert.equal(parseColourTag(undefined, undefined), null);
  assert.deepEqual(parseColourTag(undefined, "#F72525"), { text: "red", bg: null });
  assert.equal(parseColourTag(undefined, "#123456"), null);
  assert.equal(Object.keys(LEGACY_TEXT_HEX).length, 8);
  for (const name of Object.values(LEGACY_TEXT_HEX)) assert.ok(isColour(name));
});

test("the tag we write has the text class first, then the background, and reads back the same", () => {
  assert.equal(colourOpenTag({ text: "red", bg: null }), '<span class="sn-text-red">');
  assert.equal(colourOpenTag({ text: null, bg: "yellow" }), '<span class="sn-bg-yellow">');
  assert.equal(colourOpenTag({ text: "red", bg: "yellow" }), '<span class="sn-text-red sn-bg-yellow">');
  for (const attrs of [{ text: "red", bg: null }, { text: null, bg: "pink" }, { text: "gray", bg: "brown" }]) {
    const [, list] = /<span class="([^"]*)">/.exec(colourOpenTag(attrs));
    assert.deepEqual(parseColourTag(list, undefined), attrs);
  }
});

test("the stylesheet has a light and a dark shade for every colour, and every class", () => {
  for (const set of [LIGHT, DARK]) {
    assert.equal(Object.keys(set).length, 18);
    for (const name of COLOURS) for (const kind of ["text", "bg"]) assert.match(set[`${kind}-${name}`] || "", /^#[0-9a-f]{6}$/, `${kind}-${name}`);
  }
  assert.deepEqual(setsFrom(darkMedia[1]), DARK, "a dark system gets the same dark set");
  for (const name of COLOURS) {
    assert.ok(styleCss.includes(`.sn-text-${name} { color: var(--sn-text-${name}); }`), `.sn-text-${name}`);
    assert.ok(styleCss.includes(`.sn-bg-${name} { background: var(--sn-bg-${name}); }`), `.sn-bg-${name}`);
  }
});

test("the light shades go to the light themes and the dark shades to the dark themes", () => {
  assert.deepEqual(themeNamesIn(lightRule[1]), schemeOf("light").sort());
  assert.deepEqual(themeNamesIn(darkRule[1]), schemeOf("dark").sort());
  assert.equal(schemeOf("light").length + schemeOf("dark").length, 8);
});

test("the shades are Notion's, except the few text shades moved to stay readable", () => {
  for (const name of COLOURS) {
    assert.equal(LIGHT[`bg-${name}`], NOTION.bgLight[name], `light background ${name}`);
    assert.equal(DARK[`bg-${name}`], NOTION.bgDark[name], `dark background ${name}`);
    for (const [scheme, set] of [["light", LIGHT], ["dark", DARK]]) {
      const shade = set[`text-${name}`];
      if (NUDGED[scheme].includes(name)) {
        assert.notEqual(shade, NOTION.text[name], `${scheme} ${name} was moved`);
        // "A little": every channel within 40 of Notion's.
        for (const i of [1, 3, 5]) assert.ok(Math.abs(parseInt(shade.slice(i, i + 2), 16) - parseInt(NOTION.text[name].slice(i, i + 2), 16)) <= 40, `${scheme} ${name} stays close`);
      } else assert.equal(shade, NOTION.text[name], `${scheme} ${name}`);
    }
  }
});

test("every text colour is readable on the pages of its themes, and the normal text on every background colour", () => {
  const pages = (scheme, system) => [...schemeOf(scheme).map((name) => themes[name]["--bg"]), system];
  // The system defaults in style.css: the first --bg is light, the one in the dark media query is dark.
  const systemBgs = [...styleCss.matchAll(/--bg:\s*(#[0-9a-f]{6});/g)].map((m) => m[1]);
  assert.equal(systemBgs.length, 2);
  for (const [scheme, set, system] of [["light", LIGHT, systemBgs[0]], ["dark", DARK, systemBgs[1]]]) {
    for (const name of COLOURS) {
      for (const bg of pages(scheme, system)) assert.ok(contrast(set[`text-${name}`], bg) >= 3.4, `${scheme}: ${name} text on ${bg} is ${contrast(set[`text-${name}`], bg).toFixed(2)}`);
    }
    const texts = [...schemeOf(scheme).map((n) => themes[n]["--text"]), styleCss.match(scheme === "light" ? /--text:\s*(#[0-9a-f]{6});/ : /prefers-color-scheme: dark\) \{[^}]*--text:\s*(#[0-9a-f]{6});/)[1]];
    for (const name of COLOURS) {
      for (const text of texts) assert.ok(contrast(text, set[`bg-${name}`]) >= 6.5, `${scheme}: text ${text} on ${name} background is ${contrast(text, set[`bg-${name}`]).toFixed(2)}`);
    }
  }
});

test("style markers are found, and taking them out leaves the text they wrap", () => {
  assert.equal(hasStyleSyntax("plain text"), false);
  assert.equal(hasStyleSyntax("a ==b== c"), true);
  assert.equal(hasStyleSyntax("a <U>b</U>"), true);
  assert.equal(hasStyleSyntax('a <span class="sn-bg-red">b</span>'), true);
  assert.equal(hasStyleSyntax("a == b == c"), false, "spaced == is not a highlight");
  assert.equal(withoutStyleSyntax("a ==b== <u>c</u> <sub>d</sub><sup>e</sup>"), "a b c de");
  assert.equal(withoutStyleSyntax('<span style="color:#F72525;">x</span>'), "x", "the 0.2.9 form");
  assert.equal(withoutStyleSyntax('<span class="sn-text-red sn-bg-yellow">x</span> <span class="sn-bg-blue">y</span>'), "x y");
  assert.equal(withoutStyleSyntax("a <b>b</b> ==c =="), "a <b>b</b> ==c ==", "other html and malformed highlights stay");
  assert.match(withoutStyleSyntax('<span class="other">x</span>'), /<span class="other">/, "a span of another program is still seen (so its block stays raw)");
  assert.match(withoutStyleSyntax('<span style="color:#123456">x</span>'), /<span style="color:#123456">/, "another colour code is still seen");
  assert.equal(withoutStyleSyntax("==x = 5=="), "x = 5");
});

test("the signature is the style markers in order, in one spelling", () => {
  assert.deepEqual(styleSignature("a <U>b</u> ==c== <sub>d</sub>"), ["<u>", "</u>", "<h>", "</h>", "<sub>", "</sub>"]);
  assert.deepEqual(styleSignature('<span style="color:#F72525;">x</span>'), ["<c:red:->", "</c>"]);
  assert.deepEqual(styleSignature('<span class="sn-text-red sn-bg-yellow">x</span>'), ["<c:red:yellow>", "</c>"]);
  assert.deepEqual(styleSignature('<span class="sn-bg-yellow">x</span>'), ["<c:-:yellow>", "</c>"]);
  assert.deepEqual(styleSignature('<span class="sn-text-red sn-text-blue">x</span>'), ["<c:invalid>", "</c>"]);
  assert.deepEqual(styleSignature("==a <u>b</u>=="), ["<h>", "<u>", "</u>", "</h>"]);
  assert.deepEqual(styleSignature("no styles, a == b"), []);
});

test("two texts have the same styles when the markers match, whatever the spelling", () => {
  assert.ok(sameStyles('<span style="color:#F72525">x</span> y', '<span class="sn-text-red">x</span> y'), "the 0.2.9 form means the same as the new one");
  assert.ok(sameStyles('<span class="sn-bg-yellow sn-text-red">x</span>', '<span class="sn-text-red sn-bg-yellow">x</span>'), "class order");
  assert.ok(sameStyles("a <U>b</U>", "a <u>b</u>"));
  assert.ok(!sameStyles("a <u>b c", "a b c"), "a lost marker is seen");
  assert.ok(!sameStyles("<u>a <sub>b</u> c</sub>", "<u>a b</u> c"), "a crossed pair changed by the editor is seen");
  assert.ok(!sameStyles('<span class="sn-text-red">x</span>', '<span class="sn-bg-red">x</span>'), "text and background are different");
  assert.ok(!sameStyles('<span class="sn-text-red sn-text-blue">x</span>', "x"), "a colour tag the editor would drop is seen");
});
