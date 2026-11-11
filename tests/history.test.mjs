import assert from "node:assert/strict";
import test from "node:test";
import { applyChosen, countChanges, diffLines, keepPageId, lineCount, splitPageBlocks } from "../web/historyrules.js";

const all = (parts) => new Set(parts.map((p, i) => (p.same ? -1 : i)).filter((i) => i >= 0));
const texts = (parts) => parts.map((p) => (p.same ? { same: p.same.join("") } : { current: p.current.join(""), version: p.version.join("") }));

test("identical texts have no change", () => {
  assert.equal(countChanges(diffLines("a\nb\n", "a\nb\n")), 0);
  assert.deepEqual(diffLines("", ""), []);
});

test("an added line, a removed line and a changed line are found as parts", () => {
  assert.deepEqual(texts(diffLines("a\nb\nc\n", "a\nb\nX\nc\n")), [{ same: "a\nb\n" }, { current: "", version: "X\n" }, { same: "c\n" }]);
  assert.deepEqual(texts(diffLines("a\nb\nc\n", "a\nc\n")), [{ same: "a\n" }, { current: "b\n", version: "" }, { same: "c\n" }]);
  assert.deepEqual(texts(diffLines("a\nb\nc\n", "a\nY\nc\n")), [{ same: "a\n" }, { current: "b\n", version: "Y\n" }, { same: "c\n" }]);
});

test("with every change chosen the result is exactly the older version, with none exactly the page now", () => {
  const cases = [
    ["", "new text\n"], ["old text\n", ""], ["a\nb\nc\nd\ne\n", "a\nX\nc\nd\nY\nZ\n"], ["one\r\ntwo\r\n", "one\ntwo\n"],
    ["no ending", "no ending\n"], ["x\n\n\ny\n", "y\n\n\nx\n"], ["é\n日本\n", "日本\né\n"],
  ];
  for (const [now, then] of cases) {
    const parts = diffLines(now, then);
    assert.equal(applyChosen(parts, all(parts)), then, JSON.stringify([now, then]));
    assert.equal(applyChosen(parts, new Set()), now, JSON.stringify([now, then]));
  }
});

test("choosing only some changes takes only those and leaves the other lines as they are now", () => {
  const parts = diffLines("a\nb\nc\nd\ne\n", "a\nB\nc\nd\nE\n");
  const changes = parts.map((p, i) => (p.same ? -1 : i)).filter((i) => i >= 0);
  assert.equal(changes.length, 2);
  assert.equal(applyChosen(parts, new Set([changes[0]])), "a\nB\nc\nd\ne\n");
  assert.equal(applyChosen(parts, new Set([changes[1]])), "a\nb\nc\nd\nE\n");
  assert.equal(applyChosen(parts, new Set([999])), "a\nb\nc\nd\ne\n", "an index that is not a part changes nothing");
});

test("a very large text with one change is compared at once, and unrelated large texts do not take long", () => {
  const started = Date.now();
  const big = Array.from({ length: 200000 }, (_, i) => `line ${i}\n`);
  const edited = big.slice();
  edited[100000] = "changed\n";
  const parts = diffLines(big.join(""), edited.join(""));
  assert.equal(countChanges(parts), 1);
  const x = Array.from({ length: 6000 }, (_, i) => `x${i}\n`).join("");
  const y = Array.from({ length: 6000 }, (_, i) => `y${i}\n`).join("");
  const wide = diffLines(x, y);
  assert.equal(countChanges(wide), 1, "too much to compare line by line: one change");
  assert.equal(applyChosen(wide, all(wide)), y);
  assert.ok(Date.now() - started < 4000, `${Date.now() - started} ms`);
});

test("a restored page keeps the id it has now", () => {
  const now = "---\nid: abc\ntags: [x]\n---\n\nnew\n";
  assert.equal(keepPageId("---\nid: old\n---\n\nold\n", now), "---\nid: abc\n---\n\nold\n");
  assert.equal(keepPageId("---\nid: abc\n---\n\nold\n", now), "---\nid: abc\n---\n\nold\n");
  assert.equal(keepPageId("---\ntags: [y]\n---\n\nold\n", now), "---\ntags: [y]\nid: abc\n---\n\nold\n");
  assert.equal(keepPageId("old\n", now), "---\nid: abc\n---\n\nold\n");
  assert.equal(keepPageId("old\n", "no id now\n"), "old\n");
  assert.equal(keepPageId("---\r\nid: old\r\n---\r\n\r\nold\r\n", now), "---\r\nid: abc\r\n---\r\n\r\nold\r\n");
});

// ---------- comparing block by block (0.4.8) ----------
const PAGE = "---\nid: x\n---\n\n# Title\n\n- one\n- two\n\n\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n\n<details>\n<summary>T</summary>\n\ninside\n\n</details>\nlast";

test("a page cut into blocks joins back into the exact text", () => {
  for (const text of [PAGE, "", "\n\n", "one line", "a\r\n\r\nb\r\n", "\n\nlead\n", "---\nonly: props\n---\n"]) {
    assert.equal(splitPageBlocks(text).join(""), text, JSON.stringify(text));
  }
});

test("a list, a table and a toggle are one piece each; properties and blank lines are one line each", () => {
  assert.deepEqual(splitPageBlocks(PAGE), [
    "---\n", "id: x\n", "---\n", "\n",
    "# Title\n", "\n",
    "- one\n- two\n", "\n", "\n", "\n",
    "| A | B |\n| --- | --- |\n| 1 | 2 |\n", "\n",
    "<details>\n<summary>T</summary>\n\ninside\n\n</details>\n",
    "last",
  ]);
});

test("compared block by block, a changed table cell gives the whole table on both sides", () => {
  const now = PAGE.replace("| 1 | 2 |", "| 1 | 3 |");
  const parts = diffLines(now, PAGE, splitPageBlocks);
  assert.equal(countChanges(parts), 1);
  const change = parts.find((p) => !p.same);
  assert.deepEqual(change.current, ["| A | B |\n| --- | --- |\n| 1 | 3 |\n"]);
  assert.deepEqual(change.version, ["| A | B |\n| --- | --- |\n| 1 | 2 |\n"]);
  // Putting every change back is the older version, to the byte; none, the page now.
  assert.equal(applyChosen(parts, all(parts)), PAGE);
  assert.equal(applyChosen(parts, new Set()), now);
});

test("random pages compared block by block always put back exactly", () => {
  let seed = 99;
  const rand = (n) => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) % n);
  const pool = ["# h", "text", "", "- a", "- b", "> q", "```", "| a | b |", "|---|---|", "<details>", "<summary>s</summary>", "</details>", "---", "more text", "  "];
  const make = () => Array.from({ length: rand(14) }, () => pool[rand(pool.length)]).join("\n") + (rand(2) ? "\n" : "");
  for (let round = 0; round < 1500; round++) {
    const a = make();
    const b = make();
    const parts = diffLines(a, b, splitPageBlocks);
    assert.equal(applyChosen(parts, all(parts)), b);
    assert.equal(applyChosen(parts, new Set()), a);
  }
});

test("lines are counted inside pieces of several lines", () => {
  assert.equal(lineCount(["a\n", "b\nc\nd\n", "\n", "end"]), 6);
  assert.equal(lineCount([]), 0);
});
