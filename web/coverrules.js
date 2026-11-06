// A page's cover is one line in the page's properties (the `---` block at the top):
//
//   cover: attachments/leaf.png
//
// Obsidian shows that as an ordinary property and ignores it otherwise, and the picture itself
// is a normal file in the attachments folder. These functions read, set and remove that one
// line and leave every other byte of the block as it was (see propertyrules.js). They have no
// editor code in them, so the tests can load them on their own.

import { readProperty, withProperty, withoutProperty } from "./propertyrules.js";

// The same shape of path the image blocks accept (see blocks.js): inside attachments, a picture
// type the vault allows, nothing that could be read as a different path or markup.
const PICTURE_PATH = /^attachments\/[^\s()<>"\\]+\.(png|jpe?g|gif|webp)$/i;

/** True when `path` may be used as a cover. */
export function isCoverPath(path) {
  return typeof path === "string" && PICTURE_PATH.test(path) && !path.split("/").includes("..") && !path.includes("//");
}

/** The cover path in a page's properties, or null when there is none or it is not usable. */
export function readCover(front) {
  const value = readProperty(front, "cover");
  return isCoverPath(value) ? value : null;
}

/**
 * The properties block with the cover set to `path`. Returns null when it cannot be done
 * without touching something else: a path that is not allowed, a block that is not closed, or
 * a cover line with a value that spreads over several lines.
 */
export function withCover(front, path) {
  return isCoverPath(path) ? withProperty(front, "cover", path) : null;
}

/** The properties block without a cover line. Returns null when the line cannot be removed safely. */
export function withoutCover(front) {
  return withoutProperty(front, "cover");
}
