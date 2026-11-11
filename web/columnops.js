// Making, changing and undoing columns in the open note. Every function changes the document in
// one step, so one Undo takes the whole change back.
//
// A drop is "take these blocks from here (the source) and put them there (the target)":
//   { type: "side", from, to, side }   next to a top-level block: the two become columns
//   { type: "edge", columnsFrom, side } a new column at the left or right end of a columns block
//   { type: "at", pos }                  at a position between blocks, at the top of the page or in a column
// The new content is put in first and the old removed after, because putting content in is
// always valid for the editor's rules, while taking it out can leave a columns block with one
// column, which has to be turned back into plain blocks in the same step.

import { Fragment } from "@tiptap/pm/model";
import { Selection } from "@tiptap/pm/state";
import { MAX_COLUMNS, MIN_COLUMNS } from "./richblocks.js";

// The sibling blocks that lie between two positions of the same parent.
export const nodesBetween = (doc, from, to) => {
  const $from = doc.resolve(from);
  const start = $from.start();
  const nodes = [];
  $from.parent.forEach((node, offset) => {
    const at = start + offset;
    if (at >= from && at + node.nodeSize <= to) nodes.push(node);
  });
  return nodes;
};

/** Whether these blocks may stand inside a column (columns do not nest, raw text cannot). */
export function fitsInColumn(schema, nodes) {
  return nodes.length > 0 && schema.nodes.column.validContent(Fragment.from(nodes));
}

// Takes the blocks of `source` out. A column that would be left with nothing is removed with
// them, and a columns block that would be left with one column becomes that column's blocks.
function removeSource(tr, source) {
  const from = tr.mapping.map(source.from, 1);
  const to = tr.mapping.map(source.to, -1);
  const $from = tr.doc.resolve(from);
  const parent = $from.parent;
  if (parent.type.name !== "column") {
    tr.delete(from, to);
    return;
  }
  if (to - from < parent.content.size) {
    tr.delete(from, to);
    return;
  }
  // The whole column goes.
  const columns = $from.node(-1);
  const columnsFrom = $from.before(-1);
  if (columns.childCount > MIN_COLUMNS) {
    tr.delete($from.before(), $from.after());
    return;
  }
  const left = [];
  columns.forEach((column) => {
    if (column !== parent) left.push(...nodesBetween(column, 0, column.content.size));
  });
  tr.replaceWith(columnsFrom, columnsFrom + columns.nodeSize, left);
}

/** Moves the blocks of `source` to `target`. Returns false when that is not allowed or changes nothing. */
export function applyDrop(editor, source, target) {
  const { state, view } = editor;
  const moved = nodesBetween(state.doc, source.from, source.to);
  if (!moved.length) return false;
  const tr = state.tr;
  const schema = state.schema;

  if (target.type === "side") {
    if (!fitsInColumn(schema, moved)) return false;
    const targetNodes = nodesBetween(state.doc, target.from, target.to);
    if (!fitsInColumn(schema, targetNodes) || (source.from < target.to && source.to > target.from)) return false;
    const column = (nodes) => schema.nodes.column.create(null, nodes);
    const pair = target.side === "left" ? [column(moved), column(targetNodes)] : [column(targetNodes), column(moved)];
    tr.replaceWith(target.from, target.to, schema.nodes.columns.create(null, pair));
  } else if (target.type === "edge") {
    const columns = state.doc.nodeAt(target.columnsFrom);
    if (!columns || columns.type.name !== "columns" || columns.childCount >= MAX_COLUMNS || !fitsInColumn(schema, moved)) return false;
    const at = target.side === "left" ? target.columnsFrom + 1 : target.columnsFrom + columns.nodeSize - 1;
    tr.insert(at, schema.nodes.column.create(null, moved));
  } else {
    if (target.pos >= source.from && target.pos <= source.to) return false; // it would stay where it is
    const $at = state.doc.resolve(target.pos);
    if ($at.parent.type.name === "column" && !fitsInColumn(schema, moved)) return false;
    tr.insert(target.pos, moved);
  }
  removeSource(tr, source);
  view.dispatch(tr.scrollIntoView());
  return true;
}

/** Turns the columns block that starts at `from` into its blocks, one column after the other. */
export function unwrapColumns(editor, from) {
  const { state, view } = editor;
  const columns = state.doc.nodeAt(from);
  if (!columns || columns.type.name !== "columns") return false;
  const blocks = [];
  columns.forEach((column) => blocks.push(...nodesBetween(column, 0, column.content.size)));
  const tr = state.tr.replaceWith(from, from + columns.nodeSize, blocks);
  tr.setSelection(Selection.near(tr.doc.resolve(Math.min(from + 1, tr.doc.content.size))));
  view.dispatch(tr.scrollIntoView());
  return true;
}
