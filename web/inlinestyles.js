// Text styles inside a line: highlight, underline, subscript, superscript and colour.
//
// How they are stored in the note (chosen so Obsidian shows them too, see DECISIONS.md):
//   highlight    ==text==
//   underline    <u>text</u>
//   subscript    <sub>text</sub>
//   superscript  <sup>text</sup>
//   colour       <span class="sn-text-red sn-bg-yellow">text</span>   (text and/or background, names below)
//
// This file has no editor code in it, so the rules can be tested on their own. The editor
// pieces that use it are in inlinemarks.js; blocks.js and compose.js use `withoutStyleSyntax`
// and `styleSignature` to decide whether a paragraph is safe to edit.

// The colours: the ten of Notion's text and background palette (the first, "default", is "no
// colour"). A colour is saved by NAME in a class, not as a colour code, because the right shade
// depends on the theme: Notion shows a pale background in light themes and a dark one in dark
// themes. style.css has the shades (a test checks every name has them, and that they stay
// readable on every theme). A text colour and a background colour on the same words share one
// span:  <span class="sn-text-red sn-bg-yellow">text</span>.
//
// Order is the order of the picker. src-tauri/core/src/obsidian.rs has the same list for the
// converted copy; tests/inlinestyles.test.mjs compares the two.
export const COLOURS = ["gray", "brown", "orange", "yellow", "green", "blue", "purple", "pink", "red"];

/** True for a colour name we know. */
export function isColour(name) {
  return COLOURS.includes(name);
}

// 0.2.9 saved a text colour as <span style="color: #f72525">. Those eight codes are still read
// (as the colour with the same name) and are written in the new form the next time the block is
// saved. Any other colour code is not ours and keeps its paragraph raw.
export const LEGACY_TEXT_HEX = {
  "#f72525": "red",
  "#c2671d": "orange",
  "#9c7a17": "yellow",
  "#339142": "green",
  "#5083b2": "blue",
  "#9465e0": "purple",
  "#eb239b": "pink",
  "#808080": "gray",
};

const NAME = `(?:${COLOURS.join("|")})`;
const CLASS = `(?:sn-text-${NAME}|sn-bg-${NAME})`;
// The opening tag we read: one class or two (the second after one space), or the 0.2.9 form.
// Group 1 is the class list, group 2 the old colour code.
export const COLOUR_OPEN_SOURCE = `<span class="(${CLASS}(?: ${CLASS})?)">|<span style="color:\\s*(#(?:${Object.keys(LEGACY_TEXT_HEX).map((hex) => hex.slice(1)).join("|")}));?">`;

/**
 * What an opening colour tag says, as { text, bg } (each a name or null), or null when the
 * tag is not a form we write: the same kind twice ("sn-text-red sn-text-blue") has no meaning.
 * `classList` and `legacyHex` are the two captured groups of COLOUR_OPEN_SOURCE.
 */
export function parseColourTag(classList, legacyHex) {
  if (legacyHex) {
    const name = LEGACY_TEXT_HEX[String(legacyHex).toLowerCase()];
    return name ? { text: name, bg: null } : null;
  }
  const out = { text: null, bg: null };
  for (const word of String(classList || "").split(" ")) {
    const kind = word.startsWith("sn-text-") ? "text" : word.startsWith("sn-bg-") ? "bg" : null;
    const name = word.slice(kind === "text" ? 8 : 6);
    if (!kind || !isColour(name) || out[kind]) return null;
    out[kind] = name;
  }
  return out.text || out.bg ? out : null;
}

/** The opening tag we write. Text first, then background. */
export function colourOpenTag({ text, bg }) {
  const classes = [text ? `sn-text-${text}` : "", bg ? `sn-bg-${bg}` : ""].filter(Boolean).join(" ");
  return `<span class="${classes}">`;
}

// ==text== : no space or "=" just inside the markers, and no "==" inside. A single "=" inside
// is fine ("==x = 5==").
export const HIGHLIGHT_SOURCE = "==([^=\\s](?:(?:[^=]|=(?!=))*[^=\\s])?)==";

/** Every tag or marker of the styles above. Used only for classification, never for editing. */
const TOKEN = new RegExp(`(</?(?:u|sub|sup)>)|(?:${COLOUR_OPEN_SOURCE})|(</span>)|${HIGHLIGHT_SOURCE}`, "gi");

/** True when the text has any of the style markers (balanced or not). */
export function hasStyleSyntax(text) {
  TOKEN.lastIndex = 0;
  return TOKEN.test(text);
}

/**
 * The text with the style markers taken out, keeping what they wrap. blocks.js looks at what is
 * left: any other html or "==" is still a reason to keep the block raw. This only checks the
 * shape of each marker. Whether they are properly paired and survive saving is checked in
 * compose.js with `styleSignature`.
 */
export function withoutStyleSyntax(text) {
  return String(text)
    .replace(new RegExp(HIGHLIGHT_SOURCE, "g"), "$1")
    .replace(/<\/?(?:u|sub|sup)>/gi, "")
    .replace(new RegExp(COLOUR_OPEN_SOURCE, "gi"), "")
    .replace(/<\/span>/gi, "");
}

/**
 * The style markers of a text, in order, in one fixed spelling ("<u>", "</u>", "<c:red:yellow>",
 * "</c>", "<h>", "</h>"). Two texts that carry the same styles on the same stretches give the
 * same list, whatever spacing or letter case was used. compose.js compares the list before
 * and after the editor has read and rewritten a block: if they differ, the editor would lose
 * or change a style, so the block stays raw.
 */
export function styleSignature(text) {
  const out = [];
  const scan = (source) => {
    // Groups: 1-2 the underline/sub/sup tags, 3 a colour class list, 4 an old colour code,
    // 5 the text of a highlight.
    const re = new RegExp(`(</?)(u|sub|sup)>|${COLOUR_OPEN_SOURCE}|</span>|${HIGHLIGHT_SOURCE}`, "gi");
    let match;
    while ((match = re.exec(source))) {
      if (match[2]) out.push(`<${match[1] === "</" ? "/" : ""}${match[2].toLowerCase()}>`);
      else if (match[3] || match[4]) {
        const colour = parseColourTag(match[3] && match[3].toLowerCase(), match[4]);
        out.push(colour ? `<c:${colour.text || "-"}:${colour.bg || "-"}>` : "<c:invalid>");
      } else if (match[0].toLowerCase() === "</span>") out.push("</c>");
      else {
        out.push("<h>");
        scan(match[5]);
        out.push("</h>");
      }
    }
  };
  scan(String(text));
  return out;
}

/** True when both texts have the same style markers in the same order. */
export function sameStyles(a, b) {
  const x = styleSignature(a);
  const y = styleSignature(b);
  return x.length === y.length && x.every((token, i) => token === y[i]);
}
