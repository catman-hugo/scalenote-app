// Which toggles are folded when a page is put on screen (the rule only; folding itself is
// tested in the browser, tests/editor.spec.mjs).

import test from "node:test";
import assert from "node:assert/strict";
import { foldsFor } from "../web/togglefold.js";

test("a page seen for the first time has every toggle folded", () => {
  assert.deepEqual(foldsFor(3, undefined), [true, true, true]);
  assert.deepEqual(foldsFor(0, undefined), []);
});

test("a page seen before gets its toggles as they were left", () => {
  assert.deepEqual(foldsFor(3, [false, true, false]), [false, true, false]);
});

test("a toggle the remembered list does not cover is folded, and extra entries are ignored", () => {
  assert.deepEqual(foldsFor(3, [false]), [false, true, true]);
  assert.deepEqual(foldsFor(1, [false, false, false]), [false]);
});

test("a remembered list that is not a list counts as never seen", () => {
  assert.deepEqual(foldsFor(2, "no"), [true, true]);
  assert.deepEqual(foldsFor(2, null), [true, true]);
});
