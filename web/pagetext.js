// Shows markdown as the page looks in the editor (headings, lists, bold...), for reading only.
// The History box uses it when it is opened from the normal text, so an older version reads
// like the page and not like its file.
//
// The text goes through the same reading rules as the editor (compose.js), so anything the
// editor would show as a "kept exactly as written" box is shown that way here too. The result
// is built as page elements directly, never from a string of html, so nothing in a note can
// run or load anything.

import { DOMSerializer } from "@tiptap/pm/model";
import { loadPiece } from "./compose.js";
import { strings } from "./strings.js";

// How the blocks that have their own editing controls are drawn when they are only read.
function readOnlyNodes(schema) {
  const nodes = DOMSerializer.nodesFromSchema(schema);
  return {
    ...nodes,
    toggle: (node) => ["div", { class: "toggle" }, ["div", { class: "page-text-title" }, node.attrs.summary || strings.toggle.summaryPlaceholder], ["div", { class: "toggle-body" }, 0]],
    callout: (node) => [
      "div",
      { class: "callout", "data-kind": node.attrs.kind },
      ["div", { class: "page-text-title" }, ["span", { class: "callout-kind" }, strings.callout.kinds[node.attrs.kind] || node.attrs.kind], node.attrs.title ? " " + node.attrs.title : ""],
      ["div", { class: "callout-body" }, 0],
    ],
    columns: () => ["div", { class: "columns" }, 0],
    column: () => ["div", { class: "column" }, 0],
    imageBlock: (node) => ["p", { class: "page-text-picture" }, strings.pageText.picture.replace("{name}", node.attrs.alt || node.attrs.path)],
    rawBlock: (node) => ["pre", { class: "raw-block page-text-raw" }, node.attrs.src],
    // The editor's own table carries a width as a style attribute, which the page's security
    // policy does not allow; a plain table needs none.
    table: () => ["table", {}, ["tbody", 0]],
  };
}

/** Returns `render(markdown)`, which gives an element holding the text as the editor shows it. */
export function createPageText(editor) {
  const io = { parse: (md) => editor.markdown.parse(md), serialize: (json) => editor.markdown.serialize(json) };
  const serializer = new DOMSerializer(readOnlyNodes(editor.schema), DOMSerializer.marksFromSchema(editor.schema));
  return (markdown) => {
    // The page's own text styles apply inside "note-body"; "page-text" switches off what only
    // the editor needs (its width and height).
    const box = document.createElement("div");
    box.className = "note-body page-text";
    try {
      const doc = editor.schema.nodeFromJSON(loadPiece(markdown, io));
      box.append(serializer.serializeFragment(doc.content));
    } catch {
      // Text the editor cannot read at all is still shown, as it is written.
      const pre = document.createElement("pre");
      pre.className = "raw-block page-text-raw";
      pre.textContent = markdown;
      box.replaceChildren(pre);
    }
    return box;
  };
}
