// Editor nodes for callouts, toggles, images and tables. How they are read from and written
// to markdown lives in richblocks.js; this file is only how they look and behave on screen.

import { HANDLES, keyDelta, resizeBy } from "./imagesize.js";
import { Node } from "@tiptap/core";
import { liftEmptyBlock } from "@tiptap/pm/commands";
import { Table, TableCell, TableHeader, TableRow } from "@tiptap/extension-table";
import { MAX_COLUMNS, MIN_COLUMNS } from "./richblocks.js";
import { icon } from "./icons.js";
import { strings } from "./strings.js";
import { flipFold, isFoldedBy } from "./togglefold.js";

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
// `dom` is the whole block. Its class changes when a toggle is folded; that is only a view
// state, so the editor must not take it for an edit and undo it.
function headerGuards(head, dom) {
  head.contentEditable = "false";
  return {
    stopEvent: (event) => head.contains(event.target),
    ignoreMutation: (mutation) => head.contains(mutation.target) || (dom !== undefined && mutation.type === "attributes" && mutation.target === dom && mutation.attributeName === "class"),
  };
}

// What a callout or toggle may hold. It has to match the block kinds that richblocks.js can
// read back, or the block would turn into a raw block the next time the note is opened.
// A callout, toggle, table or image inside one is allowed (a callout in a toggle is common).
const INNER_BLOCKS = "(paragraph | heading | bulletList | orderedList | taskList | blockquote | codeBlock | horizontalRule | callout | toggle | table | imageBlock)+";

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

// Side-by-side columns. How they are stored is in richblocks.js (a callout holding callouts).
// A column holds the same blocks as a callout; columns do not nest.
export const Columns = Node.create({
  name: "columns",
  group: "block",
  content: `column{${MIN_COLUMNS},${MAX_COLUMNS}}`,
  isolating: true,
  defining: true,
  parseHTML() {
    return [{ tag: "div[data-columns]" }];
  },
  renderHTML() {
    return ["div", { "data-columns": "", class: "columns" }, 0];
  },
});

export const Column = Node.create({
  name: "column",
  content: INNER_BLOCKS,
  isolating: true,
  defining: true,
  parseHTML() {
    return [{ tag: "div[data-column]" }];
  },
  renderHTML() {
    return ["div", { "data-column": "", class: "column" }, 0];
  },
});

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
    return ({ node, getPos, editor, decorations }) => {
      let current = node;
      const dom = make("div", "toggle");
      const head = make("div", "toggle-head");
      // Folding is only a view: it is not saved in the note. Which toggles are folded is kept
      // by the editor (togglefold.js), which also puts the "folded" class on this block.
      const fold = make("button", "toggle-fold");
      fold.type = "button";
      fold.setAttribute("aria-expanded", "true");
      fold.setAttribute("aria-label", strings.toggle.fold);
      fold.append(icon("chevronDown"));
      const summary = make("input", "toggle-summary");
      summary.type = "text";
      summary.maxLength = 200;
      summary.placeholder = strings.toggle.summaryPlaceholder;
      summary.setAttribute("aria-label", strings.toggle.summaryLabel);
      const body = make("div", "toggle-body");
      const showFold = (deco) => fold.setAttribute("aria-expanded", String(!isFoldedBy(deco)));
      fold.addEventListener("click", () => {
        const position = getPos();
        if (typeof position === "number") flipFold(editor.view, position);
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
      showFold(decorations);
      return {
        dom,
        contentDOM: body,
        update(updated, deco) {
          if (updated.type !== current.type) return false;
          current = updated;
          if (summary.value !== current.attrs.summary) summary.value = current.attrs.summary;
          showFold(deco);
          return true;
        },
        ...headerGuards(head, dom),
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
      // A size in pixels, or null for the natural size. Written as `alt|width` or `alt|widthxheight`.
      width: { default: null, rendered: false },
      height: { default: null, rendered: false },
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
      // The sizer is exactly as big as the picture, so the handles sit on its edges.
      const sizer = make("div", "image-sizer");
      const img = make("img", "image-img");
      const missing = make("p", "image-missing", strings.image.missing);
      missing.hidden = true;
      const reset = make("button", "image-reset", strings.image.resetSize);
      reset.type = "button";
      reset.setAttribute("aria-label", strings.image.resetSizeLabel);
      const handles = HANDLES.map((place) => {
        const handle = make("span", `image-handle image-handle-${place}`);
        handle.dataset.handle = place;
        handle.tabIndex = 0;
        handle.setAttribute("role", "button");
        handle.setAttribute("aria-label", strings.image.handleLabel.replace("{place}", strings.image.places[place]));
        return handle;
      });
      const alt = make("input", "image-alt");
      alt.type = "text";
      alt.maxLength = 300;
      alt.placeholder = strings.image.altPlaceholder;
      alt.setAttribute("aria-label", strings.image.altLabel);
      sizer.append(img, ...handles);
      frame.append(sizer, missing);
      // The reset button sits next to the description, not on the picture, so it never covers a handle.
      const caption = make("div", "image-caption");
      caption.append(alt, reset);
      dom.append(frame, caption);

      // Shows a size without saving it; null sides mean the natural size.
      const paint = (width, height) => {
        sizer.classList.toggle("is-sized", Boolean(width));
        sizer.style.width = width ? `${width}px` : "";
        img.style.aspectRatio = width && height ? `${width} / ${height}` : "";
      };
      const paintSaved = () => {
        paint(current.attrs.width, current.attrs.height);
        reset.hidden = !current.attrs.width;
      };
      const commit = (width, height) => {
        setAttrs(editor, getPos, current, { width, height });
      };
      const loaded = () => img.naturalWidth > 0 && Boolean(img.getAttribute("src"));

      let shownPath = null;
      const show = () => {
        img.alt = current.attrs.alt;
        if (alt.value !== current.attrs.alt) alt.value = current.attrs.alt;
        paintSaved();
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

      // What the picture measures now, in page pixels (a zoomed page scales what the screen shows).
      const measure = () => {
        const box = img.getBoundingClientRect();
        const scale = img.offsetWidth > 0 ? box.width / img.offsetWidth : 1;
        return {
          scale: scale > 0 ? scale : 1,
          start: { width: img.offsetWidth, height: img.offsetHeight, explicitHeight: Boolean(current.attrs.height) },
          room: frame.clientWidth,
        };
      };

      let drag = null;
      const endDrag = (save) => {
        if (!drag) return;
        const finished = drag;
        drag = null;
        if (save && finished.result) commit(finished.result.width, finished.result.height);
        else paintSaved();
      };
      handles.forEach((handle) => {
        const place = handle.dataset.handle;
        handle.addEventListener("pointerdown", (event) => {
          if (!editor.isEditable || !loaded() || event.button > 0) return;
          event.preventDefault();
          event.stopPropagation();
          handle.setPointerCapture?.(event.pointerId);
          drag = { place, x: event.clientX, y: event.clientY, id: event.pointerId, ...measure(), result: null };
        });
        handle.addEventListener("pointermove", (event) => {
          if (!drag || event.pointerId !== drag.id) return;
          const dx = (event.clientX - drag.x) / drag.scale;
          const dy = (event.clientY - drag.y) / drag.scale;
          drag.result = resizeBy(place, drag.start, dx, dy, drag.room);
          paint(drag.result.width, drag.result.height);
        });
        handle.addEventListener("pointerup", (event) => {
          if (drag && event.pointerId === drag.id) endDrag(true);
        });
        // A pointer taken away (a call, a palm) leaves the picture as it was.
        handle.addEventListener("pointercancel", () => endDrag(false));
        handle.addEventListener("keydown", (event) => {
          if (event.key === "Escape" && drag) {
            event.preventDefault();
            endDrag(false);
            return;
          }
          const delta = keyDelta(event.key);
          if (!delta || !editor.isEditable || !loaded()) return;
          event.preventDefault();
          const { start, room } = measure();
          const next = resizeBy(place, start, delta[0], delta[1], room);
          commit(next.width, next.height);
        });
      });
      reset.addEventListener("click", () => {
        if (!editor.isEditable) return;
        commit(null, null);
        // Keep the editor in charge of the keyboard, so Ctrl+Z undoes this.
        editor.commands.focus();
      });

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
        stopEvent: (event) => alt.contains(event.target) || handles.some((h) => h.contains(event.target)) || reset.contains(event.target),
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
