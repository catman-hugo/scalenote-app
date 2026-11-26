import { test } from "node:test";
import assert from "node:assert/strict";
import { cleanPenKey, penKeyAction, toggledTool } from "../web/penkeys.js";

const key = (name, extra = {}) => ({ key: name, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, repeat: false, inTextField: false, ...extra });

test("a pen key gets the job set for it; with no job it keeps scrolling", () => {
  const settings = { penKeyDown: "eraser", penKeyUp: "undo" };
  assert.equal(penKeyAction(key("PageDown"), settings), "eraser");
  assert.equal(penKeyAction(key("PageUp"), settings), "undo");
  assert.equal(penKeyAction(key("PageUp"), { penKeyUp: "none" }), null);
  assert.equal(penKeyAction(key("PageDown"), {}), null, "off until chosen");
  assert.equal(penKeyAction(key("PageDown"), { penKeyDown: "explode" }), null, "an unknown value does nothing");
});

test("other keys, held keys, keys with Ctrl or Shift and keys in a text field keep their job", () => {
  const settings = { penKeyDown: "eraser", penKeyUp: "redo" };
  assert.equal(penKeyAction(key("ArrowDown"), settings), null);
  assert.equal(penKeyAction(key("PageDown", { ctrlKey: true }), settings), null);
  assert.equal(penKeyAction(key("PageUp", { shiftKey: true }), settings), null);
  assert.equal(penKeyAction(key("PageDown", { repeat: true }), settings), null);
  assert.equal(penKeyAction(key("PageDown", { inTextField: true }), settings), null);
});

test("the eraser job switches to the eraser and back to the tool before it", () => {
  assert.equal(toggledTool("pen", null), "eraser");
  assert.equal(toggledTool("highlighter", "pen"), "eraser");
  assert.equal(toggledTool("eraser", "highlighter"), "highlighter");
  assert.equal(toggledTool("eraser", null), "pen");
  assert.equal(toggledTool("eraser", "eraser"), "pen");
  assert.equal(cleanPenKey("redo"), "redo");
  assert.equal(cleanPenKey(undefined), "none");
});
