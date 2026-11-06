// Reading, setting and removing one single-line property in a page's properties (the `---`
// block at the top), for example `cover: attachments/leaf.png` or `favorite: true`. Every other
// byte of the block stays as it was. They have no editor code in them, so the tests can load
// them on their own.

const FENCE = /^---[ \t]*\r?\n?$/;
const escapeKey = (key) => key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// The lines of the block with their line endings, the position of the closing "---", and the
// line of `key` if there is one. Returns null when the text is not a closed block.
function inspect(front, key) {
  const lines = front.split(/(?<=\n)/);
  if (lines.length < 2 || !FENCE.test(lines[0])) return null;
  const close = lines.findIndex((line, i) => i > 0 && FENCE.test(line));
  if (close === -1) return null;
  const pattern = new RegExp(`^${escapeKey(key)}:[ \\t]*(.*?)[ \\t]*(\\r?\\n?)$`);
  let found = null;
  for (let i = 1; i < close; i++) {
    const match = pattern.exec(lines[i]);
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

/**
 * The value of `key` in a page's properties, without quotes. Returns null when there is no such
 * line, or when its value is not a plain one-line value.
 */
export function readProperty(front, key) {
  const block = front && inspect(front, key);
  return block && block.found && block.found.simple ? block.found.value : null;
}

/**
 * The properties block with `key` set to `value`. `front` may be empty (the page has no block
 * yet). Returns null when it cannot be done without touching something else: a block that is
 * not closed, or a line for `key` with a value that spreads over several lines. The caller
 * makes sure `value` is safe to write on one line.
 */
export function withProperty(front, key, value) {
  if (front === "") return `---\n${key}: ${value}\n---\n\n`;
  const block = inspect(front, key);
  if (!block) return null;
  const { lines, close, found } = block;
  const ending = front.includes("\r\n") ? "\r\n" : "\n";
  if (found) {
    if (!found.simple) return null;
    lines[found.index] = `${key}: ${value}${found.ending || ending}`;
  } else {
    if (!/\n$/.test(lines[close - 1])) lines[close - 1] += ending;
    lines.splice(close, 0, `${key}: ${value}${ending}`);
  }
  return lines.join("");
}

/** The properties block without the line for `key`. Returns null when the line cannot be removed safely. */
export function withoutProperty(front, key) {
  if (!front) return front;
  const block = inspect(front, key);
  if (!block) return null;
  if (!block.found) return front;
  if (!block.found.simple) return null;
  block.lines.splice(block.found.index, 1);
  return block.lines.join("");
}

/** True when the page is marked as a favourite: `favorite: true`. */
export function readFavorite(front) {
  const value = readProperty(front, "favorite");
  return value !== null && value.toLowerCase() === "true";
}

/** The properties block with the favourite mark set or removed. Returns null when it cannot be done safely. */
export function withFavorite(front, on) {
  return on ? withProperty(front, "favorite", "true") : withoutProperty(front, "favorite");
}
