// The list of recently used folders behind the folder menu. Kept apart from the screens so
// the rules (how long, what is allowed, no repeats) can be tested on their own.
//
// The list is read from the settings file, which another program could change, so every
// entry is checked: plain text, not empty, no control characters, not absurdly long.

export const MAX_RECENT = 8;
export const MAX_PATH_LENGTH = 1024;

const CONTROL = /[\u0000-\u001f\u007f]/;

function usable(path) {
  return typeof path === "string" && path.length > 0 && path.length <= MAX_PATH_LENGTH && !CONTROL.test(path);
}

/** Reads the list from untrusted json: anything not allowed is dropped, repeats are merged. */
export function cleanRecent(raw) {
  if (!Array.isArray(raw)) return [];
  const seen = new Set();
  const out = [];
  for (const item of raw) {
    if (!usable(item) || seen.has(item)) continue;
    seen.add(item);
    out.push(item);
    if (out.length === MAX_RECENT) break;
  }
  return out;
}

/** Puts `path` first. The oldest entries fall off the end. */
export function addRecent(list, path) {
  if (!usable(path)) return cleanRecent(list);
  return cleanRecent([path, ...list.filter((item) => item !== path)]);
}

export function removeRecent(list, path) {
  return cleanRecent(list.filter((item) => item !== path));
}

/** The name shown for a folder: its last part, for both / and \ paths. */
export function folderLabel(path) {
  const trimmed = String(path).replace(/[\\/]+$/, "");
  const last = trimmed.slice(Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\")) + 1);
  return last || String(path);
}
