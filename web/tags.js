// #tags in the editor.
//
// A tag stays ordinary text: nothing is turned into a different piece, so typing, copying and
// saving work as they do for any word, and the saved file has exactly the characters that were
// typed. This only marks the tags (a coloured background) and lets a click on one open the Tags
// box. What counts as a tag lives in tagrules.js, the same rules the list of all tags uses.

import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { findTags } from "./tagrules.js";

const markKey = new PluginKey("tagMarks");
// Stands in for anything that is not plain text (a link, code), so it can neither be part of a
// tag nor make one: "[[Page]]#a" has no tag, and the "#" of "`x` #a" still follows a space.
const OTHER = "￼";

// The tags in one paragraph (or heading), with their positions in the document. Text inside code
// is hidden from the rules, the same way the markdown rules hide code spans.
function tagsIn(block, start) {
  let text = "";
  const where = []; // for every letter of `text`, its position in the document
  block.forEach((child, offset) => {
    const at = start + offset;
    if (child.isText) {
      const code = child.marks.some((mark) => mark.type.spec.code);
      for (let i = 0; i < child.text.length; i++) {
        text += code ? OTHER : child.text[i];
        where.push(at + i);
      }
    } else {
      text += child.type.name === "hardBreak" ? "\n" : OTHER;
      where.push(at);
    }
  });
  return findTags(text).map((tag) => ({ name: tag.name, from: where[tag.start], to: where[tag.end - 1] + 1 }));
}

function markTags(doc) {
  const marks = [];
  doc.descendants((node, pos) => {
    if (node.isTextblock) {
      if (!node.type.spec.code && node.textContent.includes("#")) {
        for (const tag of tagsIn(node, pos + 1)) marks.push(Decoration.inline(tag.from, tag.to, { class: "tag", "data-tag": tag.name }));
      }
      return false;
    }
    return true;
  });
  return DecorationSet.create(doc, marks);
}

export const Tags = Extension.create({
  name: "tagMarks",

  addOptions() {
    return { open: () => {} };
  },

  addProseMirrorPlugins() {
    const { options } = this;
    return [
      new Plugin({
        key: markKey,
        state: {
          init: (_config, state) => markTags(state.doc),
          apply: (tr, old, _before, state) => (tr.docChanged ? markTags(state.doc) : old),
        },
        props: {
          decorations: (state) => markKey.getState(state),
          handleDOMEvents: {
            click(view, event) {
              const target = event.target instanceof Element ? event.target.closest(".tag") : null;
              if (!target || !view.dom.contains(target) || !target.dataset.tag) return false;
              // Only a plain click opens the box: selecting text that includes a tag must still work.
              if (!view.state.selection.empty || event.shiftKey) return false;
              options.open(target.dataset.tag);
              return true;
            },
          },
        },
      }),
    ];
  },
});
