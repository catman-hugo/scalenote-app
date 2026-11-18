// Blocks of a page that the find bar (pagefind.js) cannot read as text and that find their own
// hits: a PDF shown in the page (pdfblock.js) and a picture with words kept beside it or a
// description (imagefind.js). Each one registers here while it is on screen.
//
// A finder is `{ dom, pos(), search(word) -> count or null, reveal(k), target?() }`:
// `pos()` is its place in the page (for reading order), `search` finds and marks the hits,
// `reveal(k)` makes hit k the current one (-1: none) and `target()` is the element to scroll to.

const finders = new Set();

export const addFinder = (finder) => finders.add(finder);
export const removeFinder = (finder) => finders.delete(finder);
export const allFinders = () => [...finders];
