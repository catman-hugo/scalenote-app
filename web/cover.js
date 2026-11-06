// The cover of a page: a picture above the text, shown only when covers are switched on in
// Settings. This file only draws it and reports the buttons; main.js does the work, and
// coverrules.js writes the one line in the page's properties.
//
// When covers are off nothing is drawn at all: no picture, no "Add cover" button.

import { icon } from "./icons.js";
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
 * `loadImage(path)` gives a picture as a data: address. `onAdd`, `onChange` and `onRemove` are
 * called by the buttons. Returns { show(path), hide() }: `path` is the cover's path or null.
 */
export function createCover(host, { loadImage, onAdd, onChange, onRemove }) {
  // The area exists only while a cover (or the Add cover button) is on screen.
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
      const mine = ++run;
      const box = area();
      if (!path) {
        const add = textButton(strings.cover.add, onAdd);
        add.prepend(icon("image"));
        box.replaceChildren(actions([add]));
        return;
      }
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
