// Splitting a markdown note into blocks, and putting it back together.
//
// Why this exists: the editor (Tiptap) rewrites markdown in its own style when it saves
// ("* item" becomes "- item", "_x_" becomes "*x*", and so on). That is fine for text the
// user just typed, but a note must never change when the user only opened it. So the note
// is cut into blocks first, every block remembers its exact original text, and a block the
// user did not touch is written back byte for byte. Syntax the editor does not know
// (tables, html, [[wikilinks]], callouts, math...) is kept as a "raw" block and never goes
// through the editor's rewriting at all.
//
// This file has no editor code in it, so it can be tested on its own.

import { withoutStyleSyntax } from "./inlinestyles.js";
import { withoutTags } from "./tagrules.js";
import { withoutWikilinks } from "./wikilinkrules.js";

/**
 * Splits off a leading `--- ... ---` frontmatter block. Returns exact text on both sides.
 * Some Windows editors start a file with an invisible byte-order mark; it stays with the
 * frontmatter so the block is still recognised (and so it is saved back unchanged).
 */
export function splitFrontmatter(text) {
  const match = /^\uFEFF?---[ \t]*\r?\n([\s\S]*?\r?\n)?---[ \t]*(\r?\n|$)/.exec(text);
  if (!match) return { front: "", body: text };
  return { front: match[0], body: text.slice(match[0].length) };
}

const HEADING = /^#{1,6}[ \t]+\S/;
const RULE = /^ {0,3}([-*_])([ \t]*\1){2,}[ \t]*$/;
const FENCE_OPEN = /^```[\w+-]*[ \t]*\r?$/;
const FENCE_ANY = /^ {0,3}(```|~~~)/;
const FENCE_CLOSE = /^```[ \t]*\r?$/;
// A canvas block (a window onto one region of the page's drawing): exactly three lines, with
// \n line ends. Anything else with this label stays an ordinary code block.
const CANVAS_FENCE = /^```scalenote-canvas\nid: [a-z0-9]{6,16}\n```$/;
const QUOTE = /^ {0,3}>/;
const LIST_MARKER = /^ {0,3}([-*+]|\d{1,9}[.)])([ \t]+|\r?$)/;
const SETEXT = /^ {0,3}(=+|-+)[ \t]*\r?$/;
const TABLE_DIVIDER = /^[ \t]*\|?[ \t]*:?-+:?[ \t]*(\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*\r?$/;
const DETAILS_OPEN = /^<details( open)?>[ \t]*$/;
const DETAILS_ANY_OPEN = /^[ \t]*<details[\s>]/;
const DETAILS_CLOSE = /^[ \t]*<\/details>[ \t]*$/;
const CALLOUT_START = /^ {0,3}>[ \t]?\[![A-Za-z][A-Za-z0-9-]*\][+-]?([ \t]|$)/;
const IMAGE_ONLY = /^!\[[^\[\]\n]*\]\(attachments\/[^\s()<>"\\]+\.(png|jpe?g|gif|webp)\)[ \t]*$/i;
// A line may start with "<" only for the text style tags (<u>, <sub>, <sup>, a colour span): those
// are inline, and compose.js still checks that the editor can keep them.
const RAW_LINE_START = /^(<(?!\/?(?:u|sub|sup)>|span (?:style="color:|class="sn-))|\$\$|%%|\[\^[^\]]+\]:|\[[^\]]+\]:[ \t]+\S|!\[\[| {4}|\t)/;

// Inline syntax the editor cannot round-trip. A block containing any of it is kept raw, so
// editing around it can never damage it. The text styles (highlight, underline, sub and
// superscript, colour) are taken out first: the editor can keep those, and compose.js checks
// that it really does for each block.
const UNSAFE_INLINE = [
  /\[\[|\]\]/, // embeds and anything that is not a well formed link (links are taken out first)
  /==[^=\s][^=]*==/, // a highlight-like "==" pair that is not well formed
  /\$[^$\s][^$\n]*\$/, // inline math
  /<[^>\n]+>/, // html and autolinks
  /!\[/, // images
  /\[\^/, // footnote references
  /%%/, // comments
  /(^|\s)#[^\s#]/, // a "#word" that is not a well formed tag (a number, say; tags are taken out first)
  /(^|\s)\^[\w-]+\s*$/, // block ids
  /~~~/,
];

/** Block ids are letters, digits and hyphens, as in Obsidian. */
export const BLOCK_ID = /[ \t]+\^([A-Za-z0-9-]+)$/;

/** Removes a closing " ^id" from the end of a paragraph's text. */
export function stripBlockId(text) {
  return text.replace(BLOCK_ID, "");
}

function hasUnsafeInline(text) {
  // Well formed [[links]] and #tags are taken out first: the editor keeps them as they were
  // written, and compose.js checks that it really does (see wikilinkSignature, tagSignature).
  const plain = withoutWikilinks(withoutTags(withoutStyleSyntax(text)));
  return UNSAFE_INLINE.some((pattern) => pattern.test(plain));
}

function lineInfo(body) {
  const lines = [];
  let position = 0;
  while (position < body.length) {
    const newline = body.indexOf("\n", position);
    const end = newline === -1 ? body.length : newline;
    lines.push({ start: position, end, text: body.slice(position, end) });
    if (newline === -1) break;
    position = newline + 1;
  }
  return lines;
}

const isBlank = (line) => line.text.trim() === "";

function startsAnotherBlock(text) {
  return HEADING.test(text) || FENCE_ANY.test(text) || RULE.test(text) || QUOTE.test(text) || LIST_MARKER.test(text);
}

// Finds where the block that starts at line `i` ends. Returns [lastLineIndex, kind].
function readBlock(lines, i) {
  const first = lines[i].text;

  if (FENCE_ANY.test(first)) {
    if (!FENCE_OPEN.test(first)) return [skipToBlank(lines, i), "raw"];
    for (let j = i + 1; j < lines.length; j++) {
      if (FENCE_CLOSE.test(lines[j].text)) return [j, j === i + 2 && CANVAS_FENCE.test(lines.slice(i, j + 1).map((l) => l.text).join("\n")) ? "canvasblock" : "code"];
    }
    return [lines.length - 1, "raw"]; // never closed: keep everything as written
  }
  if (DETAILS_OPEN.test(first)) {
    const end = findDetailsEnd(lines, i);
    if (end !== -1) return [end, "details"];
  }
  if (RAW_LINE_START.test(first)) return [skipToBlank(lines, i), "raw"];
  if (HEADING.test(first)) return [i, hasUnsafeInline(first) ? "raw" : "heading"];
  if (RULE.test(first)) return [i, "rule"];
  if (QUOTE.test(first)) return readQuote(lines, i);
  if (LIST_MARKER.test(first)) return readList(lines, i);
  return readParagraph(lines, i);
}

function skipToBlank(lines, i) {
  let j = i;
  while (j + 1 < lines.length && !isBlank(lines[j + 1])) j++;
  return j;
}

// A toggle (<details>) may hold blank lines, so it ends at its own closing line, not at the
// first blank line. Nested toggles are counted. Returns -1 when it never closes.
function findDetailsEnd(lines, i) {
  let depth = 0;
  for (let j = i; j < lines.length; j++) {
    if (DETAILS_ANY_OPEN.test(lines[j].text)) depth++;
    if (DETAILS_CLOSE.test(lines[j].text)) {
      depth--;
      if (depth === 0) return j;
    }
  }
  return -1;
}

function readQuote(lines, i) {
  let j = i;
  while (j + 1 < lines.length && QUOTE.test(lines[j + 1].text)) j++;
  const text = lines.slice(i, j + 1).map((l) => l.text).join("\n");
  // A callout is only a candidate here. compose.js decides whether the editor can really
  // hold it; if not, it becomes a raw block there.
  if (CALLOUT_START.test(lines[i].text)) return [j, "callout"];
  const unsafe = /^ {0,3}>[ \t]*\[!/.test(lines[i].text) || hasUnsafeInline(text) || /^[ \t]*>[ \t]*(```|#|[-*+] |\d+[.)] )/m.test(text);
  return [j, unsafe ? "raw" : "quote"];
}

const INDENTED = /^( {2,}|\t)/;

// Which kind of list a line starts: a to-do list, a numbered list (by its closing mark) or a
// bulleted list (by its bullet). In Markdown a different kind after a blank line is a new list,
// not a loose continuation of the old one. The editor writes its own lists one after another
// with a blank line between them, so reading them back as one block would turn a page of
// ordinary lists into one "kept exactly as written" block.
function listKind(text) {
  const marker = LIST_MARKER.exec(text);
  if (!marker) return "";
  if (/^\d/.test(marker[1])) return `ordered${marker[1].slice(-1)}`;
  if (/^ {0,3}[-*+][ \t]+\[[ xX]\](?:[ \t]|$)/.test(text)) return "task";
  return `bullet${marker[1]}`;
}

function readList(lines, i) {
  let j = i;
  let sawBlankInside = false;
  const kind = listKind(lines[i].text);
  while (j + 1 < lines.length) {
    const next = lines[j + 1];
    if (!isBlank(next)) {
      // Indented text and further items belong to the list. So does a plain line that
      // directly follows (lazy continuation). Any other block start ends the list.
      if (INDENTED.test(next.text) || LIST_MARKER.test(next.text) || !startsAnotherBlock(next.text)) {
        j++;
        continue;
      }
      break;
    }
    // Blank line: the list goes on only if the next real line is indented or another item.
    let k = j + 1;
    while (k < lines.length && isBlank(lines[k])) k++;
    if (k < lines.length && (INDENTED.test(lines[k].text) || (LIST_MARKER.test(lines[k].text) && listKind(lines[k].text) === kind))) {
      sawBlankInside = true;
      j = k;
      continue;
    }
    break;
  }
  const text = lines.slice(i, j + 1).map((l) => l.text).join("\n");
  // Loose lists, lists with fences or tables inside, and ")" numbering are left raw.
  const unsafe =
    sawBlankInside ||
    hasUnsafeInline(text) ||
    /(^|\n)[ \t]*(```|~~~|\|)/.test(text) ||
    /(^|\n)[ \t]*\d{1,9}\)/.test(text) ||
    /(^|\n)[ \t]*(?:[-*+]|\d+[.)])[ \t]*\r?(\n|$)/.test(text);
  return [j, unsafe ? "raw" : "list"];
}

function readParagraph(lines, i) {
  let j = i;
  while (j + 1 < lines.length && !isBlank(lines[j + 1])) {
    const next = lines[j + 1].text;
    if (SETEXT.test(next)) return [skipToBlank(lines, j + 1), "raw"];
    if (startsAnotherBlock(next)) break;
    j++;
  }
  const text = lines.slice(i, j + 1).map((l) => l.text).join("\n");
  if (j === i && IMAGE_ONLY.test(text)) return [j, "image"];
  const isTable = j > i && TABLE_DIVIDER.test(lines[i + 1].text) && text.includes("|");
  if (isTable) return [j, "table"]; // a candidate; compose.js may still keep it raw
  // A block link id (" ^abc123") closing the paragraph is part of how the editor keeps the
  // paragraph, so it is not a reason to keep the paragraph raw.
  const unsafe = hasUnsafeInline(stripBlockId(text)) || /^\|.*\|[ \t]*$/m.test(text);
  return [j, unsafe ? "raw" : "paragraph"];
}

/**
 * Cuts the body of a note into blocks.
 *
 * The result always satisfies: lead + every (src + gap) joined = the original body, so no
 * character is ever lost or invented. `gap` is whatever text sits between this block and
 * the next one (blank lines, or the final newline).
 */
export function splitBlocks(body) {
  const lines = lineInfo(body);
  const blocks = [];
  let i = 0;
  while (i < lines.length && isBlank(lines[i])) i++;
  const lead = i < lines.length ? body.slice(0, lines[i].start) : body;
  while (i < lines.length) {
    const [last, kind] = readBlock(lines, i);
    let next = last + 1;
    while (next < lines.length && isBlank(lines[next])) next++;
    const srcEnd = lines[last].end;
    const gapEnd = next < lines.length ? lines[next].start : body.length;
    blocks.push({ src: body.slice(lines[i].start, srcEnd), gap: body.slice(srcEnd, gapEnd), kind });
    i = next;
  }
  return { lead, blocks };
}

export function joinBlocks({ lead, blocks }) {
  return lead + blocks.map((b) => b.src + b.gap).join("");
}

/** A random id for the note's frontmatter. Uses the browser's secure random source. */
export function newNoteId(random = globalThis.crypto) {
  if (random && typeof random.randomUUID === "function") return random.randomUUID();
  const bytes = new Uint8Array(16);
  random.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Adds `id:` to the frontmatter if it has none. Everything else stays as written. */
export function withNoteId(front, id) {
  if (front === "") return `---\nid: ${id}\n---\n\n`;
  if (/^id:/m.test(front)) return front;
  const newline = front.includes("\r\n") ? "\r\n" : "\n";
  const trimmed = front.replace(/(\r?\n)+$/, "");
  const closing = trimmed.lastIndexOf("---");
  if (closing <= 0 || trimmed[closing - 1] !== "\n") return front;
  return `${front.slice(0, closing)}id: ${id}${newline}${front.slice(closing)}`;
}

// ---------- hiding the page id ----------
//
// The id is bookkeeping for the app (it names the page's history folder). Nobody should have to
// see or keep it while using the app, so the plain-markdown view shows the note without it.
// `hideNoteId` takes the id line out and remembers exactly what it took; `restoreNoteId` puts
// it back when the text is saved. If the text is not changed, the result is the original bytes.

/**
 * Returns the text without its `id:` line, plus what is needed to put it back (`null` when
 * the note has no id). A frontmatter block that held nothing but the id is removed whole.
 */
export function hideNoteId(text) {
  const { front, body } = splitFrontmatter(text);
  const lines = front.match(/[^\n]*\n|[^\n]+$/g) || [];
  const index = lines.findIndex((line, i) => i > 0 && /^id:/.test(line));
  if (index < 0) return { text, hidden: null };
  const rest = lines.filter((_, i) => i !== index);
  const onlyId = rest.length === 2 && /^\uFEFF?---/.test(rest[0]) && /^---/.test(rest[1]);
  if (!onlyId) return { text: rest.join("") + body, hidden: { kind: "line", line: lines[index], index } };
  // Withholding the blank line that follows keeps the visible text starting at the first word.
  const blank = /^\r?\n/.exec(body);
  const prefix = front + (blank ? blank[0] : "");
  return { text: body.slice(blank ? blank[0].length : 0), hidden: { kind: "whole", prefix } };
}

/** Puts back what `hideNoteId` took out of `text`. Does nothing when nothing was hidden. */
export function restoreNoteId(text, hidden) {
  if (!hidden) return text;
  if (hidden.kind === "whole") return hidden.prefix + text;
  const { front, body } = splitFrontmatter(text);
  if (front === "") return `---\n${hidden.line.replace(/\r?\n$/, "")}\n---\n\n${text}`;
  const lines = front.match(/[^\n]*\n|[^\n]+$/g) || [];
  const at = Math.min(hidden.index, lines.length - 1);
  const line = hidden.line.endsWith("\n") ? hidden.line : hidden.line + (front.includes("\r\n") ? "\r\n" : "\n");
  lines.splice(at, 0, line);
  return lines.join("") + body;
}
