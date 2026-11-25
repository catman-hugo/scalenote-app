// The "Available offline" choices as the interface needs them. The rules themselves live in
// Rust (src-tauri/core/src/sync/keep.rs); these functions read them the same way so the menus can
// say what holds for a folder or page, and the page list can show what is not on this device.

// The four kinds a choice can keep, in the order the menu lists them.
export const KINDS = ["t", "d", "i", "f"];

// Whether a choice made for `rule` covers `path`: the same path, something inside that folder,
// or the drawing of that page. "" is the whole notes folder. Same as `covers` in keep.rs.
export function covers(rule, path) {
  if (rule === "" || path === rule) return true;
  if (path.startsWith(rule + "/")) return true;
  return rule.endsWith(".md") && path === rule.slice(0, -3) + ".canvas.json";
}

/**
 * What holds for `path`: { kinds, from } where `from` is the path the choice was made on (null
 * when no choice covers it, which means everything is kept). The deepest choice wins.
 */
export function choiceFor(choices, path) {
  let best = null;
  for (const choice of choices || []) {
    if (covers(choice.path, path) && (!best || choice.path.length >= best.path.length)) best = choice;
  }
  return best ? { kinds: best.kinds, from: best.path } : { kinds: "tdif", from: null };
}

// The kinds of a choice as a set of letters ("-" is none).
export function kindSet(kinds) {
  return new Set(kinds === "-" ? [] : String(kinds || "").split("").filter((k) => KINDS.includes(k)));
}

// Letters for a set of kinds, in the fixed order ("-" when empty).
export function kindLetters(set) {
  const letters = KINDS.filter((k) => set.has(k)).join("");
  return letters || "-";
}

/**
 * The page list's entries plus those that are on other devices but not here: pages and files from
 * `notHere`, and any folder they need that is not here either. Added entries carry `missing: true`.
 * Only pages are listed (pictures and drawings travel with their pages).
 */
export function withMissing(entries, notHere) {
  const known = new Set(entries.map((e) => e.path));
  const added = [];
  const addFolder = (folder) => {
    if (!folder || known.has(folder)) return;
    addFolder(folder.includes("/") ? folder.slice(0, folder.lastIndexOf("/")) : "");
    known.add(folder);
    added.push({ path: folder, name: folder.split("/").pop(), kind: "folder", missing: true });
  };
  for (const path of notHere || []) {
    if (!/\.md$/i.test(path) || known.has(path)) continue;
    addFolder(path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "");
    known.add(path);
    added.push({ path, name: path.split("/").pop(), kind: "note", missing: true });
  }
  return added.length ? [...entries, ...added] : entries;
}
