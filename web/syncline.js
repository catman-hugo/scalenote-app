// The sync status line at the bottom of the page list: always visible while sync is on and a
// device is paired, so a sync is never silent. It asks Rust for the sync status every few
// seconds (a cheap local call) and shows one short sentence.

import { backend } from "./backend.js";
import { statusLineText } from "./syncrules.js";
import { strings } from "./strings.js";

const LOOK_MS = 4000;

export function startSyncLine(node) {
  async function look() {
    if (document.hidden) return;
    try {
      const text = statusLineText(await backend.syncStatus(), strings.syncLine);
      node.textContent = text;
      node.hidden = text === "";
    } catch {
      node.hidden = true;
    }
  }
  look();
  setInterval(look, LOOK_MS);
  // The Sync tab asks for a fresh line right after an action, instead of waiting for the timer.
  document.addEventListener("scalenote-sync-changed", look);
}
