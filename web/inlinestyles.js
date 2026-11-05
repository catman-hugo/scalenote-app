// Text styles inside a line: highlight, underline, subscript, superscript and colour.
//
// How they are stored in the note (chosen so Obsidian shows them too, see DECISIONS.md):
//   highlight    ==text==
//   underline    <u>text</u>
//   subscript    <sub>text</sub>
//   superscript  <sup>text</sup>
//   colour       <span style="color: #f72525">text</span>   (only the colours below)
//
// This file has no editor code in it, so the rules can be tested on their own. The editor
// pieces that use it are in inlinemarks.js; blocks.js and compose.js use `withoutStyleSyntax`
// and `styleSignature` to decide whether a paragraph is safe to edit.

// The text colours. Real colour codes are stored, so other programs show the same colour. They
// were picked to stay readable (contrast of at least 3.4 to 1) on every theme background;
// tests/inlinestyles.test.mjs checks that against themes.css, and that style.css has a rule for
// each. Order is the order of the picker.
export const PALETTE = [
  { name: "red", hex: "#f72525" },
  { name: "orange", hex: "#c2671d" },
  { name: "yellow", hex: "#9c7a17" },
  { name: "green", hex: "#339142" },
  { name: "blue", hex: "#5083b2" },
  { name: "purple", hex: "#9465e0" },
  { name: "pink", hex: "#eb239b" },
  { name: "gray", hex: "#808080" },
];

/** The palette entry for a colour code (any letter case), or null for any other colour. */
export function paletteEntry(hex) {
  const wanted = String(hex || "").toLowerCase();
  return PALETTE.find((entry) => entry.hex === wanted) || null;
}

// The opening tag we write, and the looser forms we accept when reading (extra space, capital
// letters, a closing semicolon). Only palette colours match: any other colour keeps its block raw
// before the editor ever sees it.
export const COLOR_OPEN_SOURCE = `<span style="color:\\s*(#(?:${PALETTE.map((entry) => entry.hex.slice(1)).join("|")}));?">`;

export function colorOpenTag(hex) {
  return `<span style="color: ${hex}">`;
}

// ==text== : no space or "=" just inside the markers, and no "==" inside. A single "=" inside
// is fine ("==x = 5==").
export const HIGHLIGHT_SOURCE = "==([^=\\s](?:(?:[^=]|=(?!=))*[^=\\s])?)==";

/** Every tag or marker of the styles above. Used only for classification, never for editing. */
const TOKEN = new RegExp(`(</?(?:u|sub|sup)>)|(${COLOR_OPEN_SOURCE})|(</span>)|${HIGHLIGHT_SOURCE}`, "gi");

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
    .replace(new RegExp(COLOR_OPEN_SOURCE, "gi"), "")
    .replace(/<\/span>/gi, "");
}

/**
 * The style markers of a text, in order, in one fixed spelling ("<u>", "</u>", "<c:#f72525>",
 * "</c>", "<h>", "</h>"). Two texts that carry the same styles on the same stretches give the
 * same list, whatever spacing or letter case was used. compose.js compares the list before
 * and after the editor has read and rewritten a block: if they differ, the editor would lose
 * or change a style, so the block stays raw.
 */
export function styleSignature(text) {
  const out = [];
  const scan = (source) => {
    const re = new RegExp(`(</?)(u|sub|sup)>|<span style="color:\\s*(#[0-9a-fA-F]{6});?">|</span>|${HIGHLIGHT_SOURCE}`, "gi");
    let match;
    while ((match = re.exec(source))) {
      if (match[2]) out.push(`<${match[1] === "</" ? "/" : ""}${match[2].toLowerCase()}>`);
      else if (match[3]) out.push(`<c:${match[3].toLowerCase()}>`);
      else if (match[0].toLowerCase() === "</span>") out.push("</c>");
      else {
        out.push("<h>");
        scan(match[4]);
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
