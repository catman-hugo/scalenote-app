// The look of folders: an icon style and a colour per folder, kept in one small hidden file in
// the vault (.scalenote/folder-icons.json, see foldericons.rs).
//
// File format 1:  { "format": 1, "icons": { "School/Maths": { "style": "notebook", "colour": "blue" } } }
//
// The file may have come from another device or program, so it is treated as untrusted: every
// value is checked against the lists below, and what is not understood is ignored when drawing.
// Writing changes only the one folder asked for and keeps every other entry exactly as it was, so
// an entry this version does not understand is not lost. A file with a newer format number is
// never written to, because an older version cannot know what is in it.

export const FORMAT = 1;
export const STYLES = ["folder", "notebook", "line"];
// OneNote's sixteen section colours, by name. The picture is a plain mid-tone that reads on both
// light and dark page lists; "none" keeps the normal text colour (the look before colours existed).
export const COLOURS = [
  "blue", "yellow", "green", "red",
  "purple", "cyan", "orange", "magenta",
  "blueMist", "purpleMist", "tan", "lemonLime",
  "apple", "teal", "redChalk", "silver",
];
export const COLOUR_HEX = {
  blue: "#2b7cd3", yellow: "#e8b400", green: "#2f9e44", red: "#d9453b",
  purple: "#8a5cc0", cyan: "#12a4c4", orange: "#ee8a1c", magenta: "#c8348f",
  blueMist: "#8fa8d8", purpleMist: "#b09ad0", tan: "#c4a46a", lemonLime: "#a9c41a",
  apple: "#5fb832", teal: "#1f9a8f", redChalk: "#e8837a", silver: "#9aa3ad",
};

// Generous for a real vault, small enough that a hostile file cannot grow without end.
const MAX_ENTRIES = 5000;
const MAX_KEY = 1024;

// A folder may be called "__proto__" or "constructor", so entries are set as plain own properties
// and looked up with `has`, never with `in` or a bare assignment.
export const has = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
function put(object, key, value) {
  Object.defineProperty(object, key, { value, enumerable: true, writable: true, configurable: true });
}

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

/** One entry as `{style, colour}`, or null when it is not valid. `colour` is "none" for no colour. */
export function readEntry(value) {
  if (!isObject(value)) return null;
  const style = value.style === undefined ? "folder" : value.style;
  const colour = value.colour === undefined ? "none" : value.colour;
  if (!STYLES.includes(style)) return null;
  if (colour !== "none" && !COLOURS.includes(colour)) return null;
  return { style, colour };
}

/**
 * Reads the file text (or null for no file). Returns `{ icons, raw, readOnly }`:
 * `icons` maps folder path -> {style, colour} for the valid entries, `raw` is the parsed object
 * kept for writing, and `readOnly` is true when the file must not be changed.
 */
export function parseIcons(text) {
  const empty = { icons: {}, raw: {}, readOnly: false };
  if (text === null || text === undefined) return empty;
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return { ...empty, readOnly: true };
  }
  if (!isObject(data) || !Number.isInteger(data.format) || data.format < 1) return { ...empty, readOnly: true };
  if (data.format > FORMAT) return { ...empty, readOnly: true };
  if (!isObject(data.icons)) return { ...empty, readOnly: true };
  const icons = {};
  let count = 0;
  for (const [path, value] of Object.entries(data.icons)) {
    if (++count > MAX_ENTRIES) break;
    if (path.length > MAX_KEY) continue;
    const entry = readEntry(value);
    // The default look is not stored, so it is not drawn from the file either.
    if (entry) put(icons, path, entry);
  }
  return { icons, raw: data.icons, readOnly: false };
}

function write(raw) {
  return JSON.stringify({ format: FORMAT, icons: raw });
}

/** True when another entry can be added (the file stays within its limit). */
export function hasRoom(parsed, path) {
  return has(parsed.raw, path) || Object.keys(parsed.raw).length < MAX_ENTRIES;
}

/**
 * The file text after giving `path` the look `{style, colour}`. The default look (folder, no
 * colour) removes the entry. Returns null when the file must not be changed.
 */
export function withIcon(parsed, path, style, colour) {
  if (parsed.readOnly || !STYLES.includes(style) || (colour !== "none" && !COLOURS.includes(colour))) return null;
  if (path.length === 0 || path.length > MAX_KEY || !hasRoom(parsed, path)) return null;
  const raw = { ...parsed.raw };
  if (style === "folder" && colour === "none") delete raw[path];
  else put(raw, path, { style, colour });
  return write(raw);
}

/**
 * The file text after a folder was renamed or moved: its entry and the entries of the folders
 * inside it follow it. Returns null when nothing needs to change.
 */
export function withRenamed(parsed, oldPath, newPath) {
  if (parsed.readOnly) return null;
  const raw = {};
  let changed = false;
  for (const [path, value] of Object.entries(parsed.raw)) {
    if (path === oldPath || path.startsWith(`${oldPath}/`)) {
      put(raw, newPath + path.slice(oldPath.length), value);
      changed = true;
    } else if (!has(raw, path)) {
      put(raw, path, value);
    }
  }
  return changed ? write(raw) : null;
}
