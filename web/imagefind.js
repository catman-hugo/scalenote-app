// Lets the page's find bar (pagefind.js) find words in a picture: the words of an imported PDF
// page (kept beside the picture, see imagetext.js) and the picture's description under it.
//
// Hits in the picture are drawn as boxes over the found letters. Hits in the description are
// drawn behind its text: the description is an input box, which cannot hold marks, so a copy of
// its text with the marks sits under the (transparent) box and lines up with it letter by letter.
// Nothing here changes the page; marks are never saved.

import { findAll } from "./findrules.js";
import { addFinder, removeFinder } from "./finders.js";
import { decodePageText, hitsOnPicture, LIMITS } from "./imagetext.js";

// The words of a picture are read once per picture path; they do not change after an import.
const MAX_KEPT = 300;
const kept = new Map();

function wordsOf(path, load) {
  if (!kept.has(path)) {
    if (kept.size >= MAX_KEPT) kept.delete(kept.keys().next().value);
    kept.set(path, Promise.resolve().then(() => load(path)).then(decodePageText, () => []));
  }
  return kept.get(path);
}

// Widths of letters in an ordinary font: close to most PDF fonts, much closer than taking every
// letter as equally wide (an "i" is far narrower than an "m").
let ruler = null;
function measure(text) {
  if (!ruler) {
    ruler = document.createElement("canvas").getContext("2d");
    if (ruler) ruler.font = "100px Helvetica, Arial, sans-serif";
  }
  return ruler ? ruler.measureText(text).width : text.length;
}

function make(tag, className) {
  const node = document.createElement(tag);
  node.className = className;
  return node;
}

const percent = (n) => `${(n * 100).toFixed(3)}%`;

/**
 * Registers a finder for one picture block. `sizer` is the box exactly around the picture,
 * `alt` the description input, `attrs()` the block's current `{ alt, path }`, `pos()` its place
 * in the page, `load(path)` resolves to the kept words' file text (or fails when there is none).
 * Returns `{ destroy }`.
 */
export function attachImageFinder({ dom, sizer, alt, attrs, pos, load }) {
  const layer = make("div", "image-find-layer");
  layer.setAttribute("aria-hidden", "true");
  sizer.append(layer);
  const mirror = make("div", "image-alt-marks");
  mirror.setAttribute("aria-hidden", "true");
  alt.before(mirror);
  // The copy must take the input's exact text layout to line up with it.
  const copyLayout = () => {
    const style = getComputedStyle(alt);
    for (const name of ["font", "letterSpacing", "paddingLeft", "paddingRight", "paddingTop", "paddingBottom", "borderLeftWidth", "borderTopWidth"]) mirror.style[name] = style[name];
    mirror.style.left = `${alt.offsetLeft}px`;
    mirror.style.top = `${alt.offsetTop}px`;
    mirror.style.width = `${alt.offsetWidth}px`;
    mirror.style.height = `${alt.offsetHeight}px`;
  };

  let hits = [];
  let current = -1;
  let word = "";
  let token = 0;
  let target = null;

  function paint() {
    target = null;
    const boxes = [];
    hits.forEach((hit, k) => {
      if (hit.kind !== "picture") return;
      const box = make("span", k === current ? "image-find-hit find-hit-current" : "image-find-hit");
      Object.assign(box.style, { left: percent(hit.x), top: percent(hit.y), width: percent(hit.w), height: percent(hit.h) });
      if (k === current) target = box;
      boxes.push(box);
    });
    layer.replaceChildren(...boxes);
    const text = alt.value;
    const parts = [];
    let at = 0;
    hits.forEach((hit, k) => {
      if (hit.kind !== "caption" || hit.start < at || hit.end > text.length) return;
      if (hit.start > at) parts.push(document.createTextNode(text.slice(at, hit.start)));
      const mark = make("span", k === current ? "find-hit find-hit-current" : "find-hit");
      mark.textContent = text.slice(hit.start, hit.end);
      if (k === current) target = alt;
      parts.push(mark);
      at = hit.end;
    });
    const any = parts.length > 0;
    if (any && at < text.length) parts.push(document.createTextNode(text.slice(at)));
    mirror.replaceChildren(...parts);
    mirror.hidden = !any;
    alt.classList.toggle("has-find-marks", any);
    if (any) {
      copyLayout();
      mirror.scrollLeft = alt.scrollLeft;
    }
  }

  const finder = {
    dom,
    pos,
    target: () => target,
    async search(text) {
      const mine = ++token;
      word = String(text || "");
      current = -1;
      if (!word.trim()) {
        hits = [];
        paint();
        return 0;
      }
      const { path, alt: description } = attrs();
      const words = await wordsOf(path, load);
      if (mine !== token) return null;
      const inPicture = hitsOnPicture(words, word, LIMITS.hits, measure).map((box) => ({ kind: "picture", ...box }));
      const inCaption = findAll(description || "", word, LIMITS.hits).map((hit) => ({ kind: "caption", ...hit }));
      // Reading order: the picture first, then the description under it.
      hits = [...inPicture, ...inCaption].slice(0, LIMITS.hits);
      paint();
      return hits.length;
    },
    reveal(k) {
      current = k >= 0 && k < hits.length ? k : -1;
      paint();
    },
  };
  addFinder(finder);
  // Typing in the description moves its marks out of line, so they are hidden until the next
  // search (the hits stay counted, so the find bar's numbers do not jump).
  const clear = () => {
    mirror.hidden = true;
    alt.classList.remove("has-find-marks");
  };
  alt.addEventListener("input", clear);
  alt.addEventListener("scroll", () => {
    mirror.scrollLeft = alt.scrollLeft;
  });
  return {
    destroy() {
      token++;
      removeFinder(finder);
      alt.removeEventListener("input", clear);
    },
  };
}
