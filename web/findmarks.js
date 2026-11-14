// Marks the words found by the page's find bar (pagefind.js) in the text of the page.
//
// The marks are decorations: they are drawn over the text but are not part of it, so finding
// never changes the page, is never saved and is never undone. Hits are looked for in each block
// of text as a whole (so a word split by bold or italic is still found) and a link counts with
// the name it shows.

import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { FIND_LIMIT, findAll } from "./findrules.js";
import { linkLabel, parseInner } from "./wikilinkrules.js";

const key = new PluginKey("findMarks");

const labelOfLink = (raw) => linkLabel(parseInner(String(raw).slice(2, -2)) || { page: raw, anchor: null, alias: null });

/**
 * The words of one block of text as one string, and for every character where it starts and
 * ends in the page. A link is its shown name (all its characters share the link's place); any
 * other inline thing (a line break) is a break that no hit can cross.
 */
function readBlock(block, pos) {
  let text = "";
  const starts = [];
  const ends = [];
  block.forEach((child, offset) => {
    const at = pos + 1 + offset;
    if (child.isText) {
      for (let i = 0; i < child.text.length; i++) {
        text += child.text[i];
        starts.push(at + i);
        ends.push(at + i + 1);
      }
      return;
    }
    const shown = child.type.name === "wikilink" ? labelOfLink(child.attrs.raw) : "\n";
    for (const ch of shown) {
      for (let k = 0; k < ch.length; k++) {
        text += ch[k];
        starts.push(at);
        ends.push(at + child.nodeSize);
      }
    }
  });
  return { text, starts, ends };
}

/** Every hit of `word` in the page, in reading order, as `{ from, to }` places in the page. */
export function collectHits(doc, word) {
  const hits = [];
  if (!String(word || "").trim()) return hits;
  doc.descendants((node, pos) => {
    if (hits.length >= FIND_LIMIT) return false;
    if (!node.isTextblock) return true;
    const { text, starts, ends } = readBlock(node, pos);
    for (const hit of findAll(text, word, FIND_LIMIT - hits.length)) hits.push({ from: starts[hit.start], to: ends[hit.end - 1] });
    return false;
  });
  return hits;
}

/** Marks `hits` in the page; `current` is the index of the one to stand out (-1: none). */
export function setFindMarks(editor, hits, current) {
  editor.view.dispatch(editor.state.tr.setMeta(key, { hits, current }).setMeta("addToHistory", false));
}

export const FindMarks = Extension.create({
  name: "findMarks",
  addProseMirrorPlugins() {
    return [
      new Plugin({
        key,
        state: {
          init: () => ({ hits: [], current: -1 }),
          apply(tr, value) {
            const meta = tr.getMeta(key);
            if (meta) return meta;
            if (!tr.docChanged || !value.hits.length) return value;
            // The page was edited: the marks move with the text until the bar searches again.
            const hits = value.hits.map((hit) => ({ from: tr.mapping.map(hit.from, 1), to: tr.mapping.map(hit.to, -1) })).filter((hit) => hit.to > hit.from);
            return { hits, current: value.current < hits.length ? value.current : -1 };
          },
        },
        props: {
          decorations(state) {
            const { hits, current } = key.getState(state);
            if (!hits.length) return null;
            const size = state.doc.content.size;
            const marks = hits
              .map((hit, i) => (hit.from >= 0 && hit.to <= size ? Decoration.inline(hit.from, hit.to, { class: i === current ? "find-hit find-hit-current" : "find-hit" }) : null))
              .filter(Boolean);
            return DecorationSet.create(state.doc, marks);
          },
        },
      }),
    ];
  },
});
