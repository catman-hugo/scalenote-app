// What each page remembers on this device (0.5.8): the view it was left in (text, split or
// canvas) and whether its "Linked from" list is shown. These are ways of looking at a page, not
// its content, so they stay in this device's settings and never go into the page's file or
// another device. (A cover is content: it is written in the page itself, see covers.js.)
//
// Kept as `{ [path]: { view, linkedFrom, at } }`. `at` orders the entries, so when there are
// more than MAX_PAGES the ones not touched longest are dropped. No page or screen code in here,
// so the tests can load it on their own.

export const VIEWS = ["text", "split", "canvas"];
export const MAX_PAGES = 1000;

const isPath = (value) => typeof value === "string" && value.length > 0 && value.length <= 1024;

/** A clean copy of what the settings file holds; anything odd is left out. */
export function cleanPagePrefs(raw) {
  const out = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const [path, entry] of Object.entries(raw)) {
    if (!isPath(path) || !entry || typeof entry !== "object") continue;
    const clean = { at: Number.isFinite(entry.at) ? entry.at : 0 };
    if (VIEWS.includes(entry.view)) clean.view = entry.view;
    if (typeof entry.linkedFrom === "boolean") clean.linkedFrom = entry.linkedFrom;
    if (clean.view || clean.linkedFrom !== undefined) out[path] = clean;
  }
  return keepNewest(out);
}

/** What a page remembers, with `fallback` for anything it does not. */
export function prefsOf(prefs, path, fallback) {
  const entry = prefs[path] || {};
  return {
    view: entry.view || fallback.view,
    linkedFrom: entry.linkedFrom ?? fallback.linkedFrom,
  };
}

/** Prefs with `patch` remembered for `path`. `now` orders the entries. */
export function rememberPage(prefs, path, patch, now = Date.now()) {
  if (!isPath(path)) return prefs;
  const entry = { ...(prefs[path] || {}), at: now };
  if (VIEWS.includes(patch.view)) entry.view = patch.view;
  if (typeof patch.linkedFrom === "boolean") entry.linkedFrom = patch.linkedFrom;
  return keepNewest({ ...prefs, [path]: entry });
}

/**
 * Prefs after a page or folder moved from `from` to `to`. A folder move takes every page inside
 * it along. A page that is gone (deleted) can be dropped by passing `to` as null.
 */
export function movePages(prefs, from, to) {
  const out = {};
  for (const [path, entry] of Object.entries(prefs)) {
    const inside = path === from || path.startsWith(`${from}/`);
    if (!inside) out[path] = entry;
    else if (to !== null) out[to + path.slice(from.length)] = entry;
  }
  return out;
}

function keepNewest(prefs) {
  const paths = Object.keys(prefs);
  if (paths.length <= MAX_PAGES) return prefs;
  const keep = paths.sort((a, b) => prefs[b].at - prefs[a].at).slice(0, MAX_PAGES);
  return Object.fromEntries(keep.map((path) => [path, prefs[path]]));
}
