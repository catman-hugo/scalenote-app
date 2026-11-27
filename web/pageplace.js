// Where a page was left: going to another page and back puts the page at the same height again.
//
// Why a block and not a number of pixels: a page with PDF pages as pictures grows while the
// pictures load, so a scroll position in pixels points somewhere else a moment later. The place
// is kept as "this block of the text, this far from the top of the window", and put back again
// each time a picture above it finishes loading, until the person scrolls or types themselves.
// Kept for as long as the app is open, like folded toggles; nothing is written to the page.

/**
 * The place to remember: the first block that is still (partly) on screen, and how far its top
 * is from the top of the scrolling box (negative when it starts above it). `tops` and `bottoms`
 * are the blocks' edges and `viewTop` the box's top, all in the same screen pixels. Null when
 * there are no blocks.
 */
export function placeOf(tops, bottoms, viewTop) {
  if (!tops.length) return null;
  let block = tops.findIndex((top, i) => bottoms[i] > viewTop);
  if (block < 0) block = tops.length - 1;
  return { block, offset: Math.round(tops[block] - viewTop) };
}

/**
 * The scroll position that puts a remembered place back: `place` from `placeOf`, `tops` the
 * blocks' tops now, `viewTop` the box's top and `scrollTop` its scroll position now. A block that
 * is gone (the page got shorter) gives the last block. Null when there are no blocks.
 */
export function scrollFor(place, tops, viewTop, scrollTop) {
  if (!place || !tops.length) return null;
  const block = Math.min(Math.max(0, place.block), tops.length - 1);
  return Math.max(0, Math.round(scrollTop + (tops[block] - viewTop) - place.offset));
}
