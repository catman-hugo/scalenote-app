// Turning a note into editor blocks and back, using the exact-text rules from blocks.js.
//
// `parse` and `serialize` are the editor's markdown functions. They are passed in so this
// file can be tested without an editor.

import { newNoteId, splitBlocks, splitFrontmatter, withNoteId } from "./blocks.js";
import { readRichBlock, writeBlock } from "./richblocks.js";

// Block types the editor can show and edit. Anything else is kept as a raw block.
const EDITABLE_TYPES = new Set([
  "paragraph",
  "heading",
  "bulletList",
  "orderedList",
  "taskList",
  "blockquote",
  "codeBlock",
  "horizontalRule",
]);

function rawNode(src, gap) {
  return { type: "rawBlock", attrs: { src, base: src, gap } };
}

// Callouts, toggles, tables and images: editable only when they match a strict shape.
function richNode(kind, src, io) {
  try {
    return readRichBlock(kind, src, io);
  } catch {
    return null;
  }
}

function oneEditableNode(src, parse) {
  let parsed;
  try {
    parsed = parse(src);
  } catch {
    return null;
  }
  const content = parsed && Array.isArray(parsed.content) ? parsed.content : [];
  if (content.length !== 1 || !EDITABLE_TYPES.has(content[0].type)) return null;
  return content[0];
}

function trimNewlines(text) {
  return text.replace(/\n+$/, "");
}

/**
 * Reads note text into editor content. Returns the parts that must be kept for saving
 * (frontmatter, leading blank lines) and the editor document.
 */
export function loadNote(text, { parse, serialize }) {
  const { front, body } = splitFrontmatter(text);
  const { lead, blocks } = splitBlocks(body);
  const content = blocks.map(({ src, gap, kind }) => {
    if (kind === "raw") return rawNode(src, gap);
    const isRich = ["callout", "details", "table", "image"].includes(kind);
    const node = isRich ? richNode(kind, src, { parse, serialize }) : oneEditableNode(src, parse);
    if (!node) return rawNode(src, gap);
    const base = writeBlock(node, serialize);
    return { ...node, attrs: { ...(node.attrs || {}), src, base, gap } };
  });
  const doc = { type: "doc", content: content.length ? content : [{ type: "paragraph" }] };
  const parts = { front, lead };
  const again = composeNote(parts, doc, { serialize, assignId: false });
  // Safety net: opening a note and saving it untouched must give the same bytes. If that
  // ever fails, show the whole note as one raw block rather than risk changing it.
  if (again !== text) {
    return { parts: { front: "", lead: "" }, doc: { type: "doc", content: [rawNode(text, "")] } };
  }
  return { parts, doc };
}

function isEmptyParagraph(node) {
  return node.type === "paragraph" && (!node.content || node.content.length === 0);
}

/**
 * Builds the note text from the editor document.
 *
 * A block whose markdown still equals what it was when the note was opened is written as
 * its original text. Only blocks the user changed are written in the editor's style.
 */
export function composeNote(parts, doc, { serialize, assignId = true, makeId = newNoteId }) {
  const nodes = (doc.content || []).filter((node) => !isEmptyParagraph(node));
  const pieces = nodes.map((node) => {
    const attrs = node.attrs || {};
    if (node.type === "rawBlock") {
      const src = attrs.src || "";
      return { type: node.type, text: src, unchanged: src === attrs.base && attrs.gap != null, gap: attrs.gap };
    }
    const markdown = writeBlock(node, serialize);
    const unchanged = typeof attrs.src === "string" && markdown === attrs.base;
    return { type: node.type, text: unchanged ? attrs.src : markdown, unchanged: unchanged && attrs.gap != null, gap: attrs.gap };
  });

  let body = "";
  pieces.forEach((piece, index) => {
    const next = pieces[index + 1];
    body += piece.text + gapAfter(piece, next);
  });
  const lead = pieces.length ? parts.lead : "";
  const front = assignId ? withNoteId(parts.front, makeId()) : parts.front;
  return front + lead + body;
}

function gapAfter(piece, next) {
  if (!next) return piece.unchanged ? piece.gap : "\n";
  if (piece.unchanged && next.unchanged) return piece.gap;
  // Something changed here: make sure a blank line still separates the two blocks, unless
  // the original had none and the blocks cannot run together anyway (a heading, a rule or
  // a code block ends by itself, and a block that starts with a marker starts a new one).
  if (typeof piece.gap !== "string") return "\n\n";
  if (/\n[ \t]*\r?\n/.test(piece.gap)) return piece.gap;
  const endsByItself = ["heading", "horizontalRule", "codeBlock"].includes(piece.type);
  const startsByItself = /^(#{1,6} |```|[-*+] |\d+[.)] |>)/.test(next.text);
  return endsByItself || startsByItself ? piece.gap : "\n\n";
}
