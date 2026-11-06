// The rules for [[wikilinks]], in the form Obsidian uses: [[Page]], [[Page|shown text]],
// [[Page#Heading]] and [[Page#^block-id]].
//
// These are written a second time in src-tauri/core/src/links.rs (the backlinks search). Both
// are tested against tests/fixtures/wikilinks.txt so they cannot drift apart. This file has no
// editor code in it, so the tests can load it on its own.

const MAX_INNER = 300;
const MAX_LINKS = 5000;

/**
 * Splits the text between the brackets. Returns { page, anchor, alias } (anchor and alias are
 * null when absent), or null when there is nothing to point at.
 */
export function parseInner(inner) {
  let target = inner;
  let alias = null;
  const bar = inner.indexOf("|");
  if (bar !== -1) {
    // In a table cell the bar is written "\|"; the backslash is not part of the name.
    target = inner.slice(0, bar).replace(/\\+$/, "");
    alias = inner.slice(bar + 1).trim();
  }
  let page = target;
  let anchor = null;
  const hash = target.indexOf("#");
  if (hash !== -1) {
    page = target.slice(0, hash);
    anchor = target.slice(hash + 1).trim();
  }
  page = page.trim();
  if (!anchor) anchor = null;
  if (!page && !anchor) return null;
  return { page, anchor, alias: alias || null };
}

// A run of backticks closed by a run of the same length is a code span; an unclosed run is text.
function skipCodeSpan(line, from) {
  let run = 0;
  while (line[from + run] === "`") run++;
  let i = from + run;
  while (i < line.length) {
    if (line[i] === "`") {
      let closing = 0;
      while (line[i + closing] === "`") closing++;
      if (closing === run) return i + closing;
      i += closing;
    } else i++;
  }
  return from + run;
}

/**
 * Reads the link that starts at `at` (where "[[" is), or returns null. Looks no further than
 * the longest allowed link, so reading many links in a long text stays fast. (The limit counts
 * bytes in the Rust code and letters here; it only differs for names near 300 long.)
 */
export function readLinkAt(text, at) {
  const limit = Math.min(text.length, at + 2 + MAX_INNER + 1);
  let i = at + 2;
  while (i < limit && text[i] !== "[" && text[i] !== "]" && text[i] !== "\n" && text[i] !== "\r") i++;
  if (i === at + 2 || i - (at + 2) > MAX_INNER || text[i] !== "]" || text[i + 1] !== "]") return null;
  const parsed = parseInner(text.slice(at + 2, i));
  return parsed ? { ...parsed, end: i + 2 } : null;
}

function scanLine(line, offset, links) {
  let i = 0;
  while (i < line.length && links.length < MAX_LINKS) {
    const letter = line[i];
    if (letter === "\\") i += 2; // an escaped bracket is text
    else if (letter === "`") i = skipCodeSpan(line, i);
    else if (letter === "[" && line[i + 1] === "[") {
      const link = readLinkAt(line, i);
      if (link) {
        links.push({ page: link.page, anchor: link.anchor, alias: link.alias, embed: i > 0 && line[i - 1] === "!", start: offset + i, end: offset + link.end });
        i = link.end;
      } else i++;
    } else i++;
  }
}

/**
 * All links in a text, in order, with their positions. Links in fenced code and in code spans
 * are not links, and a "[[" without its "]]" on the same line is plain text.
 */
export function findWikilinks(text) {
  const links = [];
  let fence = null;
  let offset = 0;
  while (offset < text.length && links.length < MAX_LINKS) {
    const newline = text.indexOf("\n", offset);
    const line = text.slice(offset, newline === -1 ? text.length : newline + 1);
    const indent = line.length - line.replace(/^ +/, "").length;
    const rest = line.slice(indent);
    const marker = indent > 3 ? null : rest.startsWith("```") ? "`" : rest.startsWith("~~~") ? "~" : null;
    if (fence === null && marker) fence = marker;
    else if (fence !== null && marker === fence) fence = null;
    else if (fence === null) scanLine(line, offset, links);
    offset += line.length;
  }
  return links;
}

const withoutExtension = (name) => (/\.md$/i.test(name) && name.length > 3 ? name.slice(0, -3) : name);
const parentOf = (path) => path.slice(0, Math.max(0, path.lastIndexOf("/")));

/**
 * Works out which page a link means, the way Obsidian does: names are matched without regard to
 * case and without ".md"; a name with folders in it must match the end of the path; when several
 * pages fit, the one in the same folder as the page holding the link wins, then the one with the
 * fewest folders, then the first in alphabetical order.
 */
export function createResolver(pages) {
  const byName = new Map();
  for (const path of pages) {
    const key = withoutExtension(path).toLowerCase();
    const name = key.slice(key.lastIndexOf("/") + 1);
    if (!byName.has(name)) byName.set(name, []);
    byName.get(name).push(path);
  }
  const known = new Set(pages);
  const depth = (path) => path.split("/").length - 1;
  return {
    /** `page` is the page part of a link, `from` the path of the page holding it. */
    resolve(page, from) {
      const wanted = withoutExtension(page.trim().replace(/^\/+/, "")).toLowerCase();
      if (!wanted) return known.has(from) ? from : null;
      const name = wanted.slice(wanted.lastIndexOf("/") + 1);
      const fits = (byName.get(name) || []).filter((path) => {
        const key = withoutExtension(path).toLowerCase();
        return key === wanted || key.endsWith(`/${wanted}`);
      });
      const home = parentOf(from);
      fits.sort((a, b) => (parentOf(a) !== home) - (parentOf(b) !== home) || depth(a) - depth(b) || (a < b ? -1 : a > b ? 1 : 0));
      return fits[0] || null;
    },
  };
}

/**
 * The text with every plain link ([[..]], not an embed) replaced by a letter and a space. blocks.js
 * checks what is left. A letter and a space, not nothing, so that "<[[a]]>" does not turn into a harmless "<>".
 */
export function withoutWikilinks(text) {
  let out = "";
  let at = 0;
  for (const link of findWikilinks(text)) {
    if (link.embed) continue;
    out += `${text.slice(at, link.start)}x `;
    at = link.end;
  }
  return out + text.slice(at);
}

/** True when the text has at least one link or embed. */
export function hasWikilinks(text) {
  return text.includes("[[") && findWikilinks(text).length > 0;
}

/** The links of a text as simple strings, to compare before and after the editor rewrote a block. */
export function wikilinkSignature(text) {
  return findWikilinks(text).map((l) => `${l.embed ? "!" : ""}${l.page}#${l.anchor ?? ""}|${l.alias ?? ""}`);
}

export function sameWikilinks(a, b) {
  const x = wikilinkSignature(a);
  const y = wikilinkSignature(b);
  return x.length === y.length && x.every((item, i) => item === y[i]);
}

/** The name to write in a new link: the short name when it is unambiguous, else the path. */
export function linkNameFor(path, from, resolver) {
  const stem = withoutExtension(path);
  const short = stem.slice(stem.lastIndexOf("/") + 1);
  return resolver.resolve(short, from) === path ? short : stem;
}

/** The text shown for a link in the page. */
export function linkLabel({ page, anchor, alias }) {
  if (alias) return alias;
  const name = page.slice(page.lastIndexOf("/") + 1).replace(/\.md$/i, "");
  return anchor ? (name ? `${name} › ${anchor}` : anchor) : name;
}
