// One-line properties and the favourite mark: only the one line changes, every other byte stays.
import assert from "node:assert/strict";
import test from "node:test";
import { readFavorite, readProperty, withFavorite, withProperty, withoutProperty } from "../web/propertyrules.js";

test("a page with no properties gets a block with just the line", () => {
  assert.equal(withFavorite("", true), "---\nfavorite: true\n---\n\n");
  assert.equal(withFavorite("", false), "");
  assert.equal(readFavorite(""), false);
});

test("the line is added at the end of the block, replaced in place, and removed, leaving the rest as it was", () => {
  const front = "---\nid: abc\ntags: [a, b]\nstatus:   done  \n---\n\n";
  const marked = withFavorite(front, true);
  assert.equal(marked, "---\nid: abc\ntags: [a, b]\nstatus:   done  \nfavorite: true\n---\n\n");
  assert.equal(readFavorite(marked), true);
  assert.equal(withFavorite(marked, false), front);
  assert.equal(withFavorite("---\nfavorite: false\nid: x\n---\n", true), "---\nfavorite: true\nid: x\n---\n");
});

test("Windows line endings are kept", () => {
  const front = "---\r\nid: abc\r\n---\r\n\r\n";
  assert.equal(withFavorite(front, true), "---\r\nid: abc\r\nfavorite: true\r\n---\r\n\r\n");
  assert.equal(withFavorite(withFavorite(front, true), false), front);
});

test("only true counts, in any letter case, with or without quotes", () => {
  for (const [value, expected] of [["true", true], ["True", true], ['"true"', true], ["false", false], ["yes", false], ["1", false], ["", false]]) {
    assert.equal(readFavorite(`---\nfavorite: ${value}\n---\n`), expected, value);
  }
  assert.equal(readFavorite("---\n  favorite: true\n---\n"), false, "a nested key is not ours");
  assert.equal(readFavorite("favorite: true\n"), false, "no block");
});

test("a value spread over several lines, or a block that is not closed, is refused and not changed", () => {
  for (const front of ["---\nfavorite:\n  - yes\n---\n", "---\nfavorite: [a]\n---\n", "---\nfavorite: |\n  x\n---\n", "---\nid: x\n", "---\nid: x\nfavorite: true\n"]) {
    assert.equal(withFavorite(front, true), null, JSON.stringify(front));
  }
  assert.equal(withoutProperty("---\nfavorite:\n  - yes\n---\n", "favorite"), null);
  assert.equal(readProperty("---\nfavorite:\n  - yes\n---\n", "favorite"), null);
});

test("a key that looks like a pattern is matched as plain text and other keys are not touched", () => {
  assert.equal(readProperty("---\nfavoritex: 1\n---\n", "favorite"), null);
  assert.equal(readProperty("---\na.c: 1\nabc: 2\n---\n", "a.c"), "1");
  assert.equal(withoutProperty("---\nfavoritex: 1\n---\n", "favorite"), "---\nfavoritex: 1\n---\n");
});

test("a huge or hostile block is read quickly", () => {
  const started = Date.now();
  const lines = "x: 1\n".repeat(100000);
  const front = `---\n${lines}favorite: true\n---\n`;
  assert.equal(readFavorite(front), true);
  assert.equal(withFavorite(front, false), `---\n${lines}---\n`);
  assert.equal(readFavorite(`---\n${"a".repeat(200000)}\n---\n`), false);
  assert.ok(Date.now() - started < 3000, `${Date.now() - started} ms`);
});
