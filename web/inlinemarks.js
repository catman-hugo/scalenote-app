// The editor side of the text styles in inlinestyles.js: highlight, subscript, superscript and
// colour (underline comes with the editor's starter kit and writes the same <u> tag).
//
// Each one is a Tiptap mark that knows how to read its markdown (a tokenizer plus parseMarkdown)
// and how to write it (renderMarkdown). The pattern is the one the library's own underline mark
// uses. Colour is only ever drawn through a CSS class chosen from the palette, because the page's
// security policy does not allow inline style attributes.

import { Mark, mergeAttributes } from "@tiptap/core";
import { COLOURS, COLOUR_OPEN_SOURCE, HIGHLIGHT_SOURCE, colourOpenTag, isColour, parseColourTag } from "./inlinestyles.js";

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// A tokenizer for "<open>text<close>". It looks for the closing marker the way the library's
// underline does: backslash escapes and code spans are skipped, so a "</sub>" inside `code` does
// not end the style. `accept` may refuse a match (the colour mark refuses nested spans and colours outside the palette).
function pairTokenizer({ name, openStart, openAnchored, close, accept = () => true, extra = () => ({}) }) {
  return {
    name,
    level: "inline",
    start: (src) => src.search(openStart),
    tokenize(src, _tokens, lexer) {
      const open = openAnchored.exec(src);
      if (!open) return undefined;
      const delimiters = new RegExp(`\\\\[\\s\\S]|\`+|${escapeRegExp(close)}`, "gi");
      delimiters.lastIndex = open[0].length;
      let match = delimiters.exec(src);
      while (match) {
        if (match[0].startsWith("`")) {
          const codeSpan = /^(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/.exec(src.slice(match.index));
          if (codeSpan) delimiters.lastIndex = match.index + codeSpan[0].length;
        } else if (!match[0].startsWith("\\")) {
          const text = src.slice(open[0].length, match.index);
          if (!text || !accept(text, open)) return undefined;
          return { type: name, raw: src.slice(0, delimiters.lastIndex), text, tokens: lexer.inlineTokens(text), ...extra(open) };
        }
        match = delimiters.exec(src);
      }
      return undefined;
    },
  };
}

function tagMark({ name, tag, shortcut, excludes, commands }) {
  return Mark.create({
    name,
    excludes,
    parseHTML: () => [{ tag }],
    renderHTML: ({ HTMLAttributes }) => [tag, mergeAttributes(HTMLAttributes), 0],
    parseMarkdown: (token, helpers) => helpers.applyMark(name, helpers.parseInline(token.tokens || [])),
    renderMarkdown: (node, helpers) => `<${tag}>${helpers.renderChildren(node)}</${tag}>`,
    markdownTokenizer: pairTokenizer({
      name,
      openStart: new RegExp(`<${tag}>`, "i"),
      openAnchored: new RegExp(`^<${tag}>`, "i"),
      close: `</${tag}>`,
    }),
    addCommands() {
      return {
        [commands.toggle]: () => ({ commands: c }) => c.toggleMark(name),
        [commands.unset]: () => ({ commands: c }) => c.unsetMark(name),
      };
    },
    addKeyboardShortcuts() {
      return { [shortcut]: () => this.editor.commands[commands.toggle]() };
    },
  });
}

export const Subscript = tagMark({ name: "subscript", tag: "sub", shortcut: "Mod-,", excludes: "superscript", commands: { toggle: "toggleSubscript", unset: "unsetSubscript" } });
export const Superscript = tagMark({ name: "superscript", tag: "sup", shortcut: "Mod-.", excludes: "subscript", commands: { toggle: "toggleSuperscript", unset: "unsetSuperscript" } });

// ==text==. The markers must hug the text, so spaces at the edges of the styled stretch are put
// outside them when writing ("==hello ==" would not be read back as a highlight).
export const Highlight = Mark.create({
  name: "highlight",
  parseHTML: () => [{ tag: "mark" }],
  renderHTML: ({ HTMLAttributes }) => ["mark", mergeAttributes(HTMLAttributes, { class: "text-highlight" }), 0],
  parseMarkdown: (token, helpers) => helpers.applyMark("highlight", helpers.parseInline(token.tokens || [])),
  renderMarkdown: (node, helpers) => {
    const inner = helpers.renderChildren(node);
    const [, before, text, after] = /^(\s*)([\s\S]*?)(\s*)$/.exec(inner);
    return text === "" ? inner : `${before}==${text}==${after}`;
  },
  markdownTokenizer: {
    name: "highlight",
    level: "inline",
    start: (src) => src.indexOf("=="),
    tokenize(src, _tokens, lexer) {
      const match = new RegExp(`^${HIGHLIGHT_SOURCE}`).exec(src);
      if (!match) return undefined;
      return { type: "highlight", raw: match[0], text: match[1], tokens: lexer.inlineTokens(match[1]) };
    },
  },
  addCommands() {
    return {
      toggleHighlight: () => ({ commands }) => commands.toggleMark("highlight"),
      unsetHighlight: () => ({ commands }) => commands.unsetMark("highlight"),
    };
  },
  addKeyboardShortcuts() {
    return { "Mod-Shift-h": () => this.editor.commands.toggleHighlight() };
  },
});

// <span class="sn-text-red sn-bg-yellow">text</span>: a text colour, a background colour, or
// both, from the fixed list in inlinestyles.js. One mark holds both, so the words get one span.
// Colours from another program (any other class or colour code) are not recognised here, so
// compose.js keeps that paragraph raw instead. The 0.2.9 form (<span style="color: #hex">, for
// the old eight text colours) is still read.
const colourAttribute = (kind) => ({
  default: null,
  parseHTML: (element) => {
    const value = element.getAttribute(`data-${kind}-colour`);
    return isColour(value) ? value : null;
  },
  renderHTML: (attributes) => (isColour(attributes[kind]) ? { [`data-${kind}-colour`]: attributes[kind] } : {}),
});

export const Colour = Mark.create({
  name: "colour",
  addAttributes() {
    return { text: colourAttribute("text"), bg: colourAttribute("bg") };
  },
  parseHTML: () => [{ tag: "span[data-text-colour], span[data-bg-colour]" }],
  renderHTML: ({ mark, HTMLAttributes }) => {
    const { text, bg } = mark.attrs;
    // The look comes from classes (the page's security policy does not allow style attributes).
    const classes = ["text-colour", isColour(text) ? `sn-text-${text}` : "", isColour(bg) ? `sn-bg-${bg}` : ""].filter(Boolean).join(" ");
    return ["span", mergeAttributes(HTMLAttributes, { class: classes }), 0];
  },
  parseMarkdown: (token, helpers) => helpers.applyMark("colour", helpers.parseInline(token.tokens || []), { text: token.colourText, bg: token.colourBg }),
  renderMarkdown: (node, helpers) => {
    const text = isColour(node.attrs && node.attrs.text) ? node.attrs.text : null;
    const bg = isColour(node.attrs && node.attrs.bg) ? node.attrs.bg : null;
    const inner = helpers.renderChildren(node);
    return text || bg ? `${colourOpenTag({ text, bg })}${inner}</span>` : inner;
  },
  markdownTokenizer: pairTokenizer({
    name: "colour",
    openStart: /<span (?:class="sn-|style="color:)/i,
    openAnchored: new RegExp(`^(?:${COLOUR_OPEN_SOURCE})`, "i"),
    close: "</span>",
    // Only our own forms, and no span inside (spans do not nest here).
    accept: (text, open) => !/<span/i.test(text) && parseColourTag(open[1] && open[1].toLowerCase(), open[2]) !== null,
    extra: (open) => {
      const colour = parseColourTag(open[1] && open[1].toLowerCase(), open[2]);
      return { colourText: colour.text, colourBg: colour.bg };
    },
  }),
  addCommands() {
    return {
      // Sets one kind ("text" or "bg") to a colour name, or takes it off with null, on every
      // piece of text in the selection. The other kind is kept as it was on each piece.
      setColour: (kind, name) => ({ tr, dispatch }) => {
        if ((kind !== "text" && kind !== "bg") || (name !== null && !isColour(name))) return false;
        const type = this.type;
        let changed = false;
        for (const range of tr.selection.ranges) {
          const from = range.$from.pos;
          const to = range.$to.pos;
          if (from === to) continue;
          tr.doc.nodesBetween(from, to, (node, pos) => {
            if (!node.isText) return;
            const start = Math.max(pos, from);
            const end = Math.min(pos + node.nodeSize, to);
            const existing = node.marks.find((mark) => mark.type === type);
            const attrs = { text: existing ? existing.attrs.text : null, bg: existing ? existing.attrs.bg : null };
            attrs[kind] = name;
            tr.removeMark(start, end, type);
            if (attrs.text || attrs.bg) tr.addMark(start, end, type.create(attrs));
            changed = true;
          });
        }
        return dispatch ? changed : true;
      },
    };
  },
});

export { COLOURS };
