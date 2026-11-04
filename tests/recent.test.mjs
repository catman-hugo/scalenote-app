import test from "node:test";
import assert from "node:assert/strict";
import { addRecent, cleanRecent, folderLabel, MAX_PATH_LENGTH, MAX_RECENT, removeRecent } from "../web/recent.js";

test("cleanRecent keeps only usable text, without repeats, and at most MAX_RECENT entries", () => {
  assert.deepEqual(cleanRecent(undefined), []);
  assert.deepEqual(cleanRecent("not a list"), []);
  assert.deepEqual(cleanRecent([1, null, "", {}, "/a", "/a", "/b", "bad\nname", "x".repeat(MAX_PATH_LENGTH + 1)]), ["/a", "/b"]);
  const many = Array.from({ length: 30 }, (_, i) => "/folder" + i);
  assert.equal(cleanRecent(many).length, MAX_RECENT);
});

test("addRecent puts the newest first, moves a repeat to the front and drops the oldest", () => {
  assert.deepEqual(addRecent(["/a", "/b"], "/c"), ["/c", "/a", "/b"]);
  assert.deepEqual(addRecent(["/a", "/b", "/c"], "/c"), ["/c", "/a", "/b"]);
  const full = Array.from({ length: MAX_RECENT }, (_, i) => "/f" + i);
  const next = addRecent(full, "/new");
  assert.equal(next.length, MAX_RECENT);
  assert.equal(next[0], "/new");
  assert.ok(!next.includes("/f" + (MAX_RECENT - 1)));
  assert.deepEqual(addRecent(["/a"], ""), ["/a"]);
});

test("removeRecent removes one entry", () => {
  assert.deepEqual(removeRecent(["/a", "/b"], "/a"), ["/b"]);
  assert.deepEqual(removeRecent(["/a"], "/zzz"), ["/a"]);
});

test("folderLabel shows the last part of a path, for / and \\", () => {
  assert.equal(folderLabel("/home/alice/Documents/ScaleNote"), "ScaleNote");
  assert.equal(folderLabel("/home/alice/Work/"), "Work");
  assert.equal(folderLabel("C:\\Users\\alice\\Pages"), "Pages");
  assert.equal(folderLabel("/"), "/");
});
