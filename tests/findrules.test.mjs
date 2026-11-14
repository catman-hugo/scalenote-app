// Tests for the plain rules of finding a word in a page (web/findrules.js).

import test from "node:test";
import assert from "node:assert/strict";
import { FIND_LIMIT, findAll, foldText, orderHits } from "../web/findrules.js";

test("findAll ignores case, trims the word and does not overlap hits", () => {
  assert.deepEqual(findAll("Hello hello HELLO", "  Hello "), [
    { start: 0, end: 5 },
    { start: 6, end: 11 },
    { start: 12, end: 17 },
  ]);
  assert.deepEqual(findAll("aaaa", "aa"), [{ start: 0, end: 2 }, { start: 2, end: 4 }]);
});

test("findAll gives nothing for an empty or missing word", () => {
  assert.deepEqual(findAll("abc", ""), []);
  assert.deepEqual(findAll("abc", "   "), []);
  assert.deepEqual(findAll("abc", undefined), []);
  assert.deepEqual(findAll("", "a"), []);
});

test("a letter that changes length when made small does not move later hits", () => {
  // A capital dotted I becomes two characters when made small.
  const text = "İİ word";
  assert.equal(foldText(text).folded.length, text.length + 2);
  const [hit] = findAll(text, "word");
  assert.equal(text.slice(hit.start, hit.end), "word");
});

test("findAll stops at the limit", () => {
  assert.equal(findAll("a".repeat(FIND_LIMIT + 50), "a").length, FIND_LIMIT);
  assert.equal(findAll("a a a a", "a", 2).length, 2);
});

test("orderHits puts text and PDF hits in reading order", () => {
  const order = orderHits([{ pos: 5 }, { pos: 40 }], [{ pos: 20, count: 2 }]);
  assert.deepEqual(order, [
    { kind: "text", index: 0 },
    { kind: "pdf", block: 0, index: 0 },
    { kind: "pdf", block: 0, index: 1 },
    { kind: "text", index: 1 },
  ]);
  assert.deepEqual(orderHits([], [{ pos: 1, count: 0 }]), []);
});
