// A PDF shown inside a page: a box of fixed height that scrolls through the pages, like the
// "Embed" of ScaleNote v1 but drawn by pdf.js, so it also works in the Android webview and in
// every desktop webview (a PDF in an iframe does not).
//
// It is for looking: nothing in it can be edited. Pages are drawn only while they are near the
// visible part of the box and are cleared again when they are far away, so a PDF of hundreds of
// pages costs the memory of a few. In the file it is a plain markdown picture link to a .pdf,
// `![name](attachments/name.pdf)`, which Obsidian also shows as a PDF.

import { Node } from "@tiptap/core";
import { bytesOfDataUrl, openPdf, wasCancelled } from "./pdfdoc.js";
import { findInPages, pdfTitle } from "./pdfrules.js";
import { strings } from "./strings.js";

function make(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

// Every PDF block on screen, so the page's find bar can ask each one for its hits.
const finders = new Set();
export const pdfFinders = () => [...finders];

const fill = (text, values) => text.replace(/\{(\w+)\}/g, (_, key) => String(values[key] ?? ""));

export const PdfBlock = Node.create({
  name: "pdfBlock",
  group: "block",
  atom: true,
  draggable: false,
  addOptions() {
    return {
      load: async () => {
        throw new Error("no loader");
      },
    };
  },
  addAttributes() {
    return {
      alt: { default: "", rendered: false },
      path: { default: "", rendered: false },
    };
  },
  parseHTML() {
    return [{ tag: "figure[data-pdf-block]" }];
  },
  renderHTML({ node }) {
    return ["figure", { "data-pdf-block": "" }, node.attrs.path];
  },
  addNodeView() {
    const { load } = this.options;
    const t = strings.pdf.block;
    return ({ node, getPos }) => {
      let current = node;
      const dom = make("figure", "pdf-block");
      const head = make("figcaption", "pdf-block-head");
      const title = make("span", "pdf-block-title");
      const count = make("span", "pdf-block-count");
      head.append(title, count);
      const scroll = make("div", "pdf-block-scroll");
      scroll.tabIndex = 0;
      scroll.setAttribute("role", "group");
      scroll.setAttribute("aria-label", t.surface);
      const message = make("p", "pdf-block-message");
      message.hidden = true;
      dom.append(head, scroll, message);

      // One generation per time the file is (re)loaded; work for an older one is dropped.
      let generation = 0;
      let session = null;

      const nameOf = () => current.attrs.alt || pdfTitle(String(current.attrs.path).split("/").pop());
      const showTitle = () => {
        title.textContent = nameOf();
      };

      function stopSession() {
        if (!session) return;
        const old = session;
        session = null;
        old.dead = true;
        old.observer.disconnect();
        if (old.resize) old.resize.disconnect();
        clearTimeout(old.resizeTimer);
        for (const page of old.pages) {
          if (page.task.cancel) page.task.cancel();
          if (page.textTask.cancel) page.textTask.cancel();
        }
        void old.pdf.destroy();
        scroll.replaceChildren();
      }

      function problem(text) {
        scroll.hidden = true;
        message.textContent = text;
        message.hidden = false;
      }

      function release(page) {
        if (page.task.cancel) page.task.cancel();
        if (page.textTask.cancel) page.textTask.cancel();
        page.textTask = {};
        page.text.replaceChildren();
        page.textDivs = null;
        page.task = {};
        page.rendered = false;
        // A zero size frees the pixels of the page.
        page.canvas.width = 0;
        page.canvas.height = 0;
      }

      function draw(s, page) {
        // Pages are drawn one at a time, so the worker is never asked for more than it can do.
        s.queue = s.queue.then(async () => {
          if (s.dead || !page.visible || page.rendered) return;
          const ratio = Math.min(2, window.devicePixelRatio || 1);
          try {
            const done = await s.pdf.render(page.n, page.canvas, { cssWidth: Math.max(50, scroll.clientWidth), ratio, task: page.task });
            if (s.dead) return;
            page.rendered = true;
            page.box.style.aspectRatio = `${done.width} / ${done.height}`;
          } catch (error) {
            if (!wasCancelled(error) && !s.dead) page.box.classList.add("pdf-page-failed");
            return;
          }
          // The words come after the picture; a page whose words cannot be read is still shown.
          try {
            const words = await s.pdf.renderText(page.n, page.text, { cssWidth: Math.max(50, page.box.clientWidth || scroll.clientWidth), task: page.textTask });
            if (s.dead || !page.rendered) return;
            page.textDivs = words.layer.textDivs;
            mark(s, page);
          } catch {
            // No words: the picture alone is still useful.
          }
        });
      }

      // ---- find ----
      // The page's find bar (pagefind.js) drives this: it asks for the hits of a word, and then
      // for one hit to be the current one. The hits are worked out from the text of every page
      // (read once, then kept) and marked on the words of the pages that are drawn.
      function mark(s, page) {
        if (!page.textDivs) return;
        for (const div of page.textDivs) div.classList.remove("pdf-hit", "pdf-hit-current");
        const find = s.find;
        if (!find) return;
        find.hits.forEach((hit, k) => {
          if (hit.page !== page.n) return;
          const div = page.textDivs[hit.piece];
          if (!div) return;
          div.classList.add("pdf-hit");
          if (k === find.current) {
            div.classList.add("pdf-hit-current");
            if (find.scrollTo === k) {
              find.scrollTo = -1;
              centre(div);
            }
          }
        });
      }

      // Scrolls only the PDF box (never the page around it) so `target` is in its middle.
      function centre(target) {
        const box = scroll.getBoundingClientRect();
        const at = target.getBoundingClientRect();
        scroll.scrollTop += at.top - box.top - (box.height - at.height) / 2;
      }

      // Makes hit `k` the current one (-1: none) and scrolls the box to it. A page whose words
      // are not drawn yet is marked as soon as it has been drawn.
      function reveal(s, k) {
        const find = s.find;
        if (!find) return;
        const old = find.hits[find.current];
        find.current = k >= 0 && k < find.hits.length ? k : -1;
        find.scrollTo = find.current;
        const hit = find.hits[find.current];
        if (hit) {
          const page = s.pages[hit.page - 1];
          const boxTop = scroll.scrollTop + page.box.getBoundingClientRect().top - scroll.getBoundingClientRect().top;
          scroll.scrollTop = Math.max(0, boxTop - 8);
          mark(s, page);
        }
        if (old && (!hit || old.page !== hit.page)) mark(s, s.pages[old.page - 1]);
      }

      // Resolves to the number of hits, or null when a newer search made this one out of date.
      async function search(s, text) {
        const old = s.find;
        const find = (s.find = text ? { text, hits: [], current: -1, scrollTo: -1 } : null);
        if (old) for (const page of s.pages) mark(s, page);
        if (!find) return 0;
        // Page text is read once for the whole PDF; two searches in a row share it.
        if (!s.texts) {
          s.texts = (async () => {
            const all = [];
            for (let n = 1; n <= s.pdf.pages; n++) {
              if (s.dead) return all;
              try {
                all.push(await s.pdf.pageText(n));
              } catch {
                all.push([]);
              }
            }
            return all;
          })();
        }
        const pages = await s.texts;
        if (s.dead || s.find !== find) return null;
        find.hits = findInPages(pages, text);
        for (const page of s.pages) mark(s, page);
        return find.hits.length;
      }

      const finder = {
        dom,
        pos: () => {
          const at = typeof getPos === "function" ? getPos() : -1;
          return typeof at === "number" ? at : -1;
        },
        search: async (text) => {
          await ready;
          return session ? search(session, text) : 0;
        },
        reveal: (k) => {
          if (session) reveal(session, k);
        },
      };
      finders.add(finder);

      // Resolves when the PDF has been opened (or has failed), so a search started while it is
      // still loading waits for it instead of finding nothing.
      let ready = Promise.resolve();
      function start() {
        ready = begin();
        return ready;
      }
      async function begin() {
        const mine = ++generation;
        stopSession();
        scroll.hidden = false;
        message.hidden = true;
        count.textContent = "";
        showTitle();
        let pdf;
        try {
          pdf = await openPdf(bytesOfDataUrl(await load(current.attrs.path)));
        } catch (error) {
          if (mine !== generation) return;
          // A missing file and an unreadable one are told apart, so the cause is not a mystery.
          problem(error && error.code === "not_found" ? t.missing : t.failed);
          return;
        }
        if (mine !== generation) {
          void pdf.destroy();
          return;
        }
        let ratio = 1.414;
        try {
          const size = await pdf.pageSize(1);
          ratio = size.width / size.height;
        } catch {
          // Pages use a paper-like shape until they are drawn.
        }
        if (mine !== generation) {
          void pdf.destroy();
          return;
        }
        const s = { pdf, pages: [], dead: false, queue: Promise.resolve(), resize: null, resizeTimer: 0, observer: null, find: null, texts: null };
        s.observer = new IntersectionObserver(
          (entries) => {
            for (const entry of entries) {
              const page = entry.target.pageInfo;
              page.visible = entry.isIntersecting;
              if (page.visible) draw(s, page);
              else if (page.rendered || page.task.cancel) release(page);
            }
          },
          { root: scroll, rootMargin: "600px 0px" },
        );
        for (let n = 1; n <= pdf.pages; n++) {
          const box = make("div", "pdf-page");
          box.style.aspectRatio = String(ratio);
          box.setAttribute("role", "img");
          box.setAttribute("aria-label", fill(t.pageLabel, { page: n }));
          const canvas = make("canvas", "pdf-page-canvas");
          // A new canvas is 300 x 150 pixels; a page that is not drawn must hold no pixels.
          canvas.width = 0;
          canvas.height = 0;
          const text = make("div", "pdf-text");
          // The words are not read out by a screen reader page by page; the label above is.
          text.setAttribute("aria-hidden", "true");
          box.append(canvas, text);
          const page = { n, box, canvas, text, textDivs: null, textTask: {}, visible: false, rendered: false, task: {} };
          box.pageInfo = page;
          s.pages.push(page);
          scroll.append(box);
        }
        session = s;
        count.textContent = pdf.pages === 1 ? t.pageCountOne : fill(t.pageCount, { count: pdf.pages });
        for (const page of s.pages) s.observer.observe(page.box);
        // The box can change width (a window, a column, a rotated phone): pages are drawn again.
        if (typeof ResizeObserver === "function") {
          let width = scroll.clientWidth;
          s.resize = new ResizeObserver(() => {
            if (Math.abs(scroll.clientWidth - width) < 2) return;
            width = scroll.clientWidth;
            clearTimeout(s.resizeTimer);
            s.resizeTimer = setTimeout(() => {
              for (const page of s.pages) {
                if (page.rendered || page.task.cancel) release(page);
                // Watching it again makes the observer report where it is now.
                s.observer.unobserve(page.box);
                s.observer.observe(page.box);
              }
            }, 150);
          });
          s.resize.observe(scroll);
        }
      }

      void start();
      return {
        dom,
        update(updated) {
          if (updated.type !== current.type) return false;
          const moved = updated.attrs.path !== current.attrs.path;
          current = updated;
          if (moved) void start();
          else showTitle();
          return true;
        },
        // Scrolling, dragging the scroll bar and pressing keys in the box belong to the box,
        // not to the editor.
        stopEvent: (event) => scroll.contains(event.target),
        ignoreMutation: () => true,
        destroy() {
          finders.delete(finder);
          generation++;
          stopSession();
        },
      };
    };
  },
});
