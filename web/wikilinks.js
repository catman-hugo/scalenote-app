// [[Page]] links in the editor.
//
// A link is one small inline piece (an "atom") that remembers the exact text it was written
// with, "[[Plan|the plan]]" for example, and writes exactly that back. So a link can never be
// changed just by opening and saving a page, and Obsidian reads the same file the same way.
// What the rules mean (which page is meant, what is a link) lives in wikilinkrules.js.
//
// It also gives the "[[" picker: typing "[[" lists the pages, and choosing one writes the link.

import { InputRule, Node } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import Suggestion from "@tiptap/suggestion";
import { strings } from "./strings.js";
import { createResolver, linkLabel, linkNameFor, parseInner, readLinkAt } from "./wikilinkrules.js";

const PICKER_ROWS = 8;
const redrawKey = new PluginKey("wikilinkStatus");
const pickerKey = new PluginKey("wikilinkPicker");

const stemOf = (path) => path.replace(/\.md$/i, "");
// A file name with any of these cannot be written in a link.
const UNLINKABLE = /[[\]|#\n]/;

function infoOf(raw) {
  return parseInner(raw.slice(2, -2)) || { page: raw, anchor: null, alias: null };
}

// What the "[[" picker offers for the text typed so far. Anything typed after a "#" or "|" is
// kept and written after the chosen name, so "[[Pla#Goals" becomes "[[Plan#Goals]]".
function pickerItems(query, storage) {
  const typed = query.replace(/\]+$/, "");
  const cut = typed.search(/[#|]/);
  const name = (cut === -1 ? typed : typed.slice(0, cut)).trim();
  const suffix = cut === -1 ? "" : typed.slice(cut);
  const wanted = name.toLowerCase();
  const rows = storage.pages
    .filter((path) => !UNLINKABLE.test(stemOf(path)))
    .map((path) => ({ path, stem: stemOf(path).slice(stemOf(path).lastIndexOf("/") + 1) }))
    .filter(({ stem }) => stem.toLowerCase().includes(wanted))
    .sort((a, b) => Number(!a.stem.toLowerCase().startsWith(wanted)) - Number(!b.stem.toLowerCase().startsWith(wanted)) || a.stem.length - b.stem.length || (a.path < b.path ? -1 : 1))
    .slice(0, PICKER_ROWS);
  const items = rows.map(({ path, stem }) => {
    const folder = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
    return { title: folder ? `${stem}  ·  ${folder}` : stem, name: linkNameFor(path, storage.from, storage.resolver), suffix };
  });
  const exact = rows.some(({ stem }) => stem.toLowerCase() === wanted);
  if (name && !exact && !UNLINKABLE.test(name)) items.push({ title: strings.wikilinks.linkTo.replace("{name}", name), name, suffix });
  return items;
}

export const Wikilink = Node.create({
  name: "wikilink",
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,

  addOptions() {
    return { follow: () => {}, renderPicker: () => ({}) };
  },

  // The pages of the vault and the page being edited, set from main.js (see updateWikilinks).
  addStorage() {
    return { pages: [], from: "", resolver: createResolver([]) };
  },

  addAttributes() {
    return { raw: { default: "[[]]", rendered: false } };
  },

  parseHTML() {
    return [{ tag: "span[data-wikilink]", getAttrs: (dom) => ({ raw: dom.getAttribute("data-wikilink") }) }];
  },

  renderHTML({ node }) {
    const raw = node.attrs.raw;
    return ["span", { class: "wikilink", "data-wikilink": raw, role: "link" }, linkLabel(infoOf(raw))];
  },

  // Copying a link to another program copies its text.
  renderText({ node }) {
    return node.attrs.raw;
  },

  markdownTokenizer: {
    name: "wikilink",
    level: "inline",
    start: (src) => src.indexOf("[["),
    tokenize(src) {
      const link = src.startsWith("[[") ? readLinkAt(src, 0) : null;
      return link ? { type: "wikilink", raw: src.slice(0, link.end) } : undefined;
    },
  },
  parseMarkdown: (token, helpers) => helpers.createNode("wikilink", { raw: token.raw }),
  renderMarkdown: (node) => node.attrs.raw,

  // Typing the closing "]]" turns the text into a link.
  addInputRules() {
    return [
      new InputRule({
        find: /\[\[[^[\]\n]{1,300}\]\]$/,
        handler: ({ state, range, match }) => {
          const $from = state.doc.resolve(range.from);
          const inCode = $from.parent.type.spec.code || $from.marks().some((mark) => mark.type.spec.code);
          if (inCode || !readLinkAt(match[0], 0)) return null;
          state.tr.replaceWith(range.from, range.to, this.type.create({ raw: match[0] }));
          return undefined;
        },
      }),
    ];
  },

  addProseMirrorPlugins() {
    const { storage, options, editor } = this;
    // Which links point nowhere. Worked out again when the text changes or the list of pages does.
    const unresolved = (doc) => {
      const marks = [];
      doc.descendants((node, pos) => {
        if (node.type.name !== "wikilink") return node.isBlock || node.childCount > 0;
        const { page } = infoOf(node.attrs.raw);
        if (page && !storage.resolver.resolve(page, storage.from)) {
          marks.push(Decoration.node(pos, pos + node.nodeSize, { class: "unresolved", title: strings.wikilinks.unresolved }));
        }
        return false;
      });
      return DecorationSet.create(doc, marks);
    };
    return [
      new Plugin({
        key: redrawKey,
        state: {
          init: (_config, state) => unresolved(state.doc),
          apply: (tr, old, _before, state) => (tr.docChanged || tr.getMeta(redrawKey) ? unresolved(state.doc) : old),
        },
        props: {
          decorations(state) {
            return redrawKey.getState(state);
          },
          handleDOMEvents: {
            click(view, event) {
              const target = event.target instanceof Element ? event.target.closest(".wikilink") : null;
              if (!target || !view.dom.contains(target)) return false;
              event.preventDefault();
              const position = view.posAtDOM(target, 0);
              const node = view.state.doc.nodeAt(position);
              if (node && node.type.name === "wikilink") options.follow(infoOf(node.attrs.raw));
              return true;
            },
          },
        },
      }),
      Suggestion({
        editor,
        pluginKey: pickerKey,
        char: "[[",
        startOfLine: false,
        allowSpaces: true,
        allowedPrefixes: null,
        allow: ({ state, range }) => {
          const $from = state.doc.resolve(range.from);
          return !$from.parent.type.spec.code && !$from.marks().some((mark) => mark.type.spec.code);
        },
        items: ({ query }) => pickerItems(query, storage),
        command: ({ editor: e, range, props }) => {
          const raw = `[[${props.name}${props.suffix.replace(/\]+$/, "")}]]`;
          e.chain().focus().insertContentAt(range, { type: "wikilink", attrs: { raw } }).run();
        },
        render: () => options.renderPicker(),
      }),
    ];
  },
});

/** Tells the editor which pages exist and which one is open, and redraws the links. */
export function updateWikilinks(editor, { pages, from }) {
  const storage = editor.storage.wikilink;
  storage.pages = pages;
  storage.from = from;
  storage.resolver = createResolver(pages);
  editor.view.dispatch(editor.state.tr.setMeta(redrawKey, true).setMeta("addToHistory", false));
}
