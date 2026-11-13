// Shows release notes. The notes may come from the internet (the update notice), so they are
// only ever put on the page as text: this builds a few plain elements and never uses html.

// The notes are markdown, but only plain text is shown, so marks for code, bold, italics and
// links are dropped (a link keeps its words).
const plain = (text) =>
  text
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/`/g, "")
    .replace(/\*\*/g, "")
    .replace(/(^|[^\w*])\*([^*\s][^*]*?)\*(?=[^\w*]|$)/g, "$1$2");

function make(tag, text) {
  const node = document.createElement(tag);
  node.textContent = plain(text);
  return node;
}

// A bullet indented by two spaces or more is a sub-point of the one above it. Deeper levels are
// shown at the second level, which is enough for release notes.
const indentOf = (line) => /^\s*/.exec(line)[0].replace(/\t/g, "  ").length;

/**
 * Fills `container` with a plain-text view of simple markdown: headings, bullet lists with one
 * level of sub-points, paragraphs. An indented line under a bullet continues that bullet.
 */
export function renderNotes(container, markdown) {
  container.replaceChildren();
  let list = null; // the top-level list being filled
  let sub = null; // the sub-list under the last bullet
  let last = null; // the last bullet, top level or sub
  for (const raw of String(markdown || "").replace(/\r/g, "").split("\n")) {
    const line = raw.trimEnd();
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    const bullet = /^\s*[-*]\s+(.*)$/.exec(line);
    if (bullet) {
      const item = make("li", bullet[1]);
      if (list && indentOf(line) >= 2) {
        const parent = list.lastElementChild;
        if (!sub && parent) {
          sub = document.createElement("ul");
          parent.append(sub);
        }
        (sub || list).append(item);
      } else {
        if (!list) {
          list = document.createElement("ul");
          container.append(list);
        }
        list.append(item);
        sub = null;
      }
      last = item;
      continue;
    }
    if (last && line.trim() !== "" && indentOf(line) >= 2 && !heading) {
      // A continuation line: more words for the bullet above.
      last.firstChild.textContent += " " + plain(line.trim());
      continue;
    }
    list = null;
    sub = null;
    last = null;
    if (heading) container.append(make(heading[1].length === 1 ? "h3" : "h4", heading[2]));
    else if (line.trim() !== "") container.append(make("p", line.trim()));
  }
}
