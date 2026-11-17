// The pages seen in this run, in order, with a position, so Back and Forward (and the Android
// back gesture, which the page joins by using the browser's own history, see main.js) can go
// through them. Kept apart from the screens so the rules can be tested on their own.
//
// Positions are plain numbers that never change once handed out: the browser history entry
// made for a page carries the page's position, and going back or forward to an entry says which
// position to show. So the list is never trimmed from the front.

export const MAX_ENTRIES = 1000;

export function createNavHistory() {
  let entries = [];
  let index = -1;
  return {
    /** The page opened by the person (not by Back or Forward). Returns its position, or null if it is the page already shown. */
    visit(path) {
      if (index >= 0 && entries[index] === path) return null;
      entries = entries.slice(0, index + 1);
      if (entries.length >= MAX_ENTRIES) return null;
      entries.push(path);
      index = entries.length - 1;
      return index;
    },
    /** Moves to a position the browser history gave back. Returns the page there, or null if there is none. */
    goto(position) {
      if (!Number.isInteger(position) || position < 0 || position >= entries.length) return null;
      index = position;
      return entries[index];
    },
    /** A page or folder was renamed or moved: `fix` turns an old path into its new one. */
    remap(fix) {
      entries = entries.map(fix);
    },
    canBack: () => index > 0,
    canForward: () => index >= 0 && index < entries.length - 1,
    get position() {
      return index;
    },
    get length() {
      return entries.length;
    },
  };
}
