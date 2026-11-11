// The block handle: a small grip beside the block you are in (or point at). Tap or click it
// for a menu (move, turn into, duplicate, delete, copy link); press and drag it to move the
// block. It uses pointer events, so the same code serves mouse, finger and pen.

import { addParagraphAfter, canTurnInto, deleteUnits, duplicateUnits, ensureBlockId, moveUnits, moveUnitsBy, TURN_NAMES, turnInto, unitIndexAt, unitRangeOf, unitsOf } from "./blockops.js";
import { applyDrop, fitsInColumn, nodesBetween, unwrapColumns } from "./columnops.js";
import { icon } from "./icons.js";
import { strings } from "./strings.js";

const DRAG_START_PX = 6;
const EDGE_PX = 48;
const HANDLE_SIZE = 32;
// How close to the left or right edge of a block a drop makes columns, in pixels.
const SIDE_PX = 56;

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
  handle.title = g.handleHint;
  // The plus button adds an empty block below. It only shows when the margin is wide enough;
  // the menu always has the same action.
  const plus = el("button", "gutter-plus");
  plus.append(icon("plus"));
  plus.type = "button";
  plus.hidden = true;
  plus.setAttribute("aria-label", g.plusLabel);
  plus.title = g.plusLabel;
  const menu = el("div", "gutter-menu");
  menu.setAttribute("role", "menu");
  menu.hidden = true;
  const dropLine = el("div", "drop-line");
  dropLine.hidden = true;
  document.body.append(plus, handle, menu, dropLine);

  let active = -1; // index of the unit the handle belongs to
  let hovering = false;
  let drag = null;
  // A block inside a column that the handle belongs to: { from, to, node }. Null when the handle is on a top-level block.
  let inner = null;

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

  // The children of the columns block at `unit`: [{ pos, node, dom, children: [{ from, to, node, dom }] }].
  function columnsOf(unit) {
    const out = [];
    unit.node.forEach((column, offset) => {
      const pos = unit.from + 1 + offset;
      const dom = editor.view.nodeDOM(pos);
      const children = [];
      column.forEach((node, childOffset) => {
        const from = pos + 1 + childOffset;
        children.push({ from, to: from + node.nodeSize, node, dom: editor.view.nodeDOM(from) });
      });
      out.push({ pos, node: column, dom, children });
    });
    return out;
  }

  // The block inside a column under the pointer, or null.
  function innerAt(x, y) {
    for (const unit of unitsOf(editor.state.doc)) {
      if (unit.node.type.name !== "columns") continue;
      for (const column of columnsOf(unit)) {
        if (!(column.dom instanceof HTMLElement)) continue;
        const box = column.dom.getBoundingClientRect();
        if (x < box.left - 4 || x > box.right + 4 || y < box.top - 6 || y > box.bottom + 6) continue;
        for (const child of column.children) {
          if (!(child.dom instanceof HTMLElement)) continue;
          const rect = child.dom.getBoundingClientRect();
          if (y >= rect.top - 6 && y <= rect.bottom + 6) return child;
        }
      }
    }
    return null;
  }

  function setInner(next) {
    if ((inner && next && inner.from === next.from) || (!inner && !next)) return;
    inner = next;
    if (!menu.hidden) closeMenu();
    refresh();
  }

  function refresh() {
    if (inner) return refreshInner();
    const units = unitsOf(editor.state.doc);
    const unit = units[active];
    const dom = unit && blockDom(unit);
    const visible = unit && dom instanceof HTMLElement && (editor.isFocused || hovering || !menu.hidden || drag || handle.matches(":focus"));
    if (!visible) {
      handle.hidden = true;
      plus.hidden = true;
      return;
    }
    const rect = dom.getBoundingClientRect();
    const area = scroller.getBoundingClientRect();
    if (rect.bottom < area.top || rect.top > area.bottom) {
      handle.hidden = true;
      plus.hidden = true;
      return;
    }
    handle.hidden = false;
    const left = Math.max(2, rect.left - HANDLE_SIZE - 4);
    const top = Math.max(area.top, firstLineMiddle(dom) - HANDLE_SIZE / 2);
    handle.style.left = `${left}px`;
    handle.style.top = `${top}px`;
    // The plus sits left of the grip, and only when it fits inside the note's own area.
    plus.hidden = left - HANDLE_SIZE < area.left;
    plus.style.left = `${left - HANDLE_SIZE}px`;
    plus.style.top = `${top}px`;
  }

  // The handle of a block inside a column sits just left of that block, in the gap between columns.
  function refreshInner() {
    const dom = editor.view.nodeDOM(inner.from);
    const visible = dom instanceof HTMLElement && (hovering || !menu.hidden || drag || handle.matches(":focus"));
    plus.hidden = true;
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
    handle.style.left = `${Math.max(2, rect.left - HANDLE_SIZE - 2)}px`;
    handle.style.top = `${Math.max(area.top, firstLineMiddle(dom) - HANDLE_SIZE / 2)}px`;
  }

  function followSelection() {
    inner = null;
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
    const child = innerAt(event.clientX, event.clientY);
    if (child) {
      setInner(child);
      return;
    }
    setInner(null);
    const index = unitAtY(event.clientY);
    if (index !== -1) setActive(index);
    else refresh();
  });
  scroller.addEventListener("pointerleave", (event) => {
    if (event.pointerType !== "mouse") return;
    // Moving onto the handle itself is not leaving.
    setTimeout(() => {
      hovering = handle.matches(":hover") || plus.matches(":hover");
      refresh();
    }, 0);
  });
  scroller.addEventListener("scroll", refresh, { passive: true });
  window.addEventListener("resize", refresh);

  // The blocks an action applies to: the run of blocks the selection covers when the handle
  // belongs to one of them, else just the block the handle is on.
  function targetRange() {
    const range = unitRangeOf(editor.state.doc, editor.state.selection);
    if (!editor.state.selection.empty && range.last > range.first && active >= range.first && active <= range.last) return range;
    return { first: active, last: active };
  }

  plus.addEventListener("mousedown", (event) => event.preventDefault());
  plus.addEventListener("click", () => {
    if (active < 0) return;
    addParagraphAfter(editor, targetRange().last);
    editor.view.focus();
  });

  // ----- the menu -----
  function addItem(label, run, enabled = true) {
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
  }

  function placeMenu() {
    menu.hidden = false;
    handle.setAttribute("aria-expanded", "true");
    const rect = handle.getBoundingClientRect();
    const width = menu.offsetWidth;
    const height = menu.offsetHeight;
    menu.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - width - 8))}px`;
    menu.style.top = `${Math.max(8, Math.min(rect.bottom + 4, window.innerHeight - height - 8))}px`;
    const firstButton = menu.querySelector("button:not(:disabled)");
    if (firstButton) firstButton.focus();
  }

  // The menu of a block inside a column: the few things that make sense there.
  function openInnerMenu() {
    const block = inner;
    menu.replaceChildren();
    const doc = editor.state.doc;
    const columnsUnit = unitsOf(doc).find((u) => u.from <= block.from && block.to <= u.to);
    addItem(g.moveOut, () => columnsUnit && applyDrop(editor, block, { type: "at", pos: columnsUnit.to }));
    addItem(g.duplicate, () => editor.view.dispatch(editor.state.tr.insert(block.to, doc.slice(block.from, block.to).content)));
    addItem(g.delete, () => {
      const tr = editor.state.tr.delete(block.from, block.to);
      editor.view.dispatch(tr);
    });
    placeMenu();
  }

  function openMenu() {
    if (inner) return openInnerMenu();
    const units = unitsOf(editor.state.doc);
    const unit = units[active];
    if (!unit) return;
    const { first, last } = targetRange();
    const several = last > first;
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
    add(g.moveUp, () => moveUnitsBy(editor, first, last, -1), first > 0);
    add(g.moveDown, () => moveUnitsBy(editor, first, last, 1), last < units.length - 1);
    add(g.duplicate, () => duplicateUnits(editor, first, last));
    add(g.delete, () => deleteUnits(editor, first, last));
    add(g.addBelow, () => addParagraphAfter(editor, last));
    if (!several) add(g.copyLink, () => copyLink(active));
    if (!several && unit.node.type.name === "columns") add(g.unwrapColumns, () => unwrapColumns(editor, unit.from));
    if (!several && canTurnInto(unit.node)) {
      menu.append(el("div", "menu-label", g.turnInto));
      for (const name of TURN_NAMES) add(strings.slash[name], () => turnInto(editor, active, name));
    }
    placeMenu();
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
  // Where a drop at pointer position (x, y) would land. Between blocks is a horizontal line, as
  // before. Near the left or right edge of a block it makes columns (a vertical line), at the end
  // of a columns block it adds a column, and inside a column it goes between that column's blocks.
  function targetAt(x, y) {
    const units = unitsOf(editor.state.doc);
    const note = editor.view.dom.getBoundingClientRect();
    const range = drag && drag.source;
    const overlaps = (from, to) => range && range.from < to && range.to > from;
    if (drag && drag.canColumn) {
      for (const unit of units) {
        const dom = blockDom(unit);
        if (!(dom instanceof HTMLElement)) continue;
        const rect = dom.getBoundingClientRect();
        if (y < rect.top || y > rect.bottom) continue;
        if (unit.node.type.name === "columns") {
          const columns = columnsOf(unit);
          const full = columns.length >= 5;
          if (!full && x >= rect.left - SIDE_PX && x < rect.left + SIDE_PX / 2) return { drop: { type: "edge", columnsFrom: unit.from, side: "left" }, line: { vertical: true, x: rect.left - 2, top: rect.top, height: rect.height } };
          if (!full && x <= rect.right + SIDE_PX && x > rect.right - SIDE_PX / 2) return { drop: { type: "edge", columnsFrom: unit.from, side: "right" }, line: { vertical: true, x: rect.right, top: rect.top, height: rect.height } };
          for (const column of columns) {
            if (!(column.dom instanceof HTMLElement)) continue;
            const box = column.dom.getBoundingClientRect();
            if (x < box.left || x > box.right) continue;
            for (const child of column.children) {
              const childBox = child.dom instanceof HTMLElement ? child.dom.getBoundingClientRect() : null;
              if (childBox && y < childBox.top + childBox.height / 2) return { drop: { type: "at", pos: child.from }, line: { vertical: false, x: box.left, width: box.width, y: childBox.top - 2 } };
            }
            const last = column.children[column.children.length - 1];
            const lastBox = last && last.dom instanceof HTMLElement ? last.dom.getBoundingClientRect() : box;
            return { drop: { type: "at", pos: column.pos + column.node.nodeSize - 1 }, line: { vertical: false, x: box.left, width: box.width, y: lastBox.bottom + 2 } };
          }
          continue;
        }
        if (unit.count > 1 || overlaps(unit.from, unit.to) || !fitsInColumn(editor.state.schema, [unit.node])) continue;
        if (x >= rect.left - SIDE_PX && x < rect.left + SIDE_PX / 2) return { drop: { type: "side", from: unit.from, to: unit.to, side: "left" }, line: { vertical: true, x: rect.left - 2, top: rect.top, height: rect.height } };
        if (x <= rect.right + SIDE_PX && x > rect.right - SIDE_PX / 2) return { drop: { type: "side", from: unit.from, to: unit.to, side: "right" }, line: { vertical: true, x: rect.right, top: rect.top, height: rect.height } };
      }
    }
    for (let i = 0; i < units.length; i++) {
      const dom = blockDom(units[i]);
      if (!(dom instanceof HTMLElement)) continue;
      const rect = dom.getBoundingClientRect();
      if (y < rect.top + rect.height / 2) return { slot: i, drop: { type: "at", pos: units[i].from }, line: { vertical: false, x: note.left, width: note.width, y: rect.top - 2 } };
    }
    const lastDom = blockDom(units[units.length - 1]);
    const rect = lastDom instanceof HTMLElement ? lastDom.getBoundingClientRect() : { bottom: 0 };
    return { slot: units.length, drop: { type: "at", pos: editor.state.doc.content.size }, line: { vertical: false, x: note.left, width: note.width, y: rect.bottom + 2 } };
  }

  function showDropLine(target) {
    const area = scroller.getBoundingClientRect();
    const line = target.line;
    dropLine.hidden = false;
    dropLine.classList.toggle("drop-line-vertical", line.vertical);
    if (line.vertical) {
      dropLine.style.left = `${line.x}px`;
      dropLine.style.top = `${Math.max(area.top, line.top)}px`;
      dropLine.style.height = `${Math.max(4, Math.min(line.top + line.height, area.bottom) - Math.max(area.top, line.top))}px`;
      dropLine.style.width = "";
    } else {
      dropLine.style.left = `${line.x}px`;
      dropLine.style.width = `${line.width}px`;
      dropLine.style.top = `${Math.max(area.top, Math.min(line.y, area.bottom))}px`;
      dropLine.style.height = "";
    }
  }

  // The blocks being dragged, as elements.
  function sourceDoms(range) {
    if (inner) return [editor.view.nodeDOM(inner.from)];
    const units = unitsOf(editor.state.doc);
    const out = [];
    for (let i = range.first; i <= range.last; i++) out.push(blockDom(units[i]));
    return out;
  }

  // The half see-through copy of the block (or blocks) that follows the pointer. The original
  // stays where it is until the drop. The copy keeps the distance the pointer had when the
  // block was grabbed.
  function makeGhost(range) {
    const doms = sourceDoms(range).filter((dom) => dom instanceof HTMLElement);
    if (!doms.length) return null;
    const top = doms[0].getBoundingClientRect();
    const ghost = el("div", "drag-ghost");
    ghost.setAttribute("aria-hidden", "true");
    ghost.inert = true;
    ghost.style.width = `${top.width}px`;
    for (const dom of doms) {
      const copy = dom.cloneNode(true);
      copy.removeAttribute("id");
      for (const node of copy.querySelectorAll("[id]")) node.removeAttribute("id");
      for (const node of copy.querySelectorAll("[contenteditable]")) node.removeAttribute("contenteditable");
      // The copy sits outside the editor, so it does not get the editor's spacing between blocks.
      const look = getComputedStyle(dom);
      copy.style.marginTop = look.marginTop;
      copy.style.marginBottom = look.marginBottom;
      copy.style.fontSize = look.fontSize;
      ghost.append(copy);
    }
    document.body.append(ghost);
    return { node: ghost, left: top.left, top: top.top };
  }

  function moveGhost(x, y) {
    if (!drag || !drag.ghost) return;
    drag.ghost.node.style.left = `${drag.ghost.left + (x - drag.startX)}px`;
    drag.ghost.node.style.top = `${drag.ghost.top + (y - drag.startY)}px`;
  }

  function endDrag(apply) {
    if (!drag) return;
    const { pointerId, lastX, last, source, fromInner, canColumn } = drag;
    const wasDragging = drag.dragging;
    cancelAnimationFrame(drag.frame);
    if (drag.ghost) drag.ghost.node.remove();
    const range = drag.range;
    drag = null;
    document.body.classList.remove("block-dragging");
    dropLine.hidden = true;
    try {
      handle.releasePointerCapture(pointerId);
    } catch {
      // The capture may already be gone (for example after a cancel); nothing to undo.
    }
    if (!apply) return;
    if (wasDragging) {
      drag = { source, canColumn };
      const target = targetAt(lastX, last);
      drag = null;
      // Between two top-level blocks, the older code keeps block ids with their blocks.
      if (!fromInner && target.slot !== undefined) moveUnits(editor, range.first, range.last, target.slot);
      else applyDrop(editor, source, target.drop);
    } else if (menu.hidden) openMenu();
    else closeMenu();
    refresh();
  }

  // Scrolls the note while a block is held near the top or bottom edge.
  function autoScroll() {
    if (!drag || !drag.dragging) return;
    const area = scroller.getBoundingClientRect();
    if (drag.last < area.top + EDGE_PX) scroller.scrollTop -= 14;
    else if (drag.last > area.bottom - EDGE_PX) scroller.scrollTop += 14;
    showDropLine(targetAt(drag.lastX, drag.last));
    drag.frame = requestAnimationFrame(autoScroll);
  }

  // mousedown/touchstart default actions would move focus or scroll the page; pointer events
  // do the real work.
  handle.addEventListener("mousedown", (event) => event.preventDefault());
  handle.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 && event.pointerType === "mouse") return;
    event.preventDefault();
    if (active < 0 && !inner) return;
    handle.setPointerCapture(event.pointerId);
    const range = inner ? { first: 0, last: 0 } : targetRange();
    let source;
    if (inner) source = { from: inner.from, to: inner.to };
    else {
      const units = unitsOf(editor.state.doc);
      source = { from: units[range.first].from, to: units[range.last].to };
    }
    const moved = nodesBetween(editor.state.doc, source.from, source.to);
    drag = {
      pointerId: event.pointerId, startY: event.clientY, startX: event.clientX, last: event.clientY, lastX: event.clientX, dragging: false,
      range, source, fromInner: Boolean(inner), canColumn: fitsInColumn(editor.state.schema, moved), ghost: null, frame: 0,
    };
  });
  handle.addEventListener("pointermove", (event) => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    drag.last = event.clientY;
    drag.lastX = event.clientX;
    if (!drag.dragging && Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) > DRAG_START_PX) {
      drag.dragging = true;
      closeMenu();
      document.body.classList.add("block-dragging");
      drag.ghost = makeGhost(drag.range);
      drag.frame = requestAnimationFrame(autoScroll);
    }
    if (drag.dragging) {
      moveGhost(event.clientX, event.clientY);
      showDropLine(targetAt(event.clientX, event.clientY));
    }
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
      const { first, last } = unitRangeOf(editor.state.doc, editor.state.selection);
      return moveUnitsBy(editor, first, last, step);
    },
  };
}
