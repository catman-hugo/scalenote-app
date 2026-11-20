// The cover of a page: a picture above the text, shown on the pages that have one (0.5.8: set per
// page, from the page's View menu or by right-clicking it in the list; there is no setting for
// all pages any more). This file only draws it and reports the buttons; main.js does the work,
// and coverrules.js writes the one line in the page's properties.
//
// A page without a cover shows nothing here: no empty area, no "Add cover" button.

import { strings } from "./strings.js";

function make(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function textButton(text, onClick) {
  const button = make("button", "link-button", text);
  button.type = "button";
  button.addEventListener("click", onClick);
  return button;
}

/**
 * Creates the cover area as the first thing inside `host` (the scrolling page area).
 * `loadImage(path)` gives a picture as a data: address. `onChange` and `onRemove` are
 * called by the buttons. Returns { show(path), hide() }: `path` is the cover's path or null.
 */
export function createCover(host, { loadImage, onChange, onRemove }) {
  // The area exists only while a cover is on screen.
  let section = null;
  const area = () => {
    if (!section) {
      section = make("section", "cover");
      section.setAttribute("aria-label", strings.cover.label);
      host.prepend(section);
    }
    return section;
  };
  // Lets a slow picture for a page that is no longer open be dropped.
  let run = 0;

  const actions = (buttons) => {
    const row = make("div", "cover-actions");
    row.append(...buttons);
    return row;
  };

  return {
    hide() {
      run++;
      if (section) section.remove();
      section = null;
    },

    show(path) {
      if (!path) {
        this.hide();
        return;
      }
      const mine = ++run;
      const box = area();
      const frame = make("div", "cover-image");
      const picture = make("img");
      picture.alt = strings.cover.alt;
      frame.append(picture);
      const note = make("p", "cover-note");
      box.replaceChildren(frame, note, actions([textButton(strings.cover.change, onChange), textButton(strings.cover.remove, onRemove)]));
      loadImage(path).then(
        (source) => {
          if (mine === run) picture.src = source;
        },
        () => {
          if (mine !== run) return;
          frame.hidden = true;
          note.textContent = strings.cover.missing;
        },
      );
    },
  };
}
