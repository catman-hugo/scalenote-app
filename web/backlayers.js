// The Android back gesture goes through the browser's own history (see "Back and Forward" in
// main.js). Without help it would skip over an open window such as Settings and leave the app.
// So anything that sits on top of the page (a dialog, or one group of Settings on a phone) adds
// a "layer": one extra history entry. Back then takes away the top layer instead of the page.
//
// How it works:
// - Opening a layer pushes an entry that carries the page position and the number of layers.
// - The back gesture lands on the entry below. Its layer count is lower than the number open,
//   so the layers above it are taken away (a dialog closes, a Settings group goes back to the list).
// - A layer closed another way (the Close button, Escape, a click outside) takes its own entry
//   off again with history.go. That arrives later as a popstate, which is then ignored. Anything
//   that wants to change the history in the meantime waits for it with `whenSettled`.

const layers = [];
let pending = 0;
let waiting = [];

function depthOf(state) {
  return state && Number.isInteger(state.layer) ? state.layer : 0;
}

function pageOf(state) {
  return state && Number.isInteger(state.nav) ? state.nav : null;
}

/** Runs `run` now, or once a history move started here has arrived. */
export function whenSettled(run) {
  if (pending === 0) run();
  else waiting.push(run);
}

function settle() {
  if (pending > 0) pending -= 1;
  if (pending > 0) return;
  const queued = waiting;
  waiting = [];
  for (const run of queued) run();
}

/**
 * Adds a layer. `onBack` is called when the back gesture takes it away.
 * Returns `remove`, to call when the layer goes away by other means. Calling it twice is harmless.
 */
export function addLayer(onBack) {
  const layer = { onBack };
  whenSettled(() => {
    if (!layer.gone) {
      layers.push(layer);
      history.pushState({ nav: pageOf(history.state), layer: layers.length }, "");
    }
  });
  return () => removeLayer(layer);
}

function removeLayer(layer) {
  if (layer.gone) return;
  layer.gone = true;
  const at = layers.indexOf(layer);
  // Not pushed yet (it was waiting for a history move): nothing to take back.
  if (at < 0) return;
  // Layers opened on top of this one go with it (Settings closing also ends its open group).
  const steps = layers.length - at;
  for (const above of layers.splice(at)) above.gone = true;
  pending += 1;
  history.go(-steps);
}

/**
 * Called first on every popstate. Returns true if the move was about layers, so the page itself
 * must not change.
 */
export function backThroughLayers(event) {
  if (pending > 0) {
    settle();
    return true;
  }
  const depth = depthOf(event.state);
  if (depth < layers.length) {
    // Back: take away every layer above the entry that was reached, top first.
    for (const layer of layers.splice(depth).reverse()) {
      layer.gone = true;
      layer.onBack();
    }
    return true;
  }
  if (depth > layers.length) {
    // Forward onto the entry of a layer that has since closed: step back off it.
    pending += 1;
    history.go(layers.length - depth);
    return true;
  }
  return false;
}

/**
 * Makes the back gesture close `dialog` the way Escape would: a "cancel" event first, so a dialog
 * that refuses Escape also refuses back (its layer is then put back). Call it once per dialog.
 */
export function closeOnBack(dialog) {
  let remove = null;
  const onBack = () => {
    remove = null;
    const cancel = new Event("cancel", { cancelable: true });
    if (dialog.dispatchEvent(cancel)) dialog.close();
    else remove = addLayer(onBack);
  };
  // A dialog has no "opened" event that every webview sends, so watch its `open` attribute. The
  // watcher also sees it close (it runs before the "close" event), so a page opened right after
  // the dialog closes finds the history already being put straight (see whenSettled).
  new MutationObserver(() => {
    if (dialog.open && !remove) remove = addLayer(onBack);
    else if (!dialog.open && remove) {
      remove();
      remove = null;
    }
  }).observe(dialog, { attributes: true, attributeFilter: ["open"] });
}
