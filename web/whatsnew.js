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

// A release notes file holds two lists. The full notes are shown on GitHub, and in the app on a
// computer after an update downloaded with the app's own Download button. The short list (a few
// words per change) sits at the end inside an HTML comment that starts with "<!-- In the app",
// which GitHub does not show; it is shown everywhere else. No other comment is ever shown.
const IN_APP = /<!--\s*In the app[^\n]*\n([\s\S]*?)-->/i;

/** The full notes (`kind` "full") or the short list ("short", the full notes when there is none). */
export function appNotes(markdown, kind) {
  const text = String(markdown || "");
  const short = IN_APP.exec(text);
  if (short && kind === "short") return short[1];
  return text.replace(/<!--[\s\S]*?-->/g, "");
}

// A release note line can start with the systems it is about, such as "Android:" or
// "Linux and Windows:". "Computers" means every system that is not Android (the browser too).
// Older versions of the app simply show the words, which still read well, and so does GitHub.
const SYSTEMS = { android: ["android"], windows: ["windows"], linux: ["linux"], computers: ["windows", "linux", "other"] };
const FOR_SYSTEMS = /^(\s*[-*]\s+)((?:android|windows|linux|computers)(?:(?:\s*,\s*|\s+and\s+)(?:android|windows|linux|computers))*):\s*(.*)$/i;

/**
 * The notes as they matter on `platform` ("android", "windows", "linux" or "other", see
 * updates.js): lines for other systems are left out (with any sub-points or continuation lines
 * under them), the system words are taken off the lines that stay, and a heading left with
 * nothing under it goes too.
 */
export function notesFor(markdown, platform) {
  const kept = [];
  let skipping = false;
  for (const line of String(markdown || "").replace(/\r/g, "").split("\n")) {
    const marked = FOR_SYSTEMS.exec(line);
    if (marked) {
      const names = marked[2].toLowerCase().split(/\s*,\s*|\s+and\s+/);
      skipping = !names.some((name) => SYSTEMS[name].includes(platform));
      if (!skipping) kept.push(marked[1] + marked[3].charAt(0).toUpperCase() + marked[3].slice(1));
      continue;
    }
    // Indented lines belong to the bullet above them.
    if (skipping && line.trim() !== "" && indentOf(line) >= 2) continue;
    skipping = false;
    kept.push(line);
  }
  // Blank lines left where a part was taken out are folded into one.
  const text = dropEmptyHeadings(kept).join("\n").replace(/\n{3,}/g, "\n\n").replace(/\n+$/, "\n");
  return text.trim() === "" ? "" : text;
}

function dropEmptyHeadings(lines) {
  const isHeading = (line) => /^#{1,6}\s/.test(line);
  return lines.filter((line, at) => {
    if (!isHeading(line)) return true;
    for (const next of lines.slice(at + 1)) {
      if (isHeading(next)) return false;
      if (next.trim() !== "") return true;
    }
    return false;
  });
}

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
