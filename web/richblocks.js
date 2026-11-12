// Callouts, toggles, tables and images: reading them from markdown text and writing them
// back. No editor code is in this file, so every rule here can be tested on its own.
//
// The rule that matters most: these functions only decide what a block *means*. A block
// the user did not touch is never written by them at all; compose.js writes its original
// text. They are used for blocks the user changed, and then they write one fixed style.
//
// Every reader is strict. When a block is not exactly the shape described here it returns
// null, and the caller keeps the block raw, which can never lose anything.

import { splitBlocks } from "./blocks.js";

export const IMAGE_EXTENSIONS = ["png", "jpg", "jpeg", "gif", "webp"];
export const MAX_TABLE_ROWS = 200;
export const MAX_TABLE_COLUMNS = 30;
// Side-by-side columns (see below): at least two, never more than this many.
export const MIN_COLUMNS = 2;
export const MAX_COLUMNS = 5;

// Inline syntax the editor cannot hold. A cell or title with any of it keeps the whole block raw.
const UNSAFE_TEXT = /\[\[|\]\]|==[^=\s]|\$[^$\s]|<[^>\n]+>|!\[|\[\^|%%|(^|\s)#[^\s#]|(^|\s)\^[\w-]+\s*$|~~~/;

// Block kinds (from blocks.js) the editor can hold inside a callout or toggle: the plain ones,
// and callouts, toggles, tables and images, which are read by the same readers as at the top
// of a page. A callout in a toggle is very common (study notes use it all the time).
const INNER_KINDS = new Set(["paragraph", "heading", "list", "quote", "code", "rule"]);
const INNER_TYPES = new Set(["paragraph", "heading", "bulletList", "orderedList", "taskList", "blockquote", "codeBlock", "horizontalRule"]);

// A callout or toggle inside another one, so deeply that nobody writes it on purpose, stays raw.
const MAX_DEPTH = 8;

const trimEnd = (text) => text.replace(/\n+$/, "");

/**
 * Turns the text inside a callout or toggle into editor nodes, or null when anything in
 * it is something the editor cannot hold safely. Each block is read on its own, with the
 * reader for its kind.
 */
function parseInner(inner, io, depth) {
  if (inner.trim() === "") return [{ type: "paragraph" }];
  if (depth > MAX_DEPTH) return null;
  const { blocks } = splitBlocks(inner);
  if (blocks.length === 0) return null;
  const nodes = [];
  for (const { src, kind } of blocks) {
    const node = readInnerBlock(kind, src, io, depth);
    if (!node) return null;
    nodes.push(node);
  }
  return nodes;
}

function readInnerBlock(kind, src, io, depth) {
  switch (kind) {
    case "callout":
      return readCallout(src, io, depth + 1);
    case "details":
      return readDetails(src, io, depth + 1);
    case "table":
      return readTable(src, io);
    case "image":
      return readImage(src);
    default:
      break;
  }
  if (!INNER_KINDS.has(kind)) return null;
  let parsed;
  try {
    parsed = io.parse(src);
  } catch {
    return null;
  }
  const content = parsed && Array.isArray(parsed.content) ? parsed.content : [];
  if (content.length !== 1 || !INNER_TYPES.has(content[0].type)) return null;
  return content[0];
}

function serializeInner(content, serialize) {
  const nodes = (content || []).filter((n) => !(n.type === "paragraph" && (!n.content || n.content.length === 0)));
  if (nodes.length === 0) return "";
  // Plain blocks next to each other are written together, the way the editor writes a page;
  // a callout, toggle, table or image in between is written by its own writer.
  const pieces = [];
  let run = [];
  const flush = () => {
    if (run.length) pieces.push(trimEnd(serialize({ type: "doc", content: run })));
    run = [];
  };
  for (const node of nodes) {
    if (INNER_TYPES.has(node.type)) run.push(node);
    else {
      flush();
      pieces.push(writeBlock(node, serialize));
    }
  }
  flush();
  return pieces.join("\n\n");
}

// ---------- callouts:  > [!note]- Title ----------

const CALLOUT_FIRST = /^ {0,3}>[ \t]?\[!([A-Za-z][A-Za-z0-9-]*)\]([+-]?)(?:[ \t]+(.*))?$/;

export function readCallout(src, io, depth = 0) {
  if (src.includes("\r")) return null;
  const lines = src.split("\n");
  const first = CALLOUT_FIRST.exec(lines[0]);
  if (!first) return null;
  const title = (first[3] || "").trim();
  if (UNSAFE_TEXT.test(title)) return null;
  const inner = [];
  for (const line of lines.slice(1)) {
    const match = /^ {0,3}>[ ]?(.*)$/.exec(line);
    if (!match) return null;
    inner.push(match[1]);
  }
  const content = parseInner(inner.join("\n"), io, depth);
  if (!content) return null;
  const kind = first[1].toLowerCase();
  // Columns are only recognised at the top of a page, where the editor can hold them.
  if (depth === 0 && kind === "columns") {
    const columns = readColumns(first[2], title, content);
    if (columns) return columns;
  }
  return { type: "callout", attrs: { kind, fold: first[2], title }, content };
}

// ---------- columns:  > [!columns] holding one > [!column] callout per column ----------
//
// Markdown has no columns, so they are written as a callout that holds one callout per column.
// Any program that knows callouts (Obsidian included) shows it as a plain callout with the
// columns one under the other, and the text stays readable. A callout named "columns" that
// does not have exactly this shape is an ordinary callout.

const isPlainCallout = (node, kind) => node.type === "callout" && node.attrs.kind === kind && node.attrs.fold === "" && node.attrs.title === "";

function readColumns(fold, title, content) {
  if (fold !== "" || title !== "") return null;
  if (content.length < MIN_COLUMNS || content.length > MAX_COLUMNS) return null;
  if (!content.every((node) => isPlainCallout(node, "column"))) return null;
  return { type: "columns", content: content.map((node) => ({ type: "column", content: node.content })) };
}

export function writeColumns(node, serialize) {
  const columns = (node.content || []).map((column) => ({ type: "callout", attrs: { kind: "column", fold: "", title: "" }, content: column.content }));
  return writeCallout({ attrs: { kind: "columns", fold: "", title: "" }, content: columns }, serialize);
}

export function writeCallout(node, serialize) {
  const { kind = "note", fold = "", title = "" } = node.attrs || {};
  const head = `> [!${kind}]${fold}${title ? ` ${title}` : ""}`;
  const inner = serializeInner(node.content, serialize);
  if (inner === "") return head;
  const body = inner.split("\n").map((line) => (line === "" ? ">" : `> ${line}`));
  return [head, ...body].join("\n");
}

// ---------- toggles:  <details><summary>Title</summary> ... </details> ----------

export function readDetails(src, io, depth = 0) {
  if (src.includes("\r")) return null;
  const lines = src.split("\n");
  if (lines.length < 3) return null;
  const open = /^<details( open)?>$/.exec(lines[0]);
  const summary = /^<summary>([^<>\n&]*)<\/summary>$/.exec(lines[1]);
  if (!open || !summary || lines[lines.length - 1] !== "</details>") return null;
  const middle = lines.slice(2, -1);
  // Allow one blank line after the summary and one before the closing line, as written
  // by Obsidian and GitHub, but nothing else that is not the body.
  if (middle.length && middle[0].trim() === "") middle.shift();
  if (middle.length && middle[middle.length - 1].trim() === "") middle.pop();
  const content = parseInner(middle.join("\n"), io, depth);
  if (!content) return null;
  return { type: "toggle", attrs: { summary: summary[1].trim(), open: Boolean(open[1]) }, content };
}

export function writeDetails(node, serialize) {
  const { summary = "", open = false } = node.attrs || {};
  const inner = serializeInner(node.content, serialize);
  const lines = [open ? "<details open>" : "<details>", `<summary>${summary.replace(/[<>&\n]/g, " ")}</summary>`, ""];
  if (inner !== "") lines.push(inner, "");
  lines.push("</details>");
  return lines.join("\n");
}

// ---------- tables: pipe format ----------

// Splits one table line into its cells. A pipe written as \| stays inside its cell.
function splitCells(line) {
  const trimmed = line.trim();
  // A closing pipe that is itself escaped (\|) is cell text, so the row is not closed.
  if (!trimmed.startsWith("|") || !trimmed.endsWith("|") || trimmed.endsWith("\\|") || trimmed.length < 2) return null;
  const inner = trimmed.slice(1, -1);
  const cells = [];
  let current = "";
  for (let i = 0; i < inner.length; i++) {
    if (inner[i] === "\\" && inner[i + 1] === "|") {
      current += "\\|";
      i++;
    } else if (inner[i] === "|") {
      cells.push(current.trim());
      current = "";
    } else {
      current += inner[i];
    }
  }
  cells.push(current.trim());
  return cells;
}

function alignOf(cell) {
  const left = cell.startsWith(":");
  const right = cell.endsWith(":");
  if (left && right) return "center";
  if (right) return "right";
  if (left) return "left";
  return null;
}

function cellNode(text, parse, header) {
  let paragraph = { type: "paragraph" };
  if (text !== "") {
    let parsed;
    try {
      parsed = parse(text.replace(/\\\|/g, "|"));
    } catch {
      return null;
    }
    const content = parsed && Array.isArray(parsed.content) ? parsed.content : [];
    if (content.length !== 1 || content[0].type !== "paragraph") return null;
    paragraph = content[0];
  }
  return { type: header ? "tableHeader" : "tableCell", attrs: { colspan: 1, rowspan: 1, colwidth: null }, content: [paragraph] };
}

export function readTable(src, { parse }) {
  if (src.includes("\r")) return null;
  const lines = src.split("\n");
  if (lines.length < 2 || lines.length > MAX_TABLE_ROWS + 1) return null;
  const rows = lines.map(splitCells);
  if (rows.some((r) => r === null)) return null;
  const columns = rows[0].length;
  if (columns < 1 || columns > MAX_TABLE_COLUMNS || rows.some((r) => r.length !== columns)) return null;
  const divider = rows[1];
  if (!divider.every((cell) => /^:?-+:?$/.test(cell))) return null;
  if (rows.some((r, index) => index !== 1 && r.some((cell) => UNSAFE_TEXT.test(cell)))) return null;
  const content = [];
  for (const [index, cells] of rows.entries()) {
    if (index === 1) continue;
    const nodes = cells.map((cell) => cellNode(cell, parse, index === 0));
    if (nodes.some((n) => n === null)) return null;
    content.push({ type: "tableRow", content: nodes });
  }
  return { type: "table", attrs: { aligns: divider.map(alignOf) }, content };
}

function escapePipes(text) {
  return text.replace(/(\\\\)|\\\||\|/g, (match, slashes) => (slashes ? slashes : match === "|" ? "\\|" : match));
}

export function writeTable(node, serialize) {
  const rows = (node.content || []).filter((r) => r.type === "tableRow");
  if (rows.length === 0) return "";
  const columns = Math.max(1, ...rows.map((r) => (r.content || []).length));
  const aligns = Array.from({ length: columns }, (_, i) => (node.attrs && node.attrs.aligns && node.attrs.aligns[i]) || null);
  const line = (row) => {
    const cells = Array.from({ length: columns }, (_, i) => {
      const cell = (row.content || [])[i];
      const text = cell ? serializeInner(cell.content, serialize).replace(/\s*\n\s*/g, " ") : "";
      return escapePipes(text);
    });
    return `| ${cells.join(" | ")} |`;
  };
  const mark = (align) => (align === "center" ? ":---:" : align === "right" ? "---:" : align === "left" ? ":---" : "---");
  const divider = `| ${aligns.map(mark).join(" | ")} |`;
  return [line(rows[0]), divider, ...rows.slice(1).map(line)].join("\n");
}

// ---------- images:  ![alt](attachments/name.png) ----------

const IMAGE = /^!\[([^\[\]\n]*)\]\((attachments\/[^\s()<>"\\]+\.(?:png|jpe?g|gif|webp))\)$/i;

// A size is written Obsidian-style at the very end of the description: `alt|300` (width) or
// `alt|300x200` (width and height). Anything else after a `|` is just part of the description,
// so an odd or out-of-range size means "natural size" and the text is kept as it was.
export const MIN_IMAGE_SIDE = 1;
export const MAX_IMAGE_SIDE = 10000;
const SIZE_AT_END = /\|(\d{1,5})(?:x(\d{1,5}))?$/;

function sizeOf(text) {
  const match = SIZE_AT_END.exec(text);
  if (!match) return null;
  const width = Number(match[1]);
  const height = match[2] === undefined ? null : Number(match[2]);
  const fits = (n) => n >= MIN_IMAGE_SIDE && n <= MAX_IMAGE_SIDE;
  if (!fits(width) || (height !== null && !fits(height))) return null;
  return { cut: match.index, width, height };
}

export function readImage(src) {
  const match = IMAGE.exec(src);
  if (!match) return null;
  const path = match[2];
  if (path.split("/").some((part) => part === ".." || part === "." || part === "")) return null;
  const size = sizeOf(match[1]);
  if (!size) return { type: "imageBlock", attrs: { alt: match[1], path } };
  const attrs = { alt: match[1].slice(0, size.cut), path, width: size.width };
  if (size.height !== null) attrs.height = size.height;
  return { type: "imageBlock", attrs };
}

export function writeImage(node) {
  const { alt = "", path = "", width = null, height = null } = node.attrs || {};
  let text = alt.replace(/[\[\]\n]/g, " ");
  if (width) return `![${text}|${Math.round(width)}${height ? `x${Math.round(height)}` : ""}](${path})`;
  // With no size, a description that happens to end in a size would be read back as one.
  if (sizeOf(text)) text = text.replace(/\|(?=\d{1,5}(?:x\d{1,5})?$)/, " ");
  return `![${text}](${path})`;
}

// ---------- the two entry points used by compose.js ----------

export function readRichBlock(kind, src, io) {
  switch (kind) {
    case "callout":
      return readCallout(src, io);
    case "details":
      return readDetails(src, io);
    case "table":
      return readTable(src, io);
    case "image":
      return readImage(src);
    default:
      return null;
  }
}

/** Writes any editor node as markdown: rich blocks here, everything else by the editor. */
export function writeBlock(node, serialize) {
  switch (node.type) {
    case "callout":
      return writeCallout(node, serialize);
    case "columns":
      return writeColumns(node, serialize);
    case "toggle":
      return writeDetails(node, serialize);
    case "table":
      return writeTable(node, serialize);
    case "imageBlock":
      return writeImage(node);
    default: {
      const text = trimEnd(serialize({ type: "doc", content: [node] }));
      // A paragraph can carry a block link id at the end of its last line.
      const id = node.type === "paragraph" && node.attrs && node.attrs.blockId;
      return id && text !== "" ? `${text} ^${id}` : text;
    }
  }
}
