// Dragging pages and folders in the page list into other folders, and the touch versions of
// the right-click menu.
//
// Pointer events are used instead of the browser's own drag and drop, because that does not
// work with a finger on the Android web view and gives no control over the look.
//
// Mouse and pen start a drag after a few pixels of movement. A finger has three gestures that
// would otherwise fight over one touch (scrolling, dragging and the menu), so they are told
// apart by time and by movement:
//   - a quick tap opens the entry, and two quick taps on the same entry open its menu;
//   - moving the finger at once scrolls the list, as usual;
//   - holding still for a moment "picks the entry up" (a short buzz and a highlight), and then
//     moving drags it;
//   - holding still for longer opens the menu.
// The phone's own long-press menu is switched off in the list, because it fired at the same
// moment the drag was meant to start.

import { icon } from "./icons.js";

const START_PX = 6;
// A finger that moves more than this before it is picked up is scrolling.
const SCROLL_PX = 10;
const PICK_UP_MS = 350;
const MENU_MS = 800;
const DOUBLE_TAP_MS = 350;
const EDGE_PX = 40;
const EDGE_SPEED = 12;

/** True when moving `path` into `folder` ("" is the top) would do something allowed. */
export function canMoveInto(path, folder) {
  if (folder === path || folder.startsWith(`${path}/`)) return false; // into itself or below itself
  const slash = path.lastIndexOf("/");
  const parent = slash === -1 ? "" : path.slice(0, slash);
  return folder !== parent; // already there
}

function scrollParent(node) {
  for (let el = node; el && el !== document.body; el = el.parentElement) {
    const overflow = getComputedStyle(el).overflowY;
    if ((overflow === "auto" || overflow === "scroll") && el.scrollHeight > el.clientHeight) return el;
  }
  return null;
}

/**
 * Lets entries in `container` be dragged onto folder rows or onto the empty space below the
 * list (the top of the vault). `onMove(path, folder)` does the work. Safe to call once per
 * container: it listens on the container, so a redrawn list keeps working.
 */
export function enableTreeDrag(container, onMove) {
  let drag = null;
  let lastTap = null; // { path, time } of the last finger tap that ended on an entry
  let lastPointerType = "mouse";
  let frame = 0;

  // The phone's own long-press menu is replaced by ours (see the top of the file). Only events
  // from a finger are dropped; right-click with a mouse or pen and the menu key still work, and
  // so does the menu this file opens itself (a script-made event is not "trusted").
  container.addEventListener("contextmenu", (event) => {
    if (event.isTrusted && lastPointerType === "touch") {
      event.preventDefault();
      event.stopPropagation();
    }
  }, true);
  // Two taps on a folder would otherwise also rename it.
  container.addEventListener("dblclick", (event) => {
    if (lastPointerType === "touch") event.stopPropagation();
  }, true);

  container.addEventListener("pointerdown", (event) => {
    lastPointerType = event.pointerType;
    if (event.button !== 0 || drag) return;
    const button = event.target instanceof Element ? event.target.closest(".tree-button[data-path]") : null;
    if (!button || !container.contains(button)) return;
    const touch = event.pointerType === "touch";
    drag = {
      path: button.dataset.path, name: button.querySelector(".tree-label")?.textContent || "", kind: button.dataset.kind, button, touch,
      startX: event.clientX, startY: event.clientY, x: event.clientX, y: event.clientY,
      active: false, armed: false, preview: null, target: null, targetRow: null, timers: [], scroller: null,
    };
    if (touch) {
      drag.timers.push(setTimeout(pickUp, PICK_UP_MS), setTimeout(openMenu, MENU_MS));
    }
    document.addEventListener("pointermove", move, true);
    document.addEventListener("pointerup", up, true);
    document.addEventListener("pointercancel", cancel, true);
    document.addEventListener("keydown", key, true);
  });

  // The finger has been still long enough: the entry is picked up. Scrolling is switched off
  // for the rest of this touch (a touchmove that is not cancelled would start it).
  function pickUp() {
    if (!drag || drag.active) return;
    drag.armed = true;
    drag.button.closest(".tree-row")?.classList.add("picked-up");
    try { navigator.vibrate?.(15); } catch { /* a phone without a vibrator */ }
    document.addEventListener("touchmove", stopScroll, { passive: false, capture: true });
  }

  function stopScroll(event) {
    if (event.cancelable) event.preventDefault();
  }

  // Held still for longer: the menu. The click that follows lifting the finger is swallowed so
  // it does not also open or fold the entry.
  function openMenu() {
    if (!drag || drag.active) return;
    const { button, x, y } = drag;
    finish();
    window.addEventListener("click", swallowClick, { capture: true, once: true });
    setTimeout(() => window.removeEventListener("click", swallowClick, true), 600);
    showMenu(button, x, y);
  }

  // Asks for the same menu a right-click gives. The list listens for "contextmenu", so the
  // touch gestures send it one.
  function showMenu(button, x, y) {
    button.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 2 }));
  }

  function move(event) {
    if (!drag) return;
    drag.x = event.clientX;
    drag.y = event.clientY;
    const moved = Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY);
    if (!drag.active) {
      if (drag.touch && !drag.armed) {
        // Moving before the pick-up is a scroll, which the browser does by itself.
        if (moved > SCROLL_PX) finish();
        return;
      }
      if (moved <= START_PX) return;
      begin();
    }
    event.preventDefault();
    schedule();
  }

  function begin() {
    drag.active = true;
    drag.timers.forEach(clearTimeout);
    drag.timers = [];
    drag.scroller = scrollParent(container);
    document.body.classList.add("tree-dragging");
    const preview = document.createElement("div");
    preview.className = "drag-preview";
    preview.setAttribute("aria-hidden", "true");
    const text = document.createElement("span");
    text.textContent = drag.name;
    preview.append(icon(drag.kind === "folder" ? "folder" : "note"), text);
    document.body.append(preview);
    drag.preview = preview;
    // A pen can start a scroll too; once dragging, scrolling is switched off.
    if (!drag.armed) document.addEventListener("touchmove", stopScroll, { passive: false, capture: true });
    drag.armed = true;
    // The click that ends a drag must not also open or fold the entry it started on.
    window.addEventListener("click", swallowClick, { capture: true, once: true });
  }

  function swallowClick(event) {
    event.stopPropagation();
    event.preventDefault();
  }

  // Moves are handled once per screen refresh with the newest position, not once per event: a
  // pen reports far more positions than the screen can show, and looking up the element under
  // each one was what made dragging lag.
  function schedule() {
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      if (!drag || !drag.active) return;
      const { x, y, touch } = drag;
      // A finger covers what is under it, so the preview rides above the finger.
      drag.preview.style.transform = `translate(${x + 12}px, ${y + (touch ? -48 : 12)}px)`;
      autoScroll(y);
      setTarget(targetAt(x, y));
    });
  }

  // Near the top or bottom edge of the list it scrolls, so a folder out of view can be reached.
  function autoScroll(y) {
    const scroller = drag.scroller;
    if (!scroller) return;
    const box = scroller.getBoundingClientRect();
    if (y < box.top + EDGE_PX) scroller.scrollTop -= EDGE_SPEED;
    else if (y > box.bottom - EDGE_PX) scroller.scrollTop += EDGE_SPEED;
    else return;
    schedule(); // keeps going while the pointer stays at the edge
  }

  // Which folder would receive the drop: the folder row under the pointer, or the top of the
  // vault when the pointer is over empty space in the list. Anything else is no target.
  function targetAt(x, y) {
    const under = document.elementFromPoint(x, y);
    if (!under || !container.contains(under)) return null;
    const row = under.closest(".tree-row");
    if (row) {
      const button = row.querySelector(".tree-button[data-path]");
      if (button && button.dataset.kind === "folder" && canMoveInto(drag.path, button.dataset.path)) return { folder: button.dataset.path, row };
      return null;
    }
    // Only the empty space itself counts, not the gaps inside the list.
    return under === container && canMoveInto(drag.path, "") ? { folder: "", row: null } : null;
  }

  function setTarget(target) {
    const same = target && drag.target && target.folder === drag.target.folder;
    if (same) return;
    drag.targetRow?.classList.remove("drop-target");
    container.classList.remove("drop-target");
    drag.target = target;
    drag.targetRow = target ? target.row : null;
    if (!target) return;
    if (target.row) target.row.classList.add("drop-target");
    else container.classList.add("drop-target");
  }

  function up(event) {
    if (!drag) return;
    const { path, target, active, touch, button } = drag;
    const quickTap = touch && !active && !drag.armed;
    finish();
    if (active && target) onMove(path, target.folder);
    if (quickTap) twoTaps(button, event.clientX, event.clientY);
  }

  // The second quick tap on the same entry opens its menu. Entries are told apart by path, not
  // by element: the first tap on a folder redraws the list, which makes new elements.
  function twoTaps(button, x, y) {
    const now = Date.now();
    const path = button.dataset.path;
    if (lastTap && lastTap.path === path && now - lastTap.time <= DOUBLE_TAP_MS) {
      lastTap = null;
      showMenu(button, x, y);
    } else {
      lastTap = { path, time: now };
    }
  }

  // The browser took the touch for scrolling, or the system interrupted it.
  function cancel() {
    if (drag) finish();
  }

  function key(event) {
    if (event.key !== "Escape" || !drag) return;
    event.preventDefault();
    event.stopPropagation();
    finish();
  }

  function finish() {
    document.removeEventListener("pointermove", move, true);
    document.removeEventListener("pointerup", up, true);
    document.removeEventListener("pointercancel", cancel, true);
    document.removeEventListener("keydown", key, true);
    document.removeEventListener("touchmove", stopScroll, true);
    drag.timers.forEach(clearTimeout);
    drag.button.closest(".tree-row")?.classList.remove("picked-up");
    cancelAnimationFrame(frame);
    frame = 0;
    if (drag.active) {
      setTarget(null);
      drag.preview.remove();
      document.body.classList.remove("tree-dragging");
      // The click after a cancelled drag still has to be swallowed, then the listener goes.
      setTimeout(() => window.removeEventListener("click", swallowClick, true), 0);
    }
    drag = null;
  }
}
