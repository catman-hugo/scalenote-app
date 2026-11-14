// The plain rules of finding a word in the text of a page. No page or library code in here, so
// the tests can load it on their own.
//
// Case is ignored. Some letters change length when they are made small (a capital dotted I
// becomes two characters), so the text is made small one character at a time and every character
// remembers where it came from; a hit is always reported in positions of the text as it was.

/** The most hits one search gives, so a word that is everywhere cannot use all the memory. */
export const FIND_LIMIT = 2000;

/** The text in small letters, and for each of its characters the index it came from. */
export function foldText(text) {
  let folded = "";
  const from = [];
  const source = String(text);
  for (let i = 0; i < source.length; i++) {
    const small = source[i].toLowerCase();
    for (let j = 0; j < small.length; j++) from.push(i);
    folded += small;
  }
  return { folded, from };
}

/**
 * Every place `needle` occurs in `text`, as `{ start, end }` (end is just after the last
 * character), in reading order and never overlapping, at most `limit`. A needle that is empty
 * after trimming finds nothing.
 */
export function findAll(text, needle, limit = FIND_LIMIT) {
  const word = String(needle || "").trim().toLowerCase();
  const out = [];
  if (!word) return out;
  const { folded, from } = foldText(text);
  let at = 0;
  while (out.length < limit) {
    const found = folded.indexOf(word, at);
    if (found === -1) break;
    const last = found + word.length - 1;
    out.push({ start: from[found], end: from[last] + 1 });
    at = found + word.length;
  }
  return out;
}

/**
 * Puts the hits of the text blocks and of the PDF blocks of a page into one list in reading
 * order. `text` is `[{ pos }]`, `pdf` is `[{ pos, count }]` (a block's place in the page and
 * how many hits it has). Returns `[{ kind: "text", index }]` and `[{ kind: "pdf", block, index }]`
 * where `index` counts inside its own source.
 */
export function orderHits(text, pdf) {
  const list = text.map((hit, index) => ({ kind: "text", index, pos: hit.pos, sub: 0 }));
  pdf.forEach((block, b) => {
    for (let index = 0; index < block.count; index++) list.push({ kind: "pdf", block: b, index, pos: block.pos, sub: index + 1 });
  });
  list.sort((a, b) => a.pos - b.pos || a.sub - b.sub);
  return list.map(({ pos, sub, ...rest }) => rest);
}
