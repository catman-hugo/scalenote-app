// Turns the page index (which pages have which tags) into what the Tags box and the Favorites
// list show. No editor or page code in here, so the tests can load it on their own.
//
// Tags are matched without regard to case ("#Plan" and "#plan" are one tag, as in Obsidian), and
// a nested tag counts for its parents too: a page tagged "school/maths" is listed under
// "school/maths" and under "school".

const titleOf = (path) => path.slice(path.lastIndexOf("/") + 1).replace(/\.md$/i, "");
const byText = (a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }) || (a < b ? -1 : a > b ? 1 : 0);

/** The title shown for a page path. */
export function pageTitle(path) {
  return titleOf(path);
}

/**
 * Every tag with the pages that have it, sorted by name. Each item is
 * { key, name, depth, pages: [path, ...] }: `key` is the lower case name used to match, `name`
 * is how it is shown (the spelling used most often, the first alphabetically on a tie), `depth`
 * is how many slashes it has, and `pages` are all pages with the tag or a tag inside it.
 */
export function buildTagList(pages) {
  const spellings = new Map(); // key -> Map(spelling -> count)
  const holders = new Map(); // key -> Set(path)
  for (const { path, tags } of pages) {
    for (const tag of tags) {
      const parts = tag.split("/");
      // The parents of a nested tag are tags of the page as well.
      for (let n = 1; n <= parts.length; n++) {
        const name = parts.slice(0, n).join("/");
        if (!name || parts.slice(0, n).some((p) => p === "")) continue;
        const key = name.toLowerCase();
        if (!holders.has(key)) {
          holders.set(key, new Set());
          spellings.set(key, new Map());
        }
        holders.get(key).add(path);
        if (n === parts.length) spellings.get(key).set(name, (spellings.get(key).get(name) || 0) + 1);
      }
    }
  }
  const list = [];
  for (const [key, paths] of holders) {
    const counted = [...spellings.get(key)];
    // A parent that only exists because of a nested tag has no spelling of its own.
    const name = counted.length ? counted.sort((a, b) => b[1] - a[1] || byText(a[0], b[0]))[0][0] : key;
    list.push({ key, name, depth: key.split("/").length - 1, pages: [...paths].sort((a, b) => byText(titleOf(a), titleOf(b)) || byText(a, b)) });
  }
  return list.sort((a, b) => byText(a.key, b.key));
}

/** The tags whose name contains `filter` (no regard to case). An empty filter keeps all. */
export function filterTags(list, filter) {
  const wanted = filter.trim().replace(/^#/, "").toLowerCase();
  return wanted ? list.filter((item) => item.key.includes(wanted)) : list;
}

const isInside = (key, parent) => key.startsWith(parent + "/");

/** The keys of the tags a nested tag sits in: "a/b/c" gives ["a", "a/b"]. */
export function parentTags(key) {
  const parts = key.split("/");
  return parts.slice(1).map((_, i) => parts.slice(0, i + 1).join("/"));
}

/**
 * The rows the Tags box shows. A tag with tags inside it (a main tag) can be folded: its
 * subtags only show when its key is in `unfolded`, and then only if every tag above them is
 * unfolded too. While a filter is typed, folding is not used: every match is listed.
 * Each row is the item plus `parent` (it has subtags) and `unfolded` (they are showing).
 */
export function tagRows(list, filter, unfolded) {
  if (filter.trim().replace(/^#/, "") !== "") return filterTags(list, filter).map((item) => ({ ...item, parent: false, unfolded: false }));
  // The list is sorted by key, and "a/" sorts after "a", so a tag's subtags follow it. Tags
  // such as "a-b" can sit in between, so every later key is checked, not only the next one.
  const parents = new Set();
  for (const item of list) for (const key of parentTags(item.key)) parents.add(key);
  return list
    .filter((item) => parentTags(item.key).every((key) => unfolded.has(key)))
    .map((item) => ({ ...item, parent: parents.has(item.key), unfolded: parents.has(item.key) && unfolded.has(item.key) }));
}

/**
 * What a click on a tag row does. Returns the new { unfolded, selected }: `selected` is the tag
 * whose pages are listed ("" for none). A main tag shows its subtags and its pages on the first
 * click and hides both on the next; hiding also closes a subtag that was open inside it.
 */
export function clickTag(row, unfolded, selected) {
  if (!row.parent) return { unfolded, selected: selected === row.key ? "" : row.key };
  const next = new Set(unfolded);
  if (row.unfolded) {
    next.delete(row.key);
    const closes = selected === row.key || isInside(selected, row.key);
    return { unfolded: next, selected: closes ? "" : selected };
  }
  next.add(row.key);
  return { unfolded: next, selected: row.key };
}

/** The favourite pages, by title. */
export function favoritePaths(pages) {
  return pages.filter((page) => page.favorite).map((page) => page.path).sort((a, b) => byText(titleOf(a), titleOf(b)) || byText(a, b));
}
