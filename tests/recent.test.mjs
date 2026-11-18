import test from "node:test";
import assert from "node:assert/strict";
import { addRecent, cleanFolderColours, withFolderColour, MAX_FOLDER_COLOURS, cleanRecent, folderLabel, MAX_PATH_LENGTH, MAX_RECENT, removeRecent } from "../web/recent.js";

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

const PALETTE = ["red", "green"];

test("cleanFolderColours keeps only known colours on usable paths and tolerates hostile input", () => {
  assert.deepEqual({ ...cleanFolderColours(null, PALETTE) }, {});
  assert.deepEqual({ ...cleanFolderColours([1], PALETTE) }, {});
  const hostile = JSON.parse('{"/a":"red","/b":"pink","/c":5,"bad\\nname":"green","__proto__":"green"}');
  const clean = cleanFolderColours(hostile, PALETTE);
  // A folder really called "__proto__" is allowed; it is just a key on a bare object.
  assert.deepEqual(Object.keys(clean), ["/a", "__proto__"]);
  assert.equal(({}).polluted, undefined);
  assert.equal(Object.getPrototypeOf(clean), null);
  const many = {};
  for (let i = 0; i < 200; i++) many["/f" + i] = "red";
  assert.equal(Object.keys(cleanFolderColours(many, PALETTE)).length, MAX_FOLDER_COLOURS);
});

test("withFolderColour sets, replaces and removes a colour without touching the others", () => {
  let list = withFolderColour({}, "/a", "red", PALETTE);
  list = withFolderColour(list, "/b", "green", PALETTE);
  assert.deepEqual({ ...list }, { "/a": "red", "/b": "green" });
  assert.deepEqual({ ...withFolderColour(list, "/a", "green", PALETTE) }, { "/a": "green", "/b": "green" });
  assert.deepEqual({ ...withFolderColour(list, "/a", "none", PALETTE) }, { "/b": "green" });
  assert.deepEqual({ ...withFolderColour(list, "/a", "pink", PALETTE) }, { "/a": "red", "/b": "green" });
  assert.deepEqual({ ...withFolderColour(list, "", "red", PALETTE) }, { "/a": "red", "/b": "green" });
});
