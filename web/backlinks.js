// The "Linked from" list under a page: the other pages that have a [[link]] to this one.
// The list is found by the backend (see Vault::backlinks in links.rs); this file only draws it.

import { strings } from "./strings.js";

function make(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/**
 * Creates the list inside `host` (after the page text). `open(path)` opens a page, `hide()` is called when the person hides the list.
 * Returns { clear, show(result), fail }.
 */
export function createBacklinks(host, { open, hide }) {
  const section = make("section", "backlinks");
  section.setAttribute("aria-label", strings.backlinks.heading);
  section.hidden = true;
  host.append(section);

  // The title row, with the Hide button at its end.
  const header = (extra) => {
    const row = make("div", "backlinks-head");
    const title = make("h2", "backlinks-title", strings.backlinks.heading);
    if (extra) title.append(extra);
    const button = make("button", "link-button", strings.backlinks.hide);
    button.type = "button";
    button.title = strings.backlinks.hideLabel;
    button.addEventListener("click", hide);
    row.append(title, button);
    return row;
  };

  const draw = (children) => {
    section.replaceChildren(...children);
    section.hidden = false;
  };

  return {
    clear() {
      section.replaceChildren();
      section.hidden = true;
    },

    fail() {
      draw([header(), make("p", "backlinks-note", strings.backlinks.failed)]);
    },

    show({ items, truncated }) {
      const title = header(items.length ? make("span", "backlinks-count", String(items.length)) : null);
      if (!items.length) return draw([title, make("p", "backlinks-note", strings.backlinks.none)]);
      const list = make("ul", "backlinks-list");
      for (const item of items) {
        const row = make("li");
        const button = make("button", "backlink");
        button.type = "button";
        const head = make("span", "backlink-head");
        head.append(make("span", "backlink-title", item.title));
        // How many links the page has to this one, when more than one.
        if (item.count > 1) head.append(make("span", "backlink-count", String(item.count)));
        button.append(head);
        const line = make("span", "backlink-snippet");
        // The piece of the line with the link in it is marked, as in the search box.
        for (const [text, marked] of item.snippet) line.append(marked ? make("mark", "", text) : document.createTextNode(text));
        button.append(line);
        button.addEventListener("click", () => open(item.path));
        row.append(button);
        list.append(row);
      }
      const children = [title, list];
      if (truncated) children.push(make("p", "backlinks-note", strings.backlinks.tooMany.replace("{count}", String(items.length))));
      draw(children);
    },
  };
}
