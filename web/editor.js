// The block editor: Tiptap with a slash menu, plus the pieces that keep markdown safe.

import { Editor, Extension, Node } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { Markdown } from "@tiptap/markdown";
import { TaskItem, TaskList } from "@tiptap/extension-list";
import { Placeholder } from "@tiptap/extensions";
import Suggestion from "@tiptap/suggestion";
import { strings } from "./strings.js";
import { Callout, Column, Columns, ImageBlock, Toggle, tableExtensions } from "./richnodes.js";
import { FindMarks } from "./findmarks.js";
import { PdfBlock } from "./pdfblock.js";
import { askPdfMode, choosePdf, importPages, looksLikePdf, showProgress, storePdf } from "./pdfimport.js";
import { pdfTitle } from "./pdfrules.js";
import { CanvasBlock } from "./canvasblock.js";
import { attachToolbars } from "./toolbar.js";
import { attachGutter } from "./gutter.js";
import { Plugin } from "@tiptap/pm/state";
import { choosePicture, checkPicture, storePicture } from "./images.js";
import { Highlight, Subscript, Superscript, Colour } from "./inlinemarks.js";
import { Tags } from "./tags.js";
import { Wikilink } from "./wikilinks.js";
import { ToggleFold } from "./togglefold.js";

// Pictures: the same path for paste, drop and the slash menu. The file is copied into the
// vault first, and only then an image block is placed in the note.
// `create()` makes a region in the page's drawing and resolves to its id, or null when it cannot.
let canvasOptions = { create: async () => null };
let pictureOptions = { onProblem: () => {}, noteKey: () => null, pdfDialog: () => null, jobCard: () => null, pageToken: () => null, addToPage: async () => {}, notify: () => {} };

async function insertPictures(editor, files, position) {
  const key = pictureOptions.noteKey();
  for (const file of files) {
    try {
      const path = await storePicture(file);
      // The user may have opened another note while the file was being copied.
      if (pictureOptions.noteKey() !== key) return;
      if (typeof position === "number") editor.commands.setTextSelection(Math.min(position, editor.state.doc.content.size));
      editor.chain().focus().insertContent([{ type: "imageBlock", attrs: { alt: "", path } }, { type: "paragraph" }]).run();
      position = undefined;
    } catch (error) {
      pictureOptions.onProblem(error && error.code ? error.code : "unknown");
    }
  }
}

// Only one PDF is added at a time, so two imports never fight over the same page.
let importing = false;

// A PDF: asks how to add it, stores what is needed in the vault, and only then changes the page.
// Adding pages as pictures can take minutes, so it runs in the background behind a small
// progress card and the person can keep working, even on another page. When it is done the
// pictures go where they were asked for: at the same spot if the page stayed open (the spot
// moves along with the text typed meanwhile), otherwise at the end of that page.
async function insertPdf(editor, file, position) {
  const dialog = pictureOptions.pdfDialog();
  const card = pictureOptions.jobCard();
  if (!dialog || !card) return;
  if (importing) {
    pictureOptions.onProblem("import_busy");
    return;
  }
  importing = true;
  let progress = null;
  let follow = null;
  try {
    const mode = await askPdfMode(dialog, file.name);
    dialog.close();
    if (!mode) return;
    const key = pictureOptions.noteKey();
    const token = pictureOptions.pageToken();
    let at = typeof position === "number" ? position : editor.state.selection.to;
    follow = ({ transaction }) => {
      if (transaction.docChanged) at = transaction.mapping.map(at);
    };
    editor.on("transaction", follow);
    progress = showProgress(card, file.name);
    let content;
    let pages;
    if (mode === "scroll") {
      progress.update(0, 1);
      const path = await storePdf(file);
      content = [{ type: "pdfBlock", attrs: { alt: pdfTitle(file.name), path } }, { type: "paragraph" }];
    } else {
      pages = await importPages(file, { progress: progress.update, stopped: progress.stopped });
      if (!pages) return;
      content = pages.flatMap((page) => [{ type: "imageBlock", attrs: { alt: page.alt, path: page.path } }, { type: "paragraph" }]);
    }
    if (token && pictureOptions.pageToken() === token) {
      // The same page was open all the time: put it where it was asked for, without taking the
      // cursor away from what the person is doing.
      editor.commands.insertContentAt(Math.min(at, editor.state.doc.content.size), content);
    } else if (pages) {
      try {
        await pictureOptions.addToPage(key, pages);
      } catch {
        throw Object.assign(new Error("pdf_page_gone"), { code: "pdf_page_gone" });
      }
      pictureOptions.notify(fillText(strings.pdf.doneElsewhere, { count: pages.length, name: pdfTitle(file.name), page: pageTitleOf(key) }));
    } else {
      // A PDF block needs the page open to be placed; the file stays in the vault.
      pictureOptions.onProblem("pdf_page_gone");
    }
  } catch (error) {
    pictureOptions.onProblem(error && error.code ? error.code : "unknown");
  } finally {
    if (follow) editor.off("transaction", follow);
    if (progress) progress.finish();
    importing = false;
  }
}

const fillText = (text, values) => text.replace(/\{(\w+)\}/g, (_, name) => String(values[name] ?? ""));
const pageTitleOf = (key) => String(key || "").split("/").pop().replace(/\.md$/i, "");

const PictureInput = Extension.create({
  name: "pictureInput",
  addProseMirrorPlugins() {
    const editor = this.editor;
    const picturesIn = (list) => Array.from(list || []).filter((file) => file.type.startsWith("image/") || checkPicture(file) === null);
    return [
      new Plugin({
        props: {
          handlePaste(_view, event) {
            const files = picturesIn(event.clipboardData && event.clipboardData.files);
            if (files.length === 0) return false;
            event.preventDefault();
            insertPictures(editor, files);
            return true;
          },
          handleDrop(view, event) {
            const all = Array.from((event.dataTransfer && event.dataTransfer.files) || []);
            if (all.length === 0) return false;
            // Always stop the browser from opening a dropped file in the window.
            event.preventDefault();
            const spot = view.posAtCoords({ left: event.clientX, top: event.clientY });
            const pdf = all.find(looksLikePdf);
            const pictures = picturesIn(all.filter((file) => file !== pdf));
            if (pictures.length + (pdf ? 1 : 0) < all.length) pictureOptions.onProblem("unsupported_type");
            if (pictures.length) insertPictures(editor, pictures, spot ? spot.pos : undefined);
            // One PDF at a time: it asks a question, and several boxes would pile up.
            if (pdf) insertPdf(editor, pdf, pictures.length ? undefined : spot ? spot.pos : undefined);
            return true;
          },
        },
      }),
    ];
  },
});

// Set by createEditor; lets the Mod-k shortcut open the link box in the toolbar.
let toolbars = null;
let gutter = null;
const BlockMoveShortcuts = Extension.create({
  name: "blockMoveShortcuts",
  addKeyboardShortcuts() {
    return {
      "Alt-ArrowUp": () => Boolean(gutter && gutter.moveCurrent(-1)),
      "Alt-ArrowDown": () => Boolean(gutter && gutter.moveCurrent(1)),
    };
  },
});
const LinkShortcut = Extension.create({
  name: "linkShortcut",
  addKeyboardShortcuts() {
    return { "Mod-k": () => (toolbars && !this.editor.state.selection.empty ? (toolbars.openLink(), true) : false) };
  },
});

// Remembers, on every block, the exact text it had when the note was opened (`src`), how
// the editor wrote that same block back then (`base`), and the blank lines after it
// (`gap`). compose.js uses them to write untouched blocks back byte for byte.
const SourceKeeper = Extension.create({
  name: "sourceKeeper",
  addGlobalAttributes() {
    const keep = { default: null, rendered: false };
    return [
      {
        types: ["paragraph", "heading", "bulletList", "orderedList", "taskList", "blockquote", "codeBlock", "horizontalRule", "callout", "columns", "toggle", "table", "imageBlock", "pdfBlock", "canvasBlock"],
        attributes: { src: keep, base: keep, gap: keep, idx: keep },
      },
      // Only paragraphs can carry a block link id on their last line.
      { types: ["paragraph"], attributes: { blockId: keep } },
    ];
  },
});

// A block the editor does not understand (tables, html, wikilinks, callouts...). It is
// shown as plain text in a box and can be edited as text, but is never rewritten by the
// markdown engine, so nothing in it can be lost.
const RawBlock = Node.create({
  name: "rawBlock",
  group: "block",
  atom: true,
  selectable: false,
  addAttributes() {
    return {
      src: { default: "", rendered: false },
      base: { default: null, rendered: false },
      gap: { default: null, rendered: false },
      idx: { default: null, rendered: false },
    };
  },
  parseHTML() {
    return [{ tag: "pre[data-raw-block]" }];
  },
  renderHTML({ node }) {
    return ["pre", { "data-raw-block": "" }, node.attrs.src];
  },
  addNodeView() {
    return ({ node, getPos, editor }) => {
      let current = node;
      const dom = document.createElement("div");
      dom.className = "raw-block";
      // Text the editor cannot show as a block is shown as plain text that looks like the rest
      // of the page, with no frame or label. It is still kept exactly as written, and it is
      // named for a screen reader only.
      const box = document.createElement("textarea");
      box.className = "raw-text";
      box.spellcheck = false;
      box.setAttribute("aria-label", strings.editor.rawLabel);
      box.value = node.attrs.src;
      // The box grows to fit its text, so there is no inner scrollbar and long lines wrap.
      const fit = () => {
        box.style.height = "auto";
        box.style.height = `${box.scrollHeight}px`;
      };
      box.rows = Math.max(1, node.attrs.src.split("\n").length);
      box.addEventListener("input", () => {
        fit();
        const position = getPos();
        if (typeof position !== "number") return;
        editor.view.dispatch(
          editor.view.state.tr.setNodeMarkup(position, undefined, { ...current.attrs, src: box.value }),
        );
      });
      // Fitting needs the box to be on the page, and again whenever the page gets wider or narrower.
      if (typeof ResizeObserver === "function") new ResizeObserver(fit).observe(box);
      requestAnimationFrame(fit);
      dom.append(box);
      return {
        dom,
        update(updated) {
          if (updated.type !== current.type) return false;
          current = updated;
          if (box.value !== updated.attrs.src) box.value = updated.attrs.src;
          return true;
        },
        stopEvent: () => true,
        ignoreMutation: () => true,
      };
    };
  },
});

// A columns block with `count` columns, each holding one empty paragraph.
const columnsContent = (count) => ({ type: "columns", content: Array.from({ length: count }, () => ({ type: "column", content: [{ type: "paragraph" }] })) });

// The blocks offered by the slash menu. Each one replaces the "/query" text.
function slashItems() {
  const s = strings.slash;
  const clear = (editor, range) => editor.chain().focus().deleteRange(range);
  return [
    { title: s.text, words: "text paragraph", run: (e, r) => clear(e, r).setParagraph().run() },
    { title: s.heading1, words: "heading h1 title", run: (e, r) => clear(e, r).setHeading({ level: 1 }).run() },
    { title: s.heading2, words: "heading h2", run: (e, r) => clear(e, r).setHeading({ level: 2 }).run() },
    { title: s.heading3, words: "heading h3", run: (e, r) => clear(e, r).setHeading({ level: 3 }).run() },
    { title: s.heading4, words: "heading h4", run: (e, r) => clear(e, r).setHeading({ level: 4 }).run() },
    { title: s.bulletList, words: "bullet list unordered", run: (e, r) => clear(e, r).toggleBulletList().run() },
    { title: s.orderedList, words: "numbered ordered list", run: (e, r) => clear(e, r).toggleOrderedList().run() },
    { title: s.taskList, words: "todo to-do task checkbox", run: (e, r) => clear(e, r).toggleTaskList().run() },
    { title: s.quote, words: "quote blockquote", run: (e, r) => clear(e, r).toggleBlockquote().run() },
    { title: s.codeBlock, words: "code block", run: (e, r) => clear(e, r).toggleCodeBlock().run() },
    { title: s.divider, words: "divider rule line hr", run: (e, r) => clear(e, r).setHorizontalRule().run() },
    {
      id: "callout",
      title: s.callout,
      words: "callout note info box admonition",
      run: (e, r) => clear(e, r).insertContent({ type: "callout", attrs: { kind: "note" }, content: [{ type: "paragraph" }] }).run(),
    },
    {
      id: "columns",
      title: s.columns2,
      words: "columns two 2 side by side layout",
      run: (e, r) => clear(e, r).insertContent(columnsContent(2)).run(),
    },
    {
      id: "columns",
      title: s.columns3,
      words: "columns three 3 side by side layout",
      run: (e, r) => clear(e, r).insertContent(columnsContent(3)).run(),
    },
    {
      id: "toggle",
      title: s.toggle,
      words: "toggle details collapse fold summary",
      run: (e, r) => clear(e, r).insertContent({ type: "toggle", attrs: { summary: "" }, content: [{ type: "paragraph" }] }).run(),
    },
    {
      id: "image",
      title: s.image,
      words: "image picture photo png jpg attachment",
      run: (e, r) => {
        clear(e, r).run();
        choosePicture().then((file) => file && insertPictures(e, [file]));
      },
    },
    {
      id: "pdf",
      title: s.pdf,
      words: "pdf document slides lecture pages import attachment",
      run: (e, r) => {
        clear(e, r).run();
        choosePdf().then((file) => file && insertPdf(e, file));
      },
    },
    {
      id: "canvas",
      title: s.canvas,
      words: "canvas drawing draw sketch region frame",
      run: (e, r) => {
        clear(e, r).run();
        canvasOptions.create().then((id) => id && e.chain().focus().insertContent([{ type: "canvasBlock", attrs: { id } }, { type: "paragraph" }]).run());
      },
    },
    { id: "table", title: s.table, words: "table grid rows columns", run: (e, r) => clear(e, r).insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run() },
  ];
}

// Blocks that cannot sit inside a callout or a toggle (see richnodes.js).
const TOP_LEVEL_ONLY = new Set(["callout", "columns", "toggle", "table", "image", "pdf"]);

function filterItems(query, editor) {
  const q = query.trim().toLowerCase();
  const inside = editor && (editor.isActive("callout") || editor.isActive("toggle") || editor.isActive("column"));
  return slashItems().filter((item) => (!inside || !TOP_LEVEL_ONLY.has(item.id)) && (!q || `${item.title} ${item.words}`.toLowerCase().includes(q)));
}

// The floating list. Plain DOM, positioned under the cursor, closed by Escape or by
// moving away from the "/" text.
function renderSlashMenu(emptyText = strings.slash.noResults) {
  let menu = null;
  let items = [];
  let selected = 0;
  let command = null;

  function draw() {
    if (!menu) return;
    menu.replaceChildren();
    if (items.length === 0) {
      const none = document.createElement("div");
      none.className = "slash-empty";
      none.textContent = emptyText;
      menu.append(none);
      return;
    }
    items.forEach((item, index) => {
      const row = document.createElement("button");
      row.type = "button";
      row.className = "slash-item" + (index === selected ? " selected" : "");
      row.textContent = item.title;
      row.setAttribute("role", "option");
      // mousedown instead of click, so the editor does not lose focus first.
      row.addEventListener("mousedown", (event) => {
        event.preventDefault();
        command(item);
      });
      menu.append(row);
    });
  }

  function place(rect) {
    if (!menu || !rect) return;
    const margin = 8;
    const width = menu.offsetWidth || 220;
    const height = menu.offsetHeight || 0;
    let left = Math.min(rect.left, window.innerWidth - width - margin);
    left = Math.max(margin, left);
    let top = rect.bottom + 4;
    if (top + height > window.innerHeight - margin) top = Math.max(margin, rect.top - height - 4);
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;
  }

  return {
    onStart(props) {
      menu = document.createElement("div");
      menu.className = "slash-menu";
      menu.setAttribute("role", "listbox");
      document.body.append(menu);
      items = props.items;
      selected = 0;
      command = props.command;
      draw();
      place(props.clientRect && props.clientRect());
    },
    onUpdate(props) {
      items = props.items;
      selected = Math.min(selected, Math.max(0, items.length - 1));
      command = props.command;
      draw();
      place(props.clientRect && props.clientRect());
    },
    onKeyDown({ event }) {
      if (!menu) return false;
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        if (items.length === 0) return true;
        const step = event.key === "ArrowDown" ? 1 : -1;
        selected = (selected + step + items.length) % items.length;
        draw();
        return true;
      }
      if (event.key === "Enter" || event.key === "Tab") {
        if (items[selected]) command(items[selected]);
        return true;
      }
      return false;
    },
    onExit() {
      if (menu) menu.remove();
      menu = null;
    },
  };
}

const SlashMenu = Extension.create({
  name: "slashMenu",
  addProseMirrorPlugins() {
    return [
      Suggestion({
        editor: this.editor,
        char: "/",
        startOfLine: false,
        allowSpaces: false,
        items: ({ query, editor }) => filterItems(query, editor),
        command: ({ editor, range, props }) => props.run(editor, range),
        render: renderSlashMenu,
      }),
    ];
  },
});

// `options.loadImage(path)` gives the picture for an image block as a data: address.
export function createEditor(element, onChange, options = {}) {
  canvasOptions = { create: options.createCanvasRegion || (async () => null) };
  pictureOptions = {
    onProblem: options.onProblem || (() => {}),
    noteKey: options.noteKey || (() => null),
    pdfDialog: options.pdfDialog || (() => null),
    jobCard: options.jobCard || (() => null),
    pageToken: options.pageToken || (() => null),
    addToPage: options.addToPage || (async () => {}),
    notify: options.notify || (() => {}),
  };
  const editor = new Editor({
    element,
    // The page has a strict content security policy that forbids injected styles, so the
    // editor's own stylesheet is not injected; style.css styles it instead.
    injectCSS: false,
    extensions: [
      StarterKit.configure({
        // Underline stays on: this version of the library writes it as <u>text</u>, which
        // Obsidian shows too (see inlinestyles.js).
        link: { openOnClick: false, autolink: false },
        heading: { levels: [1, 2, 3, 4, 5, 6] },
      }),
      TaskList,
      TaskItem.configure({ nested: true }),
      Markdown,
      Placeholder.configure({ placeholder: strings.editor.placeholder }),
      Highlight,
      Subscript,
      Superscript,
      Colour,
      Wikilink.configure({
        follow: options.followLink || (() => {}),
        renderPicker: () => renderSlashMenu(strings.wikilinks.noPages),
      }),
      Tags.configure({ open: options.openTag || (() => {}) }),
      SourceKeeper,
      RawBlock,
      Callout,
      Columns,
      Column,
      Toggle,
      ToggleFold,
      FindMarks,
      ImageBlock.configure({ load: options.loadImage || (() => Promise.reject(new Error("no loader"))), words: options.loadWords || (() => Promise.reject(new Error("no words"))) }),
      PdfBlock.configure({ load: options.loadImage || (() => Promise.reject(new Error("no loader"))) }),
      CanvasBlock.configure({ drawing: options.canvasDrawing || (() => null) }),
      ...tableExtensions,
      SlashMenu,
      LinkShortcut,
      BlockMoveShortcuts,
      PictureInput,
    ],
    content: { type: "doc", content: [{ type: "paragraph" }] },
    editorProps: {
      attributes: { class: "note-body", spellcheck: "true", "aria-label": strings.editor.placeholder },
    },
    onUpdate: () => onChange(),
  });
  toolbars = attachToolbars(editor);
  gutter = attachGutter(editor, {
    scroller: element,
    noteTitle: options.noteTitle || (() => ""),
    notify: options.notify || (() => {}),
  });
  return editor;
}
