// The two small floating toolbars: formatting for selected text, and table editing.
//
// They are plain DOM placed with `position: fixed`. Buttons use pointerdown + preventDefault
// so pressing one never moves focus out of the editor and never loses the selection.

import { canTurnInto, TURN_NAMES, turnInto, turnNameOf, unitRangeOf, unitsOf } from "./blockops.js";
import { icon } from "./icons.js";
import { normalizeUrl } from "./links.js";
import { PALETTE, paletteEntry } from "./inlinestyles.js";
import { strings } from "./strings.js";

const MARGIN = 8;
const TOUCH_CLEARANCE = 36;

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
  let touchSelecting = false; // the last press in the note was a finger

  // ----- formatting bar -----
  const bar = document.createElement("div");
  bar.className = "float-bar";
  bar.setAttribute("role", "toolbar");
  bar.setAttribute("aria-label", f.barLabel);
  bar.hidden = true;

  const marks = [
    { label: f.bold, text: f.boldMark, name: "bold", cls: "mark-bold", run: () => editor.chain().focus().toggleBold().run() },
    { label: f.italic, text: f.italicMark, name: "italic", cls: "mark-italic", run: () => editor.chain().focus().toggleItalic().run() },
    { label: f.underline, text: f.underlineMark, name: "underline", cls: "mark-underline", run: () => editor.chain().focus().toggleUnderline().run() },
    { label: f.strike, text: f.strikeMark, name: "strike", cls: "mark-strike", run: () => editor.chain().focus().toggleStrike().run() },
    { label: f.highlight, text: f.highlightMark, name: "highlight", cls: "mark-highlight", run: () => editor.chain().focus().toggleHighlight().run() },
    { label: f.subscript, text: f.subscriptMark, name: "subscript", cls: "", run: () => editor.chain().focus().toggleSubscript().run() },
    { label: f.superscript, text: f.superscriptMark, name: "superscript", cls: "", run: () => editor.chain().focus().toggleSuperscript().run() },
    { label: f.code, text: f.codeMark, name: "code", cls: "mark-code", run: () => editor.chain().focus().toggleCode().run() },
    { label: f.link, text: f.linkMark, name: "link", cls: "", run: () => openLink() },
  ];
  // The block type row: shows what kind of block the selection is in and opens the same
  // "Turn into" list as the block menu. It only shows for a selection inside one block.
  const typeButton = button(f.blockType, "", "type-button");
  typeButton.setAttribute("aria-haspopup", "menu");
  typeButton.setAttribute("aria-expanded", "false");
  const typeLabel = document.createElement("span");
  typeLabel.className = "type-label";
  typeButton.textContent = "";
  typeButton.append(typeLabel, icon("chevronDown"));
  const typeMenu = document.createElement("div");
  typeMenu.className = "gutter-menu type-menu";
  typeMenu.setAttribute("role", "menu");
  typeMenu.setAttribute("aria-label", f.blockType);
  typeMenu.hidden = true;
  let typeUnit = -1;

  function closeTypeMenu() {
    typeMenu.hidden = true;
    typeButton.setAttribute("aria-expanded", "false");
  }
  function openTypeMenu() {
    const unit = unitsOf(editor.state.doc)[typeUnit];
    if (!unit) return;
    const now = turnNameOf(unit.node);
    typeMenu.replaceChildren();
    for (const name of TURN_NAMES) {
      const item = document.createElement("button");
      item.type = "button";
      item.className = "menu-item folder-menu-item";
      item.setAttribute("role", "menuitem");
      const text = document.createElement("span");
      text.textContent = strings.slash[name];
      item.append(text);
      if (name === now) {
        item.setAttribute("aria-current", "true");
        item.append(icon("check"));
      }
      keepFocus(item, () => {
        closeTypeMenu();
        turnInto(editor, typeUnit, name);
        refresh();
      });
      typeMenu.append(item);
    }
    typeMenu.hidden = false;
    typeButton.setAttribute("aria-expanded", "true");
    place(typeMenu, typeButton.getBoundingClientRect(), "below");
  }
  keepFocus(typeButton, () => (typeMenu.hidden ? openTypeMenu() : closeTypeMenu()));
  document.addEventListener("pointerdown", (event) => {
    if (!typeMenu.hidden && !typeMenu.contains(event.target) && !typeButton.contains(event.target)) closeTypeMenu();
  });

  // The text colour button: shows the colour in use under its letter and opens the palette.
  const colourButton = button(f.colour, "", "colour-button");
  colourButton.setAttribute("aria-haspopup", "menu");
  colourButton.setAttribute("aria-expanded", "false");
  const colourLetter = document.createElement("span");
  colourLetter.className = "colour-letter";
  colourLetter.textContent = f.colourMark;
  colourButton.textContent = "";
  colourButton.append(colourLetter);
  const colourMenu = document.createElement("div");
  colourMenu.className = "gutter-menu colour-menu";
  colourMenu.setAttribute("role", "menu");
  colourMenu.setAttribute("aria-label", f.colour);
  colourMenu.hidden = true;
  const swatches = document.createElement("div");
  swatches.className = "swatches";
  const swatchButtons = PALETTE.map((entry) => {
    const node = document.createElement("button");
    node.type = "button";
    node.className = `swatch swatch-${entry.name}`;
    node.title = f.colours[entry.name];
    node.setAttribute("role", "menuitem");
    node.setAttribute("aria-label", f.colours[entry.name]);
    keepFocus(node, () => {
      closeColourMenu();
      editor.chain().focus().setTextColor(entry.hex).run();
      refresh();
    });
    swatches.append(node);
    return { entry, node };
  });
  const colourClear = document.createElement("button");
  colourClear.type = "button";
  colourClear.className = "menu-item";
  colourClear.setAttribute("role", "menuitem");
  colourClear.textContent = f.colourClear;
  keepFocus(colourClear, () => {
    closeColourMenu();
    editor.chain().focus().unsetTextColor().run();
    refresh();
  });
  colourMenu.append(swatches, colourClear);

  function closeColourMenu() {
    colourMenu.hidden = true;
    colourButton.setAttribute("aria-expanded", "false");
  }
  function openColourMenu() {
    const current = paletteEntry(editor.getAttributes("textColor").color);
    swatchButtons.forEach(({ entry, node }) => {
      if (current && current.name === entry.name) node.setAttribute("aria-current", "true");
      else node.removeAttribute("aria-current");
    });
    colourMenu.hidden = false;
    colourButton.setAttribute("aria-expanded", "true");
    place(colourMenu, colourButton.getBoundingClientRect(), "below");
  }
  keepFocus(colourButton, () => (colourMenu.hidden ? openColourMenu() : closeColourMenu()));
  document.addEventListener("pointerdown", (event) => {
    if (!colourMenu.hidden && !colourMenu.contains(event.target) && !colourButton.contains(event.target)) closeColourMenu();
  });

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
  // Order in the bar: block type, then the marks, with the colour button after highlight.
  const nodes = buttons.map((b) => b.node);
  const afterHighlight = buttons.findIndex((b) => b.name === "highlight") + 1;
  nodes.splice(afterHighlight, 0, colourButton);
  bar.append(typeButton, ...nodes, linkRow);
  document.body.append(bar, typeMenu, colourMenu);

  function openLink() {
    linkMode = true;
    linkInput.value = editor.getAttributes("link").href || "";
    linkError.textContent = "";
    remove.hidden = !editor.isActive("link");
    buttons.forEach((b) => (b.node.hidden = true));
    typeButton.hidden = true;
    colourButton.hidden = true;
    closeTypeMenu();
    closeColourMenu();
    linkRow.hidden = false;
    linkInput.focus();
    linkInput.select();
  }
  function closeLink() {
    linkMode = false;
    linkRow.hidden = true;
    buttons.forEach((b) => (b.node.hidden = false));
    colourButton.hidden = false;
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
    if (!show) {
      closeTypeMenu();
      closeColourMenu();
    }
    if (show) {
      buttons.forEach((b) => b.node.classList.toggle("active", editor.isActive(b.name)));
      const colourNow = paletteEntry(editor.getAttributes("textColor").color);
      colourLetter.className = `colour-letter${colourNow ? ` tc-${colourNow.name}` : ""}`;
      colourButton.classList.toggle("active", Boolean(colourNow));
      // The type row shows for a selection inside one text block.
      const { first, last } = unitRangeOf(editor.state.doc, selection);
      const unit = unitsOf(editor.state.doc)[first];
      const name = unit && first === last && canTurnInto(unit.node) ? turnNameOf(unit.node) : null;
      typeUnit = name ? first : -1;
      typeButton.hidden = !name || linkMode;
      if (name) typeLabel.textContent = strings.slash[name];
      if (typeMenu.hidden === false && !name) closeTypeMenu();
      const end = editor.view.coordsAtPos(selection.to);
      const start = editor.view.coordsAtPos(selection.from);
      // With a finger the system's own selection handles sit just under the text, so the bar
      // goes a little lower to leave them free.
      const clearance = touchSelecting ? TOUCH_CLEARANCE : 0;
      place(bar, { left: Math.min(start.left, end.left), top: start.top, bottom: end.bottom + clearance }, "below");
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
        colourButton.hidden = false;
        bar.hidden = true;
        closeTypeMenu();
        closeColourMenu();
        tableBar.hidden = true;
      }
    }, 0);
  });
  editor.view.dom.addEventListener("pointerdown", (event) => {
    touchSelecting = event.pointerType === "touch";
    // A finger's selection is made with the system's own handles and menu, and the page may never
    // hear a pointerup for it (the system takes the touch over and sends pointercancel, or
    // nothing). Waiting for the pointer to lift would keep the bar hidden for good, so a finger
    // never counts as "pressed". A mouse or pen drag still hides the bar until it is released.
    if (touchSelecting) return;
    pointerDown = true;
    bar.hidden = true;
  });
  const pointerEnded = () => {
    if (!pointerDown) return;
    pointerDown = false;
    refresh();
  };
  document.addEventListener("pointerup", pointerEnded);
  document.addEventListener("pointercancel", pointerEnded);
  window.addEventListener("resize", refresh);
  editor.view.dom.parentElement && editor.view.dom.parentElement.addEventListener("scroll", refresh, { passive: true });

  return { openLink, refresh };
}
