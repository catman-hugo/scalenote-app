// The two small floating toolbars: formatting for selected text, and table editing.
//
// They are plain DOM placed with `position: fixed`. Buttons use pointerdown + preventDefault
// so pressing one never moves focus out of the editor and never loses the selection.

import { normalizeUrl } from "./links.js";
import { strings } from "./strings.js";

const MARGIN = 8;

function button(label, text, className) {
  const node = document.createElement("button");
  node.type = "button";
  node.className = `bar-button ${className || ""}`.trim();
  node.textContent = text;
  node.title = label;
  node.setAttribute("aria-label", label);
  return node;
}

function keepFocus(node, action) {
  // pointerdown works for mouse, finger and pen alike; preventDefault keeps the selection.
  node.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    action();
  });
  node.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      action();
    }
  });
}

function place(bar, rect, where) {
  const width = bar.offsetWidth;
  const height = bar.offsetHeight;
  let left = Math.max(MARGIN, Math.min(rect.left, window.innerWidth - width - MARGIN));
  let top = where === "above" ? rect.top - height - 4 : rect.bottom + 6;
  if (top < MARGIN) top = rect.bottom + 6;
  if (top + height > window.innerHeight - MARGIN) top = Math.max(MARGIN, window.innerHeight - height - MARGIN);
  bar.style.left = `${left}px`;
  bar.style.top = `${top}px`;
}

function inTable(editor) {
  const { $from } = editor.state.selection;
  for (let depth = $from.depth; depth > 0; depth--) {
    if ($from.node(depth).type.name === "table") return $from.before(depth);
  }
  return null;
}

export function attachToolbars(editor) {
  const f = strings.format;
  let pointerDown = false;
  let linkMode = false;

  // ----- formatting bar -----
  const bar = document.createElement("div");
  bar.className = "float-bar";
  bar.setAttribute("role", "toolbar");
  bar.setAttribute("aria-label", f.barLabel);
  bar.hidden = true;

  const marks = [
    { label: f.bold, text: f.boldMark, name: "bold", cls: "mark-bold", run: () => editor.chain().focus().toggleBold().run() },
    { label: f.italic, text: f.italicMark, name: "italic", cls: "mark-italic", run: () => editor.chain().focus().toggleItalic().run() },
    { label: f.strike, text: f.strikeMark, name: "strike", cls: "mark-strike", run: () => editor.chain().focus().toggleStrike().run() },
    { label: f.code, text: f.codeMark, name: "code", cls: "mark-code", run: () => editor.chain().focus().toggleCode().run() },
    { label: f.link, text: f.linkMark, name: "link", cls: "", run: () => openLink() },
  ];
  const buttons = marks.map((mark) => {
    const node = button(mark.label, mark.text, mark.cls);
    keepFocus(node, mark.run);
    return { ...mark, node };
  });

  const linkRow = document.createElement("div");
  linkRow.className = "link-row";
  const linkInput = document.createElement("input");
  linkInput.type = "text";
  linkInput.className = "link-input";
  linkInput.placeholder = f.linkPlaceholder;
  linkInput.setAttribute("aria-label", f.linkLabel);
  linkInput.spellcheck = false;
  const apply = button(f.linkApply, f.linkApply, "");
  const remove = button(f.linkRemove, f.linkRemove, "");
  const cancel = button(f.linkCancel, f.linkCancel, "");
  const linkError = document.createElement("span");
  linkError.className = "link-error";
  linkRow.append(linkInput, apply, remove, cancel, linkError);
  linkRow.hidden = true;
  bar.append(...buttons.map((b) => b.node), linkRow);
  document.body.append(bar);

  function openLink() {
    linkMode = true;
    linkInput.value = editor.getAttributes("link").href || "";
    linkError.textContent = "";
    remove.hidden = !editor.isActive("link");
    buttons.forEach((b) => (b.node.hidden = true));
    linkRow.hidden = false;
    linkInput.focus();
    linkInput.select();
  }
  function closeLink() {
    linkMode = false;
    linkRow.hidden = true;
    buttons.forEach((b) => (b.node.hidden = false));
    editor.commands.focus();
    refresh();
  }
  function applyLink() {
    const text = linkInput.value.trim();
    if (text === "") {
      editor.chain().focus().extendMarkRange("link").unsetLink().run();
      closeLink();
      return;
    }
    const href = normalizeUrl(text);
    if (!href) {
      linkError.textContent = f.linkRefused;
      return;
    }
    editor.chain().focus().extendMarkRange("link").setLink({ href }).run();
    closeLink();
  }
  apply.addEventListener("click", applyLink);
  remove.addEventListener("click", () => {
    editor.chain().focus().extendMarkRange("link").unsetLink().run();
    closeLink();
  });
  cancel.addEventListener("click", closeLink);
  linkInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      applyLink();
    } else if (event.key === "Escape") {
      event.preventDefault();
      closeLink();
    }
  });

  // ----- table bar -----
  const tableBar = document.createElement("div");
  tableBar.className = "float-bar";
  tableBar.setAttribute("role", "toolbar");
  tableBar.setAttribute("aria-label", strings.table.barLabel);
  tableBar.hidden = true;
  const t = strings.table;
  const tableActions = [
    [t.addRow, () => editor.chain().focus().addRowAfter().run()],
    [t.addColumn, () => editor.chain().focus().addColumnAfter().run()],
    [t.deleteRow, () => editor.chain().focus().deleteRow().run()],
    [t.deleteColumn, () => editor.chain().focus().deleteColumn().run()],
    [t.deleteTable, () => editor.chain().focus().deleteTable().run()],
  ];
  for (const [label, run] of tableActions) {
    const node = button(label, label, "");
    keepFocus(node, run);
    tableBar.append(node);
  }
  document.body.append(tableBar);

  // ----- showing and hiding -----
  function refresh() {
    const { selection } = editor.state;
    const hasText = !selection.empty && selection.$from.parent.isTextblock && !editor.isActive("codeBlock");
    const show = hasText && (editor.isFocused || linkMode) && !pointerDown;
    bar.hidden = !show;
    if (show) {
      buttons.forEach((b) => b.node.classList.toggle("active", editor.isActive(b.name)));
      const end = editor.view.coordsAtPos(selection.to);
      const start = editor.view.coordsAtPos(selection.from);
      place(bar, { left: Math.min(start.left, end.left), top: start.top, bottom: end.bottom }, "below");
    } else if (linkMode && !hasText) {
      closeLink();
    }
    const tablePos = inTable(editor);
    const showTable = tablePos !== null && editor.isFocused;
    tableBar.hidden = !showTable;
    if (showTable) {
      const dom = editor.view.nodeDOM(tablePos);
      if (dom instanceof HTMLElement) place(tableBar, dom.getBoundingClientRect(), "above");
    }
  }

  editor.on("selectionUpdate", refresh);
  editor.on("update", refresh);
  editor.on("focus", refresh);
  editor.on("blur", () => {
    // Moving into the link box is not leaving the editor.
    setTimeout(() => {
      if (!bar.contains(document.activeElement)) {
        linkMode = false;
        linkRow.hidden = true;
        buttons.forEach((b) => (b.node.hidden = false));
        bar.hidden = true;
        tableBar.hidden = true;
      }
    }, 0);
  });
  editor.view.dom.addEventListener("pointerdown", () => {
    pointerDown = true;
    bar.hidden = true;
  });
  document.addEventListener("pointerup", () => {
    if (!pointerDown) return;
    pointerDown = false;
    refresh();
  });
  window.addEventListener("resize", refresh);
  editor.view.dom.parentElement && editor.view.dom.parentElement.addEventListener("scroll", refresh, { passive: true });

  return { openLink, refresh };
}
