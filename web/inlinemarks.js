// The editor side of the text styles in inlinestyles.js: highlight, subscript, superscript and
// colour (underline comes with the editor's starter kit and writes the same <u> tag).
//
// Each one is a Tiptap mark that knows how to read its markdown (a tokenizer plus parseMarkdown)
// and how to write it (renderMarkdown). The pattern is the one the library's own underline mark
// uses. Colour is only ever drawn through a CSS class chosen from the palette, because the page's
// security policy does not allow inline style attributes.

import { Mark, mergeAttributes } from "@tiptap/core";
import { COLOR_OPEN_SOURCE, HIGHLIGHT_SOURCE, PALETTE, colorOpenTag, paletteEntry } from "./inlinestyles.js";

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

// <span style="color: #f72525">text</span>, for the palette colours only. Any other colour (from
// another program) is not recognised here, so compose.js keeps that paragraph raw instead.
export const TextColor = Mark.create({
  name: "textColor",
  addAttributes() {
    return {
      color: {
        default: null,
        parseHTML: (element) => element.getAttribute("data-text-color"),
        renderHTML: (attributes) => {
          const entry = paletteEntry(attributes.color);
          return entry ? { "data-text-color": entry.hex, class: `text-color tc-${entry.name}` } : {};
        },
      },
    };
  },
  parseHTML: () => [{ tag: "span[data-text-color]", getAttrs: (element) => (paletteEntry(element.getAttribute("data-text-color")) ? null : false) }],
  renderHTML: ({ HTMLAttributes }) => ["span", mergeAttributes(HTMLAttributes), 0],
  parseMarkdown: (token, helpers) => helpers.applyMark("textColor", helpers.parseInline(token.tokens || []), { color: token.color }),
  renderMarkdown: (node, helpers) => {
    const entry = paletteEntry(node.attrs && node.attrs.color);
    const inner = helpers.renderChildren(node);
    return entry ? `${colorOpenTag(entry.hex)}${inner}</span>` : inner;
  },
  markdownTokenizer: pairTokenizer({
    name: "textColor",
    openStart: /<span style="color:/i,
    openAnchored: new RegExp(`^${COLOR_OPEN_SOURCE}`, "i"),
    close: "</span>",
    // Only palette colours, and no span inside (spans do not nest here).
    accept: (text, open) => !/<span/i.test(text) && paletteEntry(open[1]) !== null,
    extra: (open) => ({ color: paletteEntry(open[1]).hex }),
  }),
  addCommands() {
    return {
      setTextColor: (color) => ({ commands }) => {
        const entry = paletteEntry(color);
        return entry ? commands.setMark("textColor", { color: entry.hex }) : false;
      },
      unsetTextColor: () => ({ commands }) => commands.unsetMark("textColor"),
    };
  },
});

export { PALETTE };
