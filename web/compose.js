// Turning a note into editor blocks and back, using the exact-text rules from blocks.js.
//
// `parse` and `serialize` are the editor's markdown functions. They are passed in so this
// file can be tested without an editor.

import { BLOCK_ID, newNoteId, splitBlocks, splitFrontmatter, withNoteId } from "./blocks.js";
import { readRichBlock, writeBlock } from "./richblocks.js";
import { hasStyleSyntax, sameStyles, withoutStyleSyntax } from "./inlinestyles.js";
import { hasTags, sameTags } from "./tagrules.js";
import { hasWikilinks, sameWikilinks } from "./wikilinkrules.js";

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

function rawNode(src, gap, idx) {
  return { type: "rawBlock", attrs: { src, base: src, gap, idx } };
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
  const content = blocks.map(({ src, gap, kind }, idx) => {
    if (kind === "raw") return rawNode(src, gap, idx);
    const isRich = ["callout", "details", "table", "image"].includes(kind);
    // A closing " ^id" on a paragraph is kept as the paragraph's block id, apart from its text.
    const idMatch = kind === "paragraph" ? BLOCK_ID.exec(src) : null;
    const node = isRich ? richNode(kind, src, { parse, serialize }) : oneEditableNode(idMatch ? src.slice(0, idMatch.index) : src, parse);
    if (!node || (idMatch && node.type !== "paragraph")) return rawNode(src, gap, idx);
    if (idMatch) node.attrs = { ...(node.attrs || {}), blockId: idMatch[1] };
    const base = writeBlock(node, serialize);
    // Text styles (==highlight==, <u>, <sub>, <sup>, colour) are only editable if the editor reads
    // every marker and writes it back: the editor silently drops html it does not understand, so
    // a stray or crossed marker would be lost the first time the block is changed. The block
    // stays raw unless the markers survive a read and write unchanged.
    if (!isRich && hasStyleSyntax(src) && !sameStyles(src, base)) return rawNode(src, gap, idx);
    // Links are kept the same way: if the editor would not write every link back exactly as it
    // was written (a link inside a heading's bold text, say), the block stays raw.
    if (hasWikilinks(src) && !sameWikilinks(src, base)) return rawNode(src, gap, idx);
    // And the same for #tags: a tag the editor wrote differently (escaped, say) would stop being a tag.
    // (A colour's "#f72525" is part of a style, not a tag, so styles are taken out first.)
    if (!isRich && hasTags(withoutStyleSyntax(src)) && !sameTags(withoutStyleSyntax(src), withoutStyleSyntax(base))) return rawNode(src, gap, idx);
    return { ...node, attrs: { ...(node.attrs || {}), src, base, gap, idx } };
  });
  const doc = { type: "doc", content: content.length ? content : [{ type: "paragraph" }] };
  // `count` lets compose tell which block was the last one in the original text.
  const parts = { front, lead, count: blocks.length };
  const again = composeNote(parts, doc, { serialize, assignId: false });
  // Safety net: opening a note and saving it untouched must give the same bytes. If that
  // ever fails, show the whole note as one raw block rather than risk changing it.
  if (again !== text) {
    return wholeBodyRaw(text, { parse, serialize });
  }
  return { parts, doc };
}

// The fallback view. Only the part after the frontmatter is shown, so the page id (and any
// other properties) are never on screen; the frontmatter stays in `parts` and is written back
// as it was. If even that does not give the same bytes, the whole text is shown as one block.
function wholeBodyRaw(text, io) {
  const { front, body } = splitFrontmatter(text);
  const parts = { front, lead: "", count: 1 };
  const doc = { type: "doc", content: [rawNode(body, "", 0)] };
  if (front !== "" && composeNote(parts, doc, { serialize: io.serialize, assignId: false }) === text) return { parts, doc };
  return { parts: { front: "", lead: "", count: 1 }, doc: { type: "doc", content: [rawNode(text, "", 0)] } };
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
  // A block link id must be unique in a note. Splitting a paragraph copies its id to both
  // halves, so only the first one keeps it.
  const seenIds = new Set();
  const pieces = nodes.map((node) => {
    let attrs = node.attrs || {};
    if (attrs.blockId) {
      if (seenIds.has(attrs.blockId)) node = { ...node, attrs: { ...attrs, blockId: null } };
      else seenIds.add(attrs.blockId);
      attrs = node.attrs;
    }
    if (node.type === "rawBlock") {
      const src = attrs.src || "";
      return { type: node.type, text: src, unchanged: src === attrs.base && attrs.gap != null, gap: attrs.gap, idx: attrs.idx };
    }
    const markdown = writeBlock(node, serialize);
    const unchanged = typeof attrs.src === "string" && markdown === attrs.base;
    return { type: node.type, text: unchanged ? attrs.src : markdown, unchanged: unchanged && attrs.gap != null, gap: attrs.gap, idx: attrs.idx };
  });

  let body = "";
  pieces.forEach((piece, index) => {
    const next = pieces[index + 1];
    body += piece.text + gapAfter(piece, next, parts.count);
  });
  const lead = pieces.length ? parts.lead : "";
  const front = assignId ? withNoteId(parts.front, makeId()) : parts.front;
  return front + lead + body;
}

// The blank lines saved with a block are only right while the block still has the same
// neighbour it had in the original text. After a block was moved, they are worked out again.
function gapAfter(piece, next, count) {
  if (!next) {
    const wasLast = typeof piece.idx !== "number" || typeof count !== "number" || piece.idx === count - 1;
    return piece.unchanged && wasLast ? piece.gap : "\n";
  }
  const sameNeighbour = typeof piece.idx !== "number" || typeof next.idx !== "number" || next.idx === piece.idx + 1;
  if (piece.unchanged && next.unchanged && sameNeighbour) return piece.gap;
  // Something changed here (or a block was moved): make sure a blank line still separates
  // the two blocks, unless a single line break already does the job. A heading, a rule or a
  // code block ends by itself, and a block that starts with a marker starts a new one. A
  // gap with no line break at all (the end of a file with no final newline) never does.
  const gap = typeof piece.gap === "string" ? piece.gap : "";
  if (/\n[ \t]*\r?\n/.test(gap)) return gap;
  const endsByItself = ["heading", "horizontalRule", "codeBlock"].includes(piece.type);
  const startsByItself = /^(#{1,6} |```|[-*+] |\d+[.)] |>)/.test(next.text);
  return (endsByItself || startsByItself) && gap.includes("\n") ? gap : "\n\n";
}
