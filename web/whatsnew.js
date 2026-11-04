// Shows release notes. The notes may come from the internet (the update notice), so they are
// only ever put on the page as text: this builds a few plain elements and never uses html.

// The notes are markdown, but only plain text is shown, so code and bold marks are dropped.
const plain = (text) => text.replace(/`/g, "").replace(/\*\*/g, "");

function make(tag, text) {
  const node = document.createElement(tag);
  node.textContent = plain(text);
  return node;
}

/** Fills `container` with a plain-text view of simple markdown: headings, bullet lists, paragraphs. */
export function renderNotes(container, markdown) {
  container.replaceChildren();
  let list = null;
  for (const raw of String(markdown || "").replace(/\r/g, "").split("\n")) {
    const line = raw.trimEnd();
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    const bullet = /^\s*[-*]\s+(.*)$/.exec(line);
    if (bullet) {
      if (!list) {
        list = document.createElement("ul");
        container.append(list);
      }
      list.append(make("li", bullet[1]));
      continue;
    }
    list = null;
    if (heading) container.append(make(heading[1].length === 1 ? "h3" : "h4", heading[2]));
    else if (line.trim() !== "") container.append(make("p", line.trim()));
  }
}
