// Which toggle blocks are folded shut.
//
// Folding is only a view: it is never written into the note. The editor keeps the positions
// of the folded toggles here and moves them along as the text around them changes, so a
// folded toggle stays folded while the page is edited. main.js remembers the list per page
// for as long as the app is open (see `foldsFor`), which is how a page opens with every
// toggle folded the first time and as it was left after that.

import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";

const key = new PluginKey("toggleFold");

/** Toggles only exist at the top level of a page, so the page's own children are enough. */
function togglePositions(doc) {
  const out = [];
  doc.forEach((node, offset) => { if (node.type.name === "toggle") out.push(offset); });
  return out;
}

/**
 * The fold state to give a page with `count` toggles. `remembered` is the list kept from the
 * last time this page was on screen (true = folded), or undefined the first time since the app
 * was opened: then every toggle is folded. A toggle the list does not cover is folded too.
 */
export function foldsFor(count, remembered) {
  return Array.from({ length: count }, (_, i) => (Array.isArray(remembered) && i < remembered.length ? Boolean(remembered[i]) : true));
}

/** True or false for every toggle on the page, top to bottom. */
export function foldFlags(state) {
  const folded = new Set(key.getState(state) || []);
  return togglePositions(state.doc).map((pos) => folded.has(pos));
}

/** Folds the toggles of the page on screen as `flags` says (see `foldsFor`). Not an edit. */
export function applyFolds(editor, remembered) {
  const positions = togglePositions(editor.state.doc);
  const flags = foldsFor(positions.length, remembered);
  const folded = positions.filter((_, i) => flags[i]);
  editor.view.dispatch(editor.state.tr.setMeta(key, { set: folded }).setMeta("addToHistory", false));
}

/** Folds or unfolds the toggle that starts at `pos`. Not an edit, so it is never undone or saved. */
export function flipFold(view, pos) {
  view.dispatch(view.state.tr.setMeta(key, { flip: pos }).setMeta("addToHistory", false));
}

/** Whether the toggle that starts at `pos` is folded shut. */
export function isFoldedAt(state, pos) {
  return (key.getState(state) || []).includes(pos);
}

/** Whether these decorations (as a node view receives them) say "folded". */
export const isFoldedBy = (decorations) => (decorations || []).some((d) => d.spec && d.spec.fold);

export const ToggleFold = Extension.create({
  name: "toggleFold",
  addProseMirrorPlugins() {
    return [
      new Plugin({
        key,
        state: {
          init: () => [],
          apply(tr, folded, _old, state) {
            const meta = tr.getMeta(key);
            let next = folded;
            // Follow the toggles through an edit; one that is gone (deleted, or cut out to be
            // moved) drops off the list.
            if (tr.docChanged) next = next.map((pos) => tr.mapping.map(pos, 1));
            if (meta && meta.set) next = meta.set;
            if (meta && typeof meta.flip === "number") next = next.includes(meta.flip) ? next.filter((p) => p !== meta.flip) : [...next, meta.flip];
            if (next === folded) return folded;
            const seen = new Set();
            return next.filter((pos) => {
              if (seen.has(pos) || pos < 0 || pos >= state.doc.content.size) return false;
              seen.add(pos);
              const node = state.doc.nodeAt(pos);
              return Boolean(node && node.type.name === "toggle");
            });
          },
        },
        props: {
          // The class hides the content (style.css); the node view reads `fold` for its arrow.
          decorations(state) {
            const folded = key.getState(state) || [];
            if (folded.length === 0) return null;
            return DecorationSet.create(state.doc, folded.map((pos) => Decoration.node(pos, pos + state.doc.nodeAt(pos).nodeSize, { class: "folded" }, { fold: true })));
          },
        },
      }),
    ];
  },
});
