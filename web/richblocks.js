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

// Inline syntax the editor cannot hold. A cell or title with any of it keeps the whole block raw.
const UNSAFE_TEXT = /\[\[|\]\]|==[^=\s]|\$[^$\s]|<[^>\n]+>|!\[|\[\^|%%|(^|\s)#[^\s#]|(^|\s)\^[\w-]+\s*$|~~~/;

// Block kinds (from blocks.js) the editor can hold inside a callout or toggle.
const INNER_KINDS = new Set(["paragraph", "heading", "list", "quote", "code", "rule"]);
const INNER_TYPES = new Set(["paragraph", "heading", "bulletList", "orderedList", "taskList", "blockquote", "codeBlock", "horizontalRule"]);

const trimEnd = (text) => text.replace(/\n+$/, "");

/**
 * Turns the text inside a callout or toggle into editor nodes, or null when anything in
 * it is something the editor cannot hold safely.
 */
function parseInner(inner, parse) {
  if (inner.trim() === "") return [{ type: "paragraph" }];
  const { blocks } = splitBlocks(inner);
  if (blocks.length === 0 || blocks.some((b) => !INNER_KINDS.has(b.kind))) return null;
  let parsed;
  try {
    parsed = parse(inner);
  } catch {
    return null;
  }
  const content = parsed && Array.isArray(parsed.content) ? parsed.content : [];
  if (content.length !== blocks.length || content.some((n) => !INNER_TYPES.has(n.type))) return null;
  return content;
}

function serializeInner(content, serialize) {
  const nodes = (content || []).filter((n) => !(n.type === "paragraph" && (!n.content || n.content.length === 0)));
  if (nodes.length === 0) return "";
  return trimEnd(serialize({ type: "doc", content: nodes }));
}

// ---------- callouts:  > [!note]- Title ----------

const CALLOUT_FIRST = /^ {0,3}>[ \t]?\[!([A-Za-z][A-Za-z0-9-]*)\]([+-]?)(?:[ \t]+(.*))?$/;

export function readCallout(src, { parse }) {
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
  const content = parseInner(inner.join("\n"), parse);
  if (!content) return null;
  return { type: "callout", attrs: { kind: first[1].toLowerCase(), fold: first[2], title }, content };
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

export function readDetails(src, { parse }) {
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
  const content = parseInner(middle.join("\n"), parse);
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

export function readImage(src) {
  const match = IMAGE.exec(src);
  if (!match) return null;
  const path = match[2];
  if (path.split("/").some((part) => part === ".." || part === "." || part === "")) return null;
  return { type: "imageBlock", attrs: { alt: match[1], path } };
}

export function writeImage(node) {
  const { alt = "", path = "" } = node.attrs || {};
  return `![${alt.replace(/[\[\]\n]/g, " ")}](${path})`;
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
