// A page's cover is one line in the page's properties (the `---` block at the top):
//
//   cover: attachments/leaf.png
//
// Obsidian shows that as an ordinary property and ignores it otherwise, and the picture itself
// is a normal file in the attachments folder. These functions read, set and remove that one
// line and leave every other byte of the block as it was. They have no editor code in them, so
// the tests can load them on their own.

// The same shape of path the image blocks accept (see blocks.js): inside attachments, a picture
// type the vault allows, nothing that could be read as a different path or markup.
const PICTURE_PATH = /^attachments\/[^\s()<>"\\]+\.(png|jpe?g|gif|webp)$/i;

/** True when `path` may be used as a cover. */
export function isCoverPath(path) {
  return typeof path === "string" && PICTURE_PATH.test(path) && !path.split("/").includes("..") && !path.includes("//");
}

// The lines of the block with their line endings, the position of the closing "---", and the
// "cover:" line if there is one. Returns null when the text is not a closed block.
function inspect(front) {
  const lines = front.split(/(?<=\n)/);
  if (lines.length < 2 || !/^---[ \t]*\r?\n?$/.test(lines[0])) return null;
  const close = lines.findIndex((line, i) => i > 0 && /^---[ \t]*\r?\n?$/.test(line));
  if (close === -1) return null;
  let found = null;
  for (let i = 1; i < close; i++) {
    const match = /^cover:[ \t]*(.*?)[ \t]*(\r?\n?)$/.exec(lines[i]);
    if (!match) continue;
    const next = lines[i + 1] !== undefined && i + 1 < close ? lines[i + 1] : "";
    // A value that goes on over several lines, or is a list, a map or a block, is not ours to edit.
    const simple = !/^[ \t]|^-([ \t]|$)/.test(next) && !/^[|>[{&*!]/.test(match[1]);
    const quoted = /^(["'])(.*)\1$/.exec(match[1]);
    found = { index: i, value: quoted ? quoted[2] : match[1], simple, ending: match[2] };
    break;
  }
  return { lines, close, found };
}

/** The cover path in a page's properties, or null when there is none or it is not usable. */
export function readCover(front) {
  const block = front && inspect(front);
  if (!block || !block.found || !block.found.simple) return null;
  return isCoverPath(block.found.value) ? block.found.value : null;
}

/**
 * The properties block with the cover set to `path`. Returns null when it cannot be done
 * without touching something else: a path that is not allowed, a block that is not closed, or
 * a cover line with a value that spreads over several lines.
 */
export function withCover(front, path) {
  if (!isCoverPath(path)) return null;
  if (front === "") return `---\ncover: ${path}\n---\n\n`;
  const block = inspect(front);
  if (!block) return null;
  const { lines, close, found } = block;
  const ending = front.includes("\r\n") ? "\r\n" : "\n";
  if (found) {
    if (!found.simple) return null;
    lines[found.index] = `cover: ${path}${found.ending || ending}`;
  } else {
    if (!/\n$/.test(lines[close - 1])) lines[close - 1] += ending;
    lines.splice(close, 0, `cover: ${path}${ending}`);
  }
  return lines.join("");
}

/** The properties block without a cover line. Returns null when the line cannot be removed safely. */
export function withoutCover(front) {
  if (!front) return front;
  const block = inspect(front);
  if (!block) return null;
  if (!block.found) return front;
  if (!block.found.simple) return null;
  block.lines.splice(block.found.index, 1);
  return block.lines.join("");
}
