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
import { icon } from "./icons.js";
import { TEXT_LIMITS, findInPages, pdfTitle } from "./pdfrules.js";
import { strings } from "./strings.js";

function make(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

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
    return ({ node }) => {
      let current = node;
      const dom = make("figure", "pdf-block");
      const head = make("figcaption", "pdf-block-head");
      const title = make("span", "pdf-block-title");
      const count = make("span", "pdf-block-count");
      // Find: a small search box, previous / next and a "3 of 12" status.
      const finder = make("form", "pdf-block-find");
      const query = make("input");
      query.type = "search";
      query.placeholder = t.findPlaceholder;
      query.setAttribute("aria-label", t.find);
      query.maxLength = 200;
      const previous = make("button");
      previous.type = "button";
      previous.setAttribute("aria-label", t.findPrevious);
      previous.title = t.findPrevious;
      previous.append(icon("chevronUp"));
      const next = make("button");
      next.type = "button";
      next.setAttribute("aria-label", t.findNext);
      next.title = t.findNext;
      next.append(icon("chevronDown"));
      const status = make("span", "pdf-block-find-status");
      status.setAttribute("role", "status");
      finder.append(query, previous, next, status);
      head.append(title, finder, count);
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
        status.textContent = "";
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
      // The hits are worked out from the text of every page (read once, then kept), and marked
      // on the words of the pages that are drawn. Moving to a hit scrolls to its page first.
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

      function showStatus(s) {
        const find = s.find;
        if (!find) status.textContent = "";
        else if (find.searching) status.textContent = t.findSearching;
        else if (!find.hits.length) status.textContent = t.findNone;
        else {
          const capped = find.hits.length >= TEXT_LIMITS.hits;
          status.textContent = fill(capped ? t.findMany : t.findCount, { current: find.current + 1, total: find.hits.length });
        }
      }

      function go(s, k) {
        const find = s.find;
        if (!find || !find.hits.length) return;
        const total = find.hits.length;
        const old = find.hits[find.current];
        find.current = ((k % total) + total) % total;
        find.scrollTo = find.current;
        const hit = find.hits[find.current];
        showStatus(s);
        const page = s.pages[hit.page - 1];
        // Scroll so the page is on screen; if its words are drawn already they are marked now,
        // otherwise they are marked as soon as the page finishes drawing.
        const boxTop = scroll.scrollTop + page.box.getBoundingClientRect().top - scroll.getBoundingClientRect().top;
        scroll.scrollTop = Math.max(0, boxTop - 8);
        if (old && old.page !== hit.page) mark(s, s.pages[old.page - 1]);
        mark(s, page);
      }

      async function search(s) {
        const text = query.value.trim();
        const old = s.find;
        const find = (s.find = text ? { text, hits: [], current: 0, scrollTo: -1, searching: true } : null);
        if (old) for (const page of s.pages) mark(s, page);
        if (!find) {
          showStatus(s);
          return;
        }
        showStatus(s);
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
        if (s.dead || s.find !== find) return;
        find.hits = findInPages(pages, text);
        find.searching = false;
        for (const page of s.pages) mark(s, page);
        if (find.hits.length) go(s, 0);
        else showStatus(s);
      }

      finder.addEventListener("submit", (event) => {
        event.preventDefault();
        if (!session) return;
        // Enter on an unchanged word means "the next one".
        if (session.find && session.find.text === query.value.trim() && !session.find.searching) go(session, session.find.current + 1);
        else void search(session);
      });
      let typing = 0;
      query.addEventListener("input", () => {
        clearTimeout(typing);
        typing = setTimeout(() => {
          if (session) void search(session);
        }, 300);
      });
      previous.addEventListener("click", () => session && go(session, session.find ? session.find.current - 1 : 0));
      next.addEventListener("click", () => session && go(session, session.find ? session.find.current + 1 : 0));

      async function start() {
        const mine = ++generation;
        stopSession();
        scroll.hidden = false;
        message.hidden = true;
        count.textContent = "";
        status.textContent = "";
        query.value = "";
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
        stopEvent: (event) => scroll.contains(event.target) || finder.contains(event.target),
        ignoreMutation: () => true,
        destroy() {
          clearTimeout(typing);
          generation++;
          stopSession();
        },
      };
    };
  },
});
