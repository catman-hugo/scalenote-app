import assert from "node:assert/strict";
import test from "node:test";
import { buildTagList, favoritePaths, filterTags, pageTitle } from "../web/tagindex.js";

const pages = [
  { path: "A.md", tags: ["Plan", "school/maths"], favorite: true },
  { path: "Sub/B.md", tags: ["plan"], favorite: false },
  { path: "C.md", tags: ["school/art", "School/maths", "plan"], favorite: true },
  { path: "Sub/a b.md", tags: [], favorite: true },
];

test("tags are grouped without regard to case and nested tags count for their parents", () => {
  const list = buildTagList(pages);
  assert.deepEqual(list.map((t) => [t.name, t.depth, t.pages]), [
    ["plan", 0, ["A.md", "Sub/B.md", "C.md"]],
    ["school", 0, ["A.md", "C.md"]],
    ["school/art", 1, ["C.md"]],
    // One page spells it "school/maths" and one "School/maths": a tie, so the first alphabetically.
    ["School/maths", 1, ["A.md", "C.md"]],
  ]);
});

test("the spelling used most often is the one shown", () => {
  const list = buildTagList(pages);
  assert.equal(list.find((t) => t.key === "plan").name, "plan", "two lower case against one capital");
  assert.equal(list.find((t) => t.key === "school").name, "school", "a parent with no spelling of its own");
});

test("odd tags do not break the list", () => {
  assert.deepEqual(buildTagList([{ path: "x.md", tags: ["a//b", "/c", "d/"], favorite: false }]).map((t) => t.key), ["a", "d"]);
  assert.deepEqual(buildTagList([]), []);
  assert.equal(buildTagList([{ path: "x.md", tags: Array.from({ length: 5000 }, (_, i) => `t${i}`), favorite: false }]).length, 5000);
});

test("filter ignores case and a leading #", () => {
  const list = buildTagList(pages);
  assert.deepEqual(filterTags(list, "#SCH").map((t) => t.key), ["school", "school/art", "school/maths"]);
  assert.equal(filterTags(list, "  ").length, list.length);
  assert.deepEqual(filterTags(list, "zzz"), []);
});

test("favourites are listed by title", () => {
  assert.deepEqual(favoritePaths(pages), ["A.md", "Sub/a b.md", "C.md"].sort((a, b) => pageTitle(a).localeCompare(pageTitle(b))));
  assert.equal(pageTitle("Sub/Deep/Note.md"), "Note");
});
