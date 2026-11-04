// Moving, duplicating, deleting and converting whole blocks of the open note.
//
// A "unit" is one block together with the block-id line (`^abc123`) that may follow it, so a
// block never gets separated from the id that links to it. All functions take the editor and
// change the document in one step, so one Undo takes the change back.

import { Selection, TextSelection } from "@tiptap/pm/state";

const ID_LINE = /^\^[A-Za-z0-9-]+$/;

export const isIdLine = (node) => node.type.name === "rawBlock" && ID_LINE.test(node.attrs.src || "");

/** The blocks of the note as units: { from, to, firstIndex, count, node }. */
export function unitsOf(doc) {
  const items = [];
  doc.forEach((node, from, index) => items.push({ node, from, to: from + node.nodeSize, index }));
  const out = [];
  for (let i = 0; i < items.length; i++) {
    const first = items[i];
    let last = first;
    if (i + 1 < items.length && !isIdLine(first.node) && isIdLine(items[i + 1].node)) {
      last = items[++i];
    }
    out.push({ from: first.from, to: last.to, firstIndex: first.index, count: last.index - first.index + 1, node: first.node });
  }
  return out;
}

/** Index of the unit that holds document position `pos`. */
export function unitIndexAt(doc, pos) {
  const units = unitsOf(doc);
  const found = units.findIndex((u) => pos >= u.from && pos < u.to);
  return found === -1 ? units.length - 1 : found;
}

function placeCursor(tr, pos) {
  const target = Math.max(0, Math.min(pos + 1, tr.doc.content.size));
  tr.setSelection(Selection.near(tr.doc.resolve(target)));
}

/** Moves unit `from` so it sits before unit `slot` (slot = units.length means "at the end"). */
export function moveUnit(editor, from, slot) {
  const { state, view } = editor;
  const units = unitsOf(state.doc);
  if (from < 0 || from >= units.length || slot < 0 || slot > units.length) return false;
  if (slot === from || slot === from + 1) return false;
  const unit = units[from];
  const content = state.doc.slice(unit.from, unit.to).content;
  const insertAt = slot === units.length ? state.doc.content.size : units[slot].from;
  const tr = state.tr.delete(unit.from, unit.to);
  const pos = tr.mapping.map(insertAt);
  tr.insert(pos, content);
  placeCursor(tr, pos);
  view.dispatch(tr.scrollIntoView());
  return true;
}

export function moveUnitBy(editor, from, step) {
  return moveUnit(editor, from, step > 0 ? from + 2 : from - 1);
}

export function deleteUnit(editor, index) {
  const { state, view } = editor;
  const units = unitsOf(state.doc);
  const unit = units[index];
  if (!unit) return false;
  const tr = state.tr;
  if (units.length === 1) {
    tr.replaceWith(0, state.doc.content.size, state.schema.nodes.paragraph.create());
  } else {
    tr.delete(unit.from, unit.to);
  }
  placeCursor(tr, Math.min(unit.from, tr.doc.content.size));
  view.dispatch(tr.scrollIntoView());
  return true;
}

/** A copy of the block right after it. The copy has no block id: ids must be unique. */
export function duplicateUnit(editor, index) {
  const { state, view } = editor;
  const unit = unitsOf(state.doc)[index];
  if (!unit) return false;
  const node = unit.node;
  // The copy keeps the original text (src, base), so an untouched block is written back as it
  // was; it has no gap and no position, so spacing is worked out fresh.
  const copy = node.type.create({ ...node.attrs, gap: null, idx: null, blockId: null }, node.content, node.marks);
  const insertAt = state.doc.resolve(unit.from).nodeAfter === node ? unit.from + node.nodeSize : unit.to;
  const tr = state.tr.insert(insertAt, copy);
  placeCursor(tr, insertAt);
  view.dispatch(tr.scrollIntoView());
  return true;
}

const ID_CHARS = "abcdefghijklmnopqrstuvwxyz0123456789";

function usedIds(doc) {
  const ids = new Set();
  doc.descendants((node) => {
    if (node.attrs && node.attrs.blockId) ids.add(node.attrs.blockId);
    if (isIdLine(node)) ids.add(node.attrs.src.slice(1));
  });
  return ids;
}

export function newBlockId(doc, random = globalThis.crypto) {
  const used = usedIds(doc);
  for (let attempt = 0; attempt < 50; attempt++) {
    const bytes = new Uint8Array(6);
    random.getRandomValues(bytes);
    const id = Array.from(bytes, (b) => ID_CHARS[b % ID_CHARS.length]).join("");
    if (!used.has(id)) return id;
  }
  return `b${Date.now().toString(36)}`;
}

/**
 * Makes sure the block has an id and returns it. A paragraph gets " ^id" at the end of its
 * text; any other block gets an id line after it (Obsidian's convention).
 */
export function ensureBlockId(editor, index) {
  const { state, view } = editor;
  const units = unitsOf(state.doc);
  const unit = units[index];
  if (!unit) return null;
  const node = unit.node;
  if (isIdLine(node)) return node.attrs.src.slice(1);
  if (unit.count === 2) return state.doc.child(unit.firstIndex + 1).attrs.src.slice(1);
  if (node.type.name === "paragraph") {
    if (node.attrs.blockId) return node.attrs.blockId;
    const id = newBlockId(state.doc);
    view.dispatch(state.tr.setNodeMarkup(unit.from, undefined, { ...node.attrs, blockId: id }));
    return id;
  }
  const id = newBlockId(state.doc);
  const line = state.schema.nodes.rawBlock.create({ src: `^${id}`, base: `^${id}`, gap: null, idx: null });
  view.dispatch(state.tr.insert(unit.to, line));
  return id;
}

const TURN_KINDS = new Set(["paragraph", "heading", "bulletList", "orderedList", "taskList", "blockquote", "codeBlock"]);

export function canTurnInto(node) {
  return TURN_KINDS.has(node.type.name);
}

const TURNS = {
  text: (c) => c.setParagraph(),
  heading1: (c) => c.setHeading({ level: 1 }),
  heading2: (c) => c.setHeading({ level: 2 }),
  heading3: (c) => c.setHeading({ level: 3 }),
  heading4: (c) => c.setHeading({ level: 4 }),
  bulletList: (c) => c.toggleBulletList(),
  orderedList: (c) => c.toggleOrderedList(),
  taskList: (c) => c.toggleTaskList(),
  quote: (c) => c.toggleBlockquote(),
  codeBlock: (c) => c.setCodeBlock(),
};

export const TURN_NAMES = Object.keys(TURNS);

/** Changes the kind of a text block (paragraph, heading, list, quote, code). */
export function turnInto(editor, index, kind) {
  const unit = unitsOf(editor.state.doc)[index];
  if (!unit || !canTurnInto(unit.node) || !TURNS[kind]) return false;
  const chain = editor
    .chain()
    .focus()
    .command(({ tr }) => {
      // Select the whole block, so a list is converted as a whole and not item by item.
      tr.setSelection(TextSelection.between(tr.doc.resolve(unit.from + 1), tr.doc.resolve(unit.to - 1)));
      return true;
    })
    .clearNodes();
  return TURNS[kind](chain).run();
}
