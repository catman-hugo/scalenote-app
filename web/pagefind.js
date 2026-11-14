// The find bar of a page (Ctrl+F): one word, looked for in all the text of the page and in the
// PDFs shown in it, with the hits counted and visited in the order they appear on the page.
//
// Text hits are marked by findmarks.js, PDF hits by the PDF blocks themselves (pdfblock.js); this
// file only asks both for their hits, joins them in reading order and moves from one to the next.
// Nothing here changes the page: finding is never saved and never undone. A hit inside a folded
// toggle opens that toggle, because there is nothing to see in a folded one.

import { FIND_LIMIT, orderHits } from "./findrules.js";
import { collectHits, setFindMarks } from "./findmarks.js";
import { flipFold, isFoldedAt } from "./togglefold.js";
import { pdfFinders } from "./pdfblock.js";
import { icon } from "./icons.js";
import { strings } from "./strings.js";

function make(tag, className) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  return node;
}

function iconButton(label, iconName, onClick) {
  const button = make("button", "icon-button");
  button.type = "button";
  button.title = label;
  button.setAttribute("aria-label", label);
  button.append(icon(iconName));
  button.addEventListener("click", onClick);
  return button;
}

const fill = (text, values) => text.replace(/\{(\w+)\}/g, (_, name) => String(values[name] ?? ""));

/**
 * `editor()` gives the page's editor (or null), `after` is the element the bar goes after (the
 * top bar). Returns `{ open(prefill), close(), refresh(), get isOpen }`.
 */
export function createPageFind({ editor, after, onClose = () => {} }) {
  const t = strings.find;
  const bar = make("div", "find-bar");
  bar.setAttribute("role", "search");
  bar.hidden = true;
  const input = make("input", "find-input");
  input.type = "search";
  input.maxLength = 200;
  input.placeholder = t.placeholder;
  input.setAttribute("aria-label", t.placeholder);
  input.autocomplete = "off";
  input.spellcheck = false;
  const status = make("span", "find-status");
  status.setAttribute("role", "status");
  const previous = iconButton(t.previous, "chevronUp", () => step(-1));
  const next = iconButton(t.next, "chevronDown", () => step(1));
  const close = iconButton(t.close, "close", () => closeBar());
  bar.append(input, previous, next, status, close);
  after.after(bar);

  // The hits in reading order; `at` is the one on show. `token` drops the answer of a search
  // that a newer one has replaced.
  const state = { open: false, token: 0, order: [], text: [], pdf: [], at: -1, capped: false, timer: 0 };

  function showStatus(searching) {
    if (!input.value.trim()) status.textContent = "";
    else if (searching) status.textContent = t.searching;
    else if (!state.order.length) status.textContent = t.none;
    else status.textContent = fill(state.capped ? t.many : t.count, { current: state.at + 1, total: state.order.length });
  }

  // Opens the toggle that holds the place `pos`, if it is folded.
  function unfold(ed, pos) {
    const $pos = ed.state.doc.resolve(Math.min(pos, ed.state.doc.content.size));
    if ($pos.depth >= 1 && $pos.node(1).type.name === "toggle") {
      const start = $pos.before(1);
      if (isFoldedAt(ed.state, start)) flipFold(ed.view, start);
    }
  }

  function clearPdf() {
    for (const block of state.pdf) block.finder.reveal(-1);
  }

  // Makes the hit `index` of the list the one on show and scrolls to it.
  function show(index, { scroll = true } = {}) {
    const ed = editor();
    if (!ed || !state.order.length) return;
    state.at = ((index % state.order.length) + state.order.length) % state.order.length;
    const hit = state.order[state.at];
    clearPdf();
    if (hit.kind === "text") {
      const place = state.text[hit.index];
      unfold(ed, place.from);
      setFindMarks(ed, state.text, hit.index);
      const mark = ed.view.dom.querySelector(".find-hit-current");
      if (mark && scroll) mark.scrollIntoView({ block: "center", inline: "nearest" });
    } else {
      const block = state.pdf[hit.block];
      setFindMarks(ed, state.text, -1);
      unfold(ed, block.pos);
      block.finder.reveal(hit.index);
      if (scroll) block.finder.dom.scrollIntoView({ block: "center", inline: "nearest" });
    }
    showStatus(false);
  }

  function step(by) {
    if (state.order.length) show(state.at < 0 ? (by > 0 ? 0 : -1) : state.at + by);
  }

  // Looks for the word again in the text and in every PDF. `keep` keeps the place in the list
  // (after an edit) instead of going to the first hit.
  async function search({ keep = false } = {}) {
    const ed = editor();
    const token = ++state.token;
    const word = input.value.trim();
    if (!ed) return;
    if (!word) {
      clearPdf();
      state.order = [];
      state.text = [];
      state.pdf = [];
      state.at = -1;
      setFindMarks(ed, [], -1);
      showStatus(false);
      return;
    }
    showStatus(true);
    const text = collectHits(ed.state.doc, word).map((hit) => ({ ...hit, pos: hit.from }));
    const pdf = pdfFinders()
      .map((finder) => ({ finder, pos: finder.pos() }))
      .filter((block) => block.pos >= 0)
      .sort((a, b) => a.pos - b.pos);
    const counts = await Promise.all(pdf.map((block) => block.finder.search(word)));
    if (token !== state.token || !state.open) return;
    pdf.forEach((block, i) => {
      block.count = counts[i] || 0;
    });
    const previousAt = state.at;
    state.text = text;
    state.pdf = pdf;
    state.order = orderHits(text, pdf);
    state.capped = text.length >= FIND_LIMIT || pdf.some((block) => block.count >= FIND_LIMIT);
    state.at = -1;
    setFindMarks(ed, text, -1);
    if (!state.order.length) {
      showStatus(false);
      return;
    }
    // After an edit the place in the list is kept and the page is not scrolled, so typing in the
    // text is never interrupted by the bar.
    if (keep && previousAt >= 0) show(Math.min(previousAt, state.order.length - 1), { scroll: false });
    else show(0);
  }

  function later(options) {
    clearTimeout(state.timer);
    state.timer = setTimeout(() => {
      state.timer = 0;
      void search(options);
    }, 250);
  }

  function closeBar({ quiet = false } = {}) {
    if (!state.open) return;
    state.open = false;
    state.token++;
    clearTimeout(state.timer);
    state.timer = 0;
    const ed = editor();
    clearPdf();
    // The marks of the text are taken away; the page itself was never touched.
    if (ed) setFindMarks(ed, [], -1);
    for (const block of state.pdf) void block.finder.search("");
    state.order = [];
    state.text = [];
    state.pdf = [];
    state.at = -1;
    bar.hidden = true;
    if (!quiet) onClose();
  }

  input.addEventListener("input", () => later());
  input.addEventListener("keydown", (event) => {
    if (event.isComposing) return;
    if (event.key === "Enter") {
      event.preventDefault();
      // A word that was just typed is searched for first; one already searched for moves on.
      if (state.timer) {
        clearTimeout(state.timer);
        state.timer = 0;
        void search();
      } else step(event.shiftKey ? -1 : 1);
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      closeBar();
    }
  });

  return {
    /** Shows the bar and puts the cursor in it; `prefill` is the word to start with, if any. */
    open(prefill = "") {
      state.open = true;
      bar.hidden = false;
      if (prefill) input.value = prefill.slice(0, 200);
      input.focus();
      input.select();
      void search();
    },
    close: closeBar,
    /** The page was edited (or a PDF finished loading): look again but stay where we are. */
    refresh() {
      if (state.open) later({ keep: true });
    },
    get isOpen() {
      return state.open;
    },
  };
}
