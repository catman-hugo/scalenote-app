// Dragging pages and folders in the page list into other folders.
//
// Pointer events are used instead of the browser's own drag and drop, because that does not
// work with a finger on the Android web view and gives no control over the look. Mouse and pen
// start a drag after a few pixels of movement. A finger scrolls the list instead; on a touch
// screen the "Move to" entry in the right-click menu does the same job.

import { icon } from "./icons.js";

const START_PX = 6;

/** True when moving `path` into `folder` ("" is the top) would do something allowed. */
export function canMoveInto(path, folder) {
  if (folder === path || folder.startsWith(`${path}/`)) return false; // into itself or below itself
  const slash = path.lastIndexOf("/");
  const parent = slash === -1 ? "" : path.slice(0, slash);
  return folder !== parent; // already there
}

/**
 * Lets entries in `container` be dragged onto folder rows or onto the empty space below the
 * list (the top of the vault). `onMove(path, folder)` does the work. Safe to call once per
 * container: it listens on the container, so a redrawn list keeps working.
 */
export function enableTreeDrag(container, onMove) {
  let drag = null;

  container.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || event.pointerType === "touch" || drag) return;
    const button = event.target instanceof Element ? event.target.closest(".tree-button[data-path]") : null;
    if (!button || !container.contains(button)) return;
    drag = { path: button.dataset.path, name: button.querySelector(".tree-label")?.textContent || "", kind: button.dataset.kind, startX: event.clientX, startY: event.clientY, active: false, preview: null, target: null, targetRow: null };
    document.addEventListener("pointermove", move, true);
    document.addEventListener("pointerup", up, true);
    document.addEventListener("keydown", key, true);
  });

  function move(event) {
    if (!drag) return;
    if (!drag.active) {
      if (Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) <= START_PX) return;
      begin();
    }
    event.preventDefault();
    drag.preview.style.left = `${event.clientX + 12}px`;
    drag.preview.style.top = `${event.clientY + 12}px`;
    setTarget(targetAt(event.clientX, event.clientY));
  }

  function begin() {
    drag.active = true;
    document.body.classList.add("tree-dragging");
    const preview = document.createElement("div");
    preview.className = "drag-preview";
    preview.setAttribute("aria-hidden", "true");
    const text = document.createElement("span");
    text.textContent = drag.name;
    preview.append(icon(drag.kind === "folder" ? "folder" : "note"), text);
    document.body.append(preview);
    drag.preview = preview;
    // The click that ends a drag must not also open or fold the entry it started on.
    window.addEventListener("click", swallowClick, { capture: true, once: true });
  }

  function swallowClick(event) {
    event.stopPropagation();
    event.preventDefault();
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

  function up() {
    if (!drag) return;
    const { path, target, active } = drag;
    finish();
    if (active && target) onMove(path, target.folder);
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
    document.removeEventListener("keydown", key, true);
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
