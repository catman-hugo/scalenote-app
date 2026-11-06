// Reading, setting and removing the cover line without touching the rest of the properties.
import assert from "node:assert/strict";
import test from "node:test";
import { isCoverPath, readCover, withCover, withoutCover } from "../web/coverrules.js";

test("which paths may be a cover", () => {
  for (const ok of ["attachments/a.png", "attachments/My-photo_2.JPG", "attachments/x.webp", "attachments/sub/a.gif"]) assert.ok(isCoverPath(ok), ok);
  for (const bad of ["", null, undefined, 5, "a.png", "attachments/a.svg", "attachments/a.png.exe", "attachments/../a.png", "../attachments/a.png", "attachments//a.png", "attachments/a b.png", "attachments/a.png)", "http://example.local/a.png", "attachments\\a.png", "attachments/<a>.png", "/attachments/a.png"]) assert.ok(!isCoverPath(bad), String(bad));
});

test("a cover is read from the properties, quoted or not", () => {
  assert.equal(readCover("---\nid: abc\ncover: attachments/a.png\n---\n"), "attachments/a.png");
  assert.equal(readCover('---\ncover: "attachments/a.png"\n---\n'), "attachments/a.png");
  assert.equal(readCover("---\r\ncover: 'attachments/a.png'  \r\n---\r\n"), "attachments/a.png");
  assert.equal(readCover("---\nid: abc\n---\n"), null);
  assert.equal(readCover(""), null);
  assert.equal(readCover("---\ncover: attachments/a.svg\n---\n"), null);
  assert.equal(readCover("---\ncover: https://example.local/a.png\n---\n"), null);
  assert.equal(readCover("---\ncover:\n  - attachments/a.png\n---\n"), null);
  assert.equal(readCover("---\ncover: attachments/a.png\n"), null, "a block that is never closed is not read");
  assert.equal(readCover("---\nnote: cover: attachments/a.png\n---\n"), null, "only a key at the start of a line counts");
  assert.equal(readCover("---\n  cover: attachments/a.png\n---\n"), null);
});

test("setting a cover changes one line and nothing else", () => {
  assert.equal(withCover("", "attachments/a.png"), "---\ncover: attachments/a.png\n---\n\n");
  assert.equal(withCover("---\nid: abc\ntags: [x, y]\n---\n", "attachments/a.png"), "---\nid: abc\ntags: [x, y]\ncover: attachments/a.png\n---\n");
  assert.equal(withCover("---\ncover: attachments/old.png\nid: abc\n---\n", "attachments/new.png"), "---\ncover: attachments/new.png\nid: abc\n---\n");
  assert.equal(withCover('---\ncover: "attachments/old.png"\n---\n', "attachments/new.png"), "---\ncover: attachments/new.png\n---\n");
  assert.equal(withCover("---\r\nid: abc\r\n---\r\n", "attachments/a.png"), "---\r\nid: abc\r\ncover: attachments/a.png\r\n---\r\n");
  assert.equal(withCover("---\n---\n", "attachments/a.png"), "---\ncover: attachments/a.png\n---\n");
});

test("a cover that cannot be changed safely is refused, not guessed at", () => {
  assert.equal(withCover("---\nid: a\n---\n", "attachments/a.svg"), null);
  assert.equal(withCover("---\nid: a\n---\n", "../x.png"), null);
  assert.equal(withCover("---\nid: a\n", "attachments/a.png"), null, "never closed");
  assert.equal(withCover("not a block\n", "attachments/a.png"), null);
  assert.equal(withCover("---\ncover:\n  - attachments/a.png\n---\n", "attachments/b.png"), null);
  assert.equal(withCover("---\ncover: |\n  text\n---\n", "attachments/b.png"), null);
  assert.equal(withoutCover("---\ncover:\n  a: b\n---\n"), null);
});

test("removing a cover takes out its line only", () => {
  assert.equal(withoutCover("---\nid: abc\ncover: attachments/a.png\ntags: x\n---\n"), "---\nid: abc\ntags: x\n---\n");
  assert.equal(withoutCover("---\ncover: attachments/a.png\n---\n"), "---\n---\n");
  assert.equal(withoutCover("---\nid: abc\n---\n"), "---\nid: abc\n---\n");
  assert.equal(withoutCover(""), "");
  assert.equal(withoutCover("---\r\ncover: attachments/a.png\r\nid: z\r\n---\r\n"), "---\r\nid: z\r\n---\r\n");
});

test("setting then removing gives back the original, for many shapes of block", () => {
  const blocks = ["", "---\nid: a\n---\n", "---\r\nid: a\r\nx: 1\r\n---\r\n", "---\n---\n", "---\ntitle: A: B\nlist:\n  - one\n  - two\n---\n", "---\nid: a\n---"];
  for (const front of blocks) {
    const set = withCover(front, "attachments/c.png");
    if (set === null) continue;
    assert.equal(readCover(set), "attachments/c.png", JSON.stringify(front));
    const back = withoutCover(set);
    assert.equal(back, front === "" ? "---\n---\n\n" : front, JSON.stringify(front));
  }
});

test("odd and huge input never throws", () => {
  const started = Date.now();
  for (const text of ["---\n".repeat(50000), "---\ncover: ".repeat(20000) + "\n---\n", "\0", "---\ncover: " + "a".repeat(200000) + "\n---\n", "---\n" + "cover: x\n".repeat(50000) + "---\n"]) {
    readCover(text);
    withCover(text, "attachments/a.png");
    withoutCover(text);
  }
  assert.ok(Date.now() - started < 3000, `${Date.now() - started} ms`);
});
