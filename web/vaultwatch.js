// Notices that something in the open folder changed without ScaleNote doing it: another program
// saved a page, or a sync wrote files. Every few seconds it asks Rust for one number that
// changes with the folder's names, sizes and times (no file is read). When the number moves it
// waits for the next look to give the same number (a sync is still writing otherwise) and then
// calls `onChange` once.

// A test can look more often (it sets this before the app loads); the app itself never does.
const LOOK_MS = globalThis.__scalenoteWatchMs || 4000;

export function watchVault({ signature, onChange, isUsable }) {
  let last = null;
  let pending = null;
  let timer = null;
  let running = false;

  async function look() {
    if (running || document.hidden || !isUsable()) return;
    running = true;
    try {
      const now = await signature();
      if (last === null) {
        last = now;
      } else if (now !== last) {
        if (pending === now) {
          // The same number twice in a row: the writing has stopped.
          last = now;
          pending = null;
          await onChange();
        } else {
          pending = now;
        }
      } else {
        pending = null;
      }
    } catch {
      // No folder open, or the check failed: try again next time.
    } finally {
      running = false;
    }
  }

  timer = setInterval(look, LOOK_MS);
  return {
    // Takes the current state as the starting point (after the app itself changed something).
    reset() {
      last = null;
      pending = null;
      // The baseline is taken now, not at the next look, so a change right after opening a
      // folder is not mistaken for the folder's starting state.
      void look();
    },
    stop() {
      clearInterval(timer);
    },
  };
}
