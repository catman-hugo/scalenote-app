// The block handle: a small grip beside the block you are in (or point at). Tap or click it
// for a menu (move, turn into, duplicate, delete, copy link); press and drag it to move the
// block. It uses pointer events, so the same code serves mouse, finger and pen.

import { canTurnInto, deleteUnit, duplicateUnit, ensureBlockId, moveUnit, moveUnitBy, TURN_NAMES, turnInto, unitIndexAt, unitsOf } from "./blockops.js";
import { icon } from "./icons.js";
import { strings } from "./strings.js";

const DRAG_START_PX = 6;
const EDGE_PX = 48;
const HANDLE_SIZE = 32;

// Where the middle of a block's first line is, so the handle lines up with the first line of
// text for headings, lists, code and callouts alike. A divider or an empty block has no text,
// so the middle of the block itself is used. A tall picture or table is capped at one line
// of height, so the handle stays near the top instead of floating in the middle.
function firstLineMiddle(dom) {
  const rect = dom.getBoundingClientRect();
  const style = getComputedStyle(dom);
  const line = Number.parseFloat(style.lineHeight) || Number.parseFloat(style.fontSize) * 1.5 || 24;
  if (dom.querySelector("hr") || dom.tagName === "HR") return rect.top + rect.height / 2;
  const walker = document.createTreeWalker(dom, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (node.nodeType === Node.TEXT_NODE) {
        // Option labels inside a select are not lines of the note.
        if (node.parentElement && node.parentElement.closest("select")) return NodeFilter.FILTER_REJECT;
        return node.nodeValue.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
      }
      return /^(INPUT|TEXTAREA|SELECT|IMG)$/.test(node.tagName) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
    },
  });
  const first = walker.nextNode();
  let box = null;
  if (first && first.nodeType === Node.TEXT_NODE) {
    const range = document.createRange();
    range.selectNodeContents(first);
    box = range.getClientRects()[0] || null;
  } else if (first) {
    box = first.getBoundingClientRect();
  }
  if (box && box.height > 0) {
    // One line at most, measured from the top of what was found.
    return box.top + Math.min(box.height, line * 1.5) / 2;
  }
  return rect.top + Math.min(rect.height, line) / 2;
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export function attachGutter(editor, { scroller, noteTitle, notify }) {
  const g = strings.gutter;
  const handle = el("button", "gutter-handle");
  handle.append(icon("grip"));
  handle.type = "button";
  handle.hidden = true;
  handle.setAttribute("aria-label", g.handleLabel);
  handle.setAttribute("aria-haspopup", "menu");
  handle.setAttribute("aria-expanded", "false");
  const menu = el("div", "gutter-menu");
  menu.setAttribute("role", "menu");
  menu.hidden = true;
  const dropLine = el("div", "drop-line");
  dropLine.hidden = true;
  document.body.append(handle, menu, dropLine);

  let active = -1; // index of the unit the handle belongs to
  let hovering = false;
  let drag = null;

  const blockDom = (unit) => editor.view.nodeDOM(unit.from);

  // ----- which block, and where the handle goes -----
  function setActive(index) {
    if (index === active) return;
    active = index;
    if (!menu.hidden) closeMenu();
    refresh();
  }

  function unitAtY(clientY) {
    const units = unitsOf(editor.state.doc);
    let best = -1;
    units.forEach((unit, index) => {
      const dom = blockDom(unit);
      if (!(dom instanceof HTMLElement)) return;
      const rect = dom.getBoundingClientRect();
      if (clientY >= rect.top - 6 && clientY <= rect.bottom + 6) best = index;
    });
    return best;
  }

  function refresh() {
    const units = unitsOf(editor.state.doc);
    const unit = units[active];
    const dom = unit && blockDom(unit);
    const visible = unit && dom instanceof HTMLElement && (editor.isFocused || hovering || !menu.hidden || drag || handle.matches(":focus"));
    if (!visible) {
      handle.hidden = true;
      return;
    }
    const rect = dom.getBoundingClientRect();
    const area = scroller.getBoundingClientRect();
    if (rect.bottom < area.top || rect.top > area.bottom) {
      handle.hidden = true;
      return;
    }
    handle.hidden = false;
    handle.style.left = `${Math.max(2, rect.left - HANDLE_SIZE - 4)}px`;
    handle.style.top = `${Math.max(area.top, firstLineMiddle(dom) - HANDLE_SIZE / 2)}px`;
  }

  function followSelection() {
    const { selection } = editor.state;
    setActive(unitIndexAt(editor.state.doc, selection.from));
  }

  editor.on("selectionUpdate", followSelection);
  editor.on("focus", () => {
    followSelection();
    refresh();
  });
  editor.on("update", refresh);
  editor.on("blur", () => {
    setTimeout(() => {
      if (!handle.matches(":focus") && !menu.contains(document.activeElement) && menu.hidden && !drag) refresh();
    }, 0);
  });
  // Raw blocks, picture descriptions and callout titles are inputs inside the note: focusing
  // one is "being in that block" even though the editor's own selection does not move.
  editor.view.dom.addEventListener("focusin", (event) => {
    // Focus on the editor text itself is handled by the selection; only inner inputs come here.
    if (!(event.target instanceof HTMLElement) || event.target === editor.view.dom || event.target.isContentEditable) return;
    const index = unitAtY(event.target.getBoundingClientRect().top + 1);
    if (index !== -1) setActive(index);
  });
  scroller.addEventListener("pointermove", (event) => {
    if (event.pointerType !== "mouse" || drag) return;
    hovering = true;
    const index = unitAtY(event.clientY);
    if (index !== -1) setActive(index);
    else refresh();
  });
  scroller.addEventListener("pointerleave", (event) => {
    if (event.pointerType !== "mouse") return;
    // Moving onto the handle itself is not leaving.
    setTimeout(() => {
      hovering = handle.matches(":hover");
      refresh();
    }, 0);
  });
  scroller.addEventListener("scroll", refresh, { passive: true });
  window.addEventListener("resize", refresh);

  // ----- the menu -----
  function openMenu() {
    const units = unitsOf(editor.state.doc);
    const unit = units[active];
    if (!unit) return;
    menu.replaceChildren();
    const add = (label, run, enabled = true) => {
      const item = el("button", "menu-item", label);
      item.type = "button";
      item.setAttribute("role", "menuitem");
      item.disabled = !enabled;
      item.addEventListener("click", () => {
        closeMenu();
        run();
        editor.view.focus();
      });
      menu.append(item);
    };
    add(g.moveUp, () => moveUnitBy(editor, active, -1), active > 0);
    add(g.moveDown, () => moveUnitBy(editor, active, 1), active < units.length - 1);
    add(g.duplicate, () => duplicateUnit(editor, active));
    add(g.delete, () => deleteUnit(editor, active));
    add(g.copyLink, () => copyLink(active));
    if (canTurnInto(unit.node)) {
      menu.append(el("div", "menu-label", g.turnInto));
      for (const name of TURN_NAMES) add(strings.slash[name], () => turnInto(editor, active, name));
    }
    menu.hidden = false;
    handle.setAttribute("aria-expanded", "true");
    const rect = handle.getBoundingClientRect();
    const width = menu.offsetWidth;
    const height = menu.offsetHeight;
    menu.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - width - 8))}px`;
    menu.style.top = `${Math.max(8, Math.min(rect.bottom + 4, window.innerHeight - height - 8))}px`;
    const first = menu.querySelector("button:not(:disabled)");
    if (first) first.focus();
  }

  function closeMenu() {
    menu.hidden = true;
    handle.setAttribute("aria-expanded", "false");
  }

  async function copyLink(index) {
    const id = ensureBlockId(editor, index);
    if (!id) return;
    const title = noteTitle().replace(/[\[\]|#^]/g, "").trim();
    const link = `[[${title}#^${id}]]`;
    try {
      await navigator.clipboard.writeText(link);
      notify(g.linkCopied);
    } catch {
      notify(g.linkNotCopied);
    }
  }

  document.addEventListener("pointerdown", (event) => {
    if (!menu.hidden && !menu.contains(event.target) && event.target !== handle) closeMenu();
  });
  menu.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      closeMenu();
      handle.focus();
    }
  });

  // ----- dragging -----
  function slotAt(clientY) {
    const units = unitsOf(editor.state.doc);
    for (let i = 0; i < units.length; i++) {
      const dom = blockDom(units[i]);
      if (!(dom instanceof HTMLElement)) continue;
      const rect = dom.getBoundingClientRect();
      if (clientY < rect.top + rect.height / 2) return { slot: i, y: rect.top - 2 };
    }
    const lastDom = blockDom(units[units.length - 1]);
    const rect = lastDom instanceof HTMLElement ? lastDom.getBoundingClientRect() : { bottom: 0 };
    return { slot: units.length, y: rect.bottom + 2 };
  }

  function showDropLine(target) {
    const area = scroller.getBoundingClientRect();
    const note = editor.view.dom.getBoundingClientRect();
    dropLine.hidden = false;
    dropLine.style.left = `${note.left}px`;
    dropLine.style.width = `${note.width}px`;
    dropLine.style.top = `${Math.max(area.top, Math.min(target.y, area.bottom))}px`;
  }

  function endDrag(apply) {
    if (!drag) return;
    const { pointerId, last } = drag;
    const wasDragging = drag.dragging;
    const from = drag.from;
    cancelAnimationFrame(drag.frame);
    drag = null;
    document.body.classList.remove("block-dragging");
    dropLine.hidden = true;
    try {
      handle.releasePointerCapture(pointerId);
    } catch {
      // The capture may already be gone (for example after a cancel); nothing to undo.
    }
    if (!apply) return;
    if (wasDragging) moveUnit(editor, from, slotAt(last).slot);
    else if (menu.hidden) openMenu();
    else closeMenu();
    refresh();
  }

  // Scrolls the note while a block is held near the top or bottom edge.
  function autoScroll() {
    if (!drag || !drag.dragging) return;
    const area = scroller.getBoundingClientRect();
    if (drag.last < area.top + EDGE_PX) scroller.scrollTop -= 14;
    else if (drag.last > area.bottom - EDGE_PX) scroller.scrollTop += 14;
    showDropLine(slotAt(drag.last));
    drag.frame = requestAnimationFrame(autoScroll);
  }

  // mousedown/touchstart default actions would move focus or scroll the page; pointer events
  // do the real work.
  handle.addEventListener("mousedown", (event) => event.preventDefault());
  handle.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 && event.pointerType === "mouse") return;
    event.preventDefault();
    if (active < 0) return;
    handle.setPointerCapture(event.pointerId);
    drag = { pointerId: event.pointerId, startY: event.clientY, startX: event.clientX, last: event.clientY, dragging: false, from: active, frame: 0 };
  });
  handle.addEventListener("pointermove", (event) => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    drag.last = event.clientY;
    if (!drag.dragging && Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) > DRAG_START_PX) {
      drag.dragging = true;
      closeMenu();
      document.body.classList.add("block-dragging");
      drag.frame = requestAnimationFrame(autoScroll);
    }
    if (drag.dragging) showDropLine(slotAt(event.clientY));
  });
  handle.addEventListener("pointerup", (event) => {
    if (drag && event.pointerId === drag.pointerId) endDrag(true);
  });
  handle.addEventListener("pointercancel", () => endDrag(false));
  window.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && drag) endDrag(false);
  });
  // The keyboard: Enter or Space on the focused handle opens the menu.
  handle.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      if (menu.hidden) openMenu();
      else closeMenu();
    }
  });

  return {
    // Alt+Up and Alt+Down move the block you are in.
    moveCurrent(step) {
      const index = unitIndexAt(editor.state.doc, editor.state.selection.from);
      return moveUnitBy(editor, index, step);
    },
  };
}
