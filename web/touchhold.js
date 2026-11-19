// Keeps the web view's own touch gestures off a drawing surface.
//
// The drawing code handles every finger itself (pointer events): one finger pans or draws, two
// fingers zoom the drawing. The CSS `touch-action: none` on the surfaces tells the web view so,
// and the Windows and Android web views (Chromium) obey it. The Linux web view (WebKitGTK) does
// not: it hands any touch the page did not cancel to its own gestures, so two fingers zoomed the
// whole window and a finger that should draw scrolled the page. Cancelling the touch events
// themselves stops that everywhere. Pointer events still arrive, because they are sent before
// the touch events they belong to.

/**
 * Cancels touchstart and touchmove on `element` while `holding()` says so. Returns a function
 * that removes the listeners.
 */
export function holdTouches(element, holding = () => true) {
  const stop = (event) => {
    if (event.cancelable && holding(event)) event.preventDefault();
  };
  element.addEventListener("touchstart", stop, { passive: false });
  element.addEventListener("touchmove", stop, { passive: false });
  return () => {
    element.removeEventListener("touchstart", stop);
    element.removeEventListener("touchmove", stop);
  };
}
