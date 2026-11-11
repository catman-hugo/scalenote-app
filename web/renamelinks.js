// Updating the links to a page when the page is renamed. Only the rules are here (which links
// are rewritten and how); main.js reads and writes the pages. No editor code, so tests can load it.
//
// A link is rewritten only if it pointed at the renamed page before the rename, found with the
// same matching rules the app uses to follow links (wikilinkrules.js). Only the page name inside
// the brackets changes: the heading or block part, the shown text, a leading "!" and every
// other character of the page are kept as they were.

import { createResolver, findWikilinks, linkNameFor } from "./wikilinkrules.js";

/**
 * Returns the text with the links to `oldPath` pointed at `newPath`, or `null` when nothing in it
 * links there. `pages` are all page paths before the rename, `from` is the path of the page that
 * holds `text` before the rename, and `fromAfter` its path after it (the renamed page itself is
 * the only one whose path changes).
 */
export function rewriteLinks(text, { pages, oldPath, newPath, from, fromAfter = from }) {
  const before = createResolver(pages);
  const after = createResolver(pages.map((path) => (path === oldPath ? newPath : path)));
  const edits = [];
  for (const link of findWikilinks(text)) {
    if (!link.page || before.resolve(link.page, from) !== oldPath) continue;
    const inner = text.slice(link.start + 2, link.end - 2);
    const at = inner.indexOf(link.page);
    if (at === -1) continue;
    // A link written with folders keeps writing folders; a short name stays short while it still
    // means this page. A link that was written with ".md" keeps it.
    const stem = newPath.replace(/\.md$/i, "");
    let name = link.page.includes("/") ? stem : linkNameFor(newPath, fromAfter, after);
    if (/\.md$/i.test(link.page)) name += ".md";
    if (name === link.page) continue;
    edits.push({ start: link.start + 2 + at, end: link.start + 2 + at + link.page.length, name });
  }
  if (!edits.length) return null;
  let out = text;
  for (const { start, end, name } of edits.reverse()) out = out.slice(0, start) + name + out.slice(end);
  return out;
}
