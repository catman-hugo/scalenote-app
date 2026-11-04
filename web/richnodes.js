// Editor nodes for callouts, toggles, images and tables. How they are read from and written
// to markdown lives in richblocks.js; this file is only how they look and behave on screen.

import { Node } from "@tiptap/core";
import { liftEmptyBlock } from "@tiptap/pm/commands";
import { Table, TableCell, TableHeader, TableRow } from "@tiptap/extension-table";
import { strings } from "./strings.js";

function make(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

// Changes the attributes of the node a view belongs to, as one editor step.
function setAttrs(editor, getPos, current, changes) {
  const position = getPos();
  if (typeof position !== "number") return;
  editor.view.dispatch(editor.view.state.tr.setNodeMarkup(position, undefined, { ...current.attrs, ...changes }));
}

// Marks a header area as not part of the text, so typing in it never reaches the editor.
function headerGuards(head) {
  head.contentEditable = "false";
  return {
    stopEvent: (event) => head.contains(event.target),
    ignoreMutation: (mutation) => head.contains(mutation.target),
  };
}

// What a callout or toggle may hold. It has to match the block kinds that richblocks.js can
// read back, or the block would turn into a raw block the next time the note is opened.
const INNER_BLOCKS = "(paragraph | heading | bulletList | orderedList | taskList | blockquote | codeBlock | horizontalRule)+";

// Enter on an empty last line of a callout or toggle leaves it, like leaving a list.
function leaveOnEmptyEnter(name) {
  return ({ editor }) => {
    const { selection } = editor.state;
    const { $from } = selection;
    if (!selection.empty || $from.parent.type.name !== "paragraph" || $from.parent.content.size !== 0) return false;
    const parent = $from.node(-1);
    if (!parent || parent.type.name !== name || $from.index(-1) !== parent.childCount - 1 || parent.childCount < 2) return false;
    return editor.commands.command(({ state, dispatch }) => liftEmptyBlock(state, dispatch));
  };
}

export const CALLOUT_KINDS = ["note", "info", "tip", "success", "question", "warning", "danger", "example", "quote"];

export const Callout = Node.create({
  name: "callout",
  group: "block",
  content: INNER_BLOCKS,
  defining: true,
  addKeyboardShortcuts() {
    return { Enter: leaveOnEmptyEnter("callout") };
  },
  addAttributes() {
    return {
      kind: { default: "note", rendered: false },
      fold: { default: "", rendered: false },
      title: { default: "", rendered: false },
    };
  },
  parseHTML() {
    return [{ tag: "div[data-callout]" }];
  },
  renderHTML({ node }) {
    return ["div", { "data-callout": node.attrs.kind, class: "callout" }, 0];
  },
  addNodeView() {
    return ({ node, getPos, editor }) => {
      let current = node;
      const dom = make("div", "callout");
      const head = make("div", "callout-head");
      const kind = make("select", "callout-kind");
      kind.setAttribute("aria-label", strings.callout.kindLabel);
      const title = make("input", "callout-title");
      title.type = "text";
      title.maxLength = 200;
      title.placeholder = strings.callout.titlePlaceholder;
      title.setAttribute("aria-label", strings.callout.titleLabel);
      const body = make("div", "callout-body");

      const fillKinds = () => {
        const kinds = CALLOUT_KINDS.includes(current.attrs.kind) ? CALLOUT_KINDS : [...CALLOUT_KINDS, current.attrs.kind];
        kind.replaceChildren(
          ...kinds.map((value) => {
            const option = make("option", "", strings.callout.kinds[value] || value);
            option.value = value;
            return option;
          }),
        );
      };
      const sync = () => {
        dom.dataset.kind = current.attrs.kind;
        fillKinds();
        kind.value = current.attrs.kind;
        if (title.value !== current.attrs.title) title.value = current.attrs.title;
      };
      kind.addEventListener("change", () => setAttrs(editor, getPos, current, { kind: kind.value }));
      title.addEventListener("input", () => setAttrs(editor, getPos, current, { title: title.value }));
      head.append(kind, title);
      dom.append(head, body);
      sync();
      const guards = headerGuards(head);
      return {
        dom,
        contentDOM: body,
        update(updated) {
          if (updated.type !== current.type) return false;
          current = updated;
          sync();
          return true;
        },
        ...guards,
      };
    };
  },
});

export const Toggle = Node.create({
  name: "toggle",
  group: "block",
  content: INNER_BLOCKS,
  defining: true,
  addKeyboardShortcuts() {
    return { Enter: leaveOnEmptyEnter("toggle") };
  },
  addAttributes() {
    return {
      summary: { default: "", rendered: false },
      open: { default: false, rendered: false },
    };
  },
  parseHTML() {
    return [{ tag: "div[data-toggle]" }];
  },
  renderHTML() {
    return ["div", { "data-toggle": "", class: "toggle" }, 0];
  },
  addNodeView() {
    return ({ node, getPos, editor }) => {
      let current = node;
      const dom = make("div", "toggle");
      const head = make("div", "toggle-head");
      // Folding is only a view: it is not saved in the note.
      const fold = make("button", "toggle-fold");
      fold.type = "button";
      fold.setAttribute("aria-expanded", "true");
      fold.setAttribute("aria-label", strings.toggle.fold);
      fold.textContent = strings.toggle.foldMark;
      const summary = make("input", "toggle-summary");
      summary.type = "text";
      summary.maxLength = 200;
      summary.placeholder = strings.toggle.summaryPlaceholder;
      summary.setAttribute("aria-label", strings.toggle.summaryLabel);
      const body = make("div", "toggle-body");
      fold.addEventListener("click", () => {
        const folded = dom.classList.toggle("folded");
        fold.setAttribute("aria-expanded", String(!folded));
      });
      // The summary line is plain text in the file, so characters that would start html are dropped.
      summary.addEventListener("input", () => {
        const clean = summary.value.replace(/[<>&]/g, "");
        if (clean !== summary.value) summary.value = clean;
        setAttrs(editor, getPos, current, { summary: clean });
      });
      head.append(fold, summary);
      dom.append(head, body);
      summary.value = current.attrs.summary;
      return {
        dom,
        contentDOM: body,
        update(updated) {
          if (updated.type !== current.type) return false;
          current = updated;
          if (summary.value !== current.attrs.summary) summary.value = current.attrs.summary;
          return true;
        },
        ...headerGuards(head),
      };
    };
  },
});

// A picture on its own line. `load(path)` resolves to a data: address for the file, or
// rejects when the file is missing or not a picture; then a calm message is shown instead.
export const ImageBlock = Node.create({
  name: "imageBlock",
  group: "block",
  atom: true,
  draggable: false,
  addOptions() {
    return { load: async () => { throw new Error("no loader"); } };
  },
  addAttributes() {
    return {
      alt: { default: "", rendered: false },
      path: { default: "", rendered: false },
    };
  },
  parseHTML() {
    return [{ tag: "figure[data-image-block]" }];
  },
  renderHTML({ node }) {
    return ["figure", { "data-image-block": "" }, node.attrs.path];
  },
  addNodeView() {
    const { load } = this.options;
    return ({ node, getPos, editor }) => {
      let current = node;
      const dom = make("figure", "image-block");
      const frame = make("div", "image-frame");
      const img = make("img", "image-img");
      const missing = make("p", "image-missing", strings.image.missing);
      missing.hidden = true;
      const alt = make("input", "image-alt");
      alt.type = "text";
      alt.maxLength = 300;
      alt.placeholder = strings.image.altPlaceholder;
      alt.setAttribute("aria-label", strings.image.altLabel);
      frame.append(img, missing);
      dom.append(frame, alt);

      let shownPath = null;
      const show = () => {
        img.alt = current.attrs.alt;
        if (alt.value !== current.attrs.alt) alt.value = current.attrs.alt;
        if (shownPath === current.attrs.path) return;
        shownPath = current.attrs.path;
        const wanted = shownPath;
        img.removeAttribute("src");
        missing.hidden = true;
        load(wanted).then(
          (address) => {
            if (shownPath !== wanted) return;
            img.src = address;
          },
          () => {
            if (shownPath !== wanted) return;
            missing.hidden = false;
          },
        );
      };
      alt.addEventListener("input", () => setAttrs(editor, getPos, current, { alt: alt.value.replace(/[\[\]\n]/g, " ") }));
      show();
      return {
        dom,
        update(updated) {
          if (updated.type !== current.type) return false;
          current = updated;
          show();
          return true;
        },
        stopEvent: (event) => alt.contains(event.target),
        ignoreMutation: () => true,
      };
    };
  },
});

// Tables: the pipe format has one line of text per cell, so a cell holds exactly one
// paragraph. `aligns` remembers the column alignment written in the divider line.
const TableWithAlign = Table.configure({ resizable: false }).extend({
  addAttributes() {
    return { ...this.parent?.(), aligns: { default: null, rendered: false } };
  },
});
const OneLineCell = TableCell.extend({ content: "paragraph" });
const OneLineHeader = TableHeader.extend({ content: "paragraph" });

export const tableExtensions = [TableWithAlign, TableRow, OneLineHeader, OneLineCell];
