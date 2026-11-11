import assert from "node:assert/strict";
import test from "node:test";
import { buildTagList, clickTag, favoritePaths, filterTags, pageTitle, parentTags, tagRows } from "../web/tagindex.js";

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

// ---------- folding subtags (0.4.8) ----------
const NESTED = buildTagList([
  { path: "a.md", tags: ["bio", "bio/cells", "bio/cells/membrane", "bio/organs", "bio-notes", "made-by-AI"], favorite: false },
  { path: "b.md", tags: ["Bio/Organs"], favorite: false },
]);
const keys = (rows) => rows.map((r) => r.key);

test("the tags a nested tag sits in", () => {
  assert.deepEqual(parentTags("a/b/c"), ["a", "a/b"]);
  assert.deepEqual(parentTags("a"), []);
});

test("subtags are hidden until their main tag is unfolded, one level at a time", () => {
  assert.deepEqual(keys(tagRows(NESTED, "", new Set())), ["bio", "bio-notes", "made-by-ai"]);
  const one = tagRows(NESTED, "", new Set(["bio"]));
  assert.deepEqual(keys(one), ["bio", "bio-notes", "bio/cells", "bio/organs", "made-by-ai"]);
  assert.deepEqual(one.map((r) => [r.parent, r.unfolded]), [[true, true], [false, false], [true, false], [false, false], [false, false]]);
  assert.deepEqual(keys(tagRows(NESTED, "", new Set(["bio", "bio/cells"]))), ["bio", "bio-notes", "bio/cells", "bio/cells/membrane", "bio/organs", "made-by-ai"]);
  // A subtag that is unfolded while its main tag is folded stays hidden with it.
  assert.deepEqual(keys(tagRows(NESTED, "", new Set(["bio/cells"]))), ["bio", "bio-notes", "made-by-ai"]);
});

test("a filter lists every match, folded or not", () => {
  assert.deepEqual(keys(tagRows(NESTED, "#MEMB", new Set())), ["bio/cells/membrane"]);
  assert.deepEqual(keys(tagRows(NESTED, "organs", new Set())), ["bio/organs"]);
  assert.ok(tagRows(NESTED, "bio", new Set()).every((r) => r.parent === false));
  assert.deepEqual(keys(tagRows(NESTED, "  ", new Set())), ["bio", "bio-notes", "made-by-ai"], "only spaces is no filter");
});

test("a click on a main tag shows its subtags and pages, the next click hides both", () => {
  const row = (unfolded, key) => tagRows(NESTED, "", unfolded).find((r) => r.key === key);
  let state = clickTag(row(new Set(), "bio"), new Set(), "");
  assert.deepEqual([[...state.unfolded], state.selected], [["bio"], "bio"]);
  // A subtag opened inside it: the main tag stays unfolded, the pages shown are the subtag's.
  state = clickTag(row(state.unfolded, "bio/organs"), state.unfolded, state.selected);
  assert.deepEqual([[...state.unfolded], state.selected], [["bio"], "bio/organs"]);
  // Folding the main tag hides the subtag and its pages.
  state = clickTag(row(state.unfolded, "bio"), state.unfolded, state.selected);
  assert.deepEqual([[...state.unfolded], state.selected], [[], ""]);
  // Folding does not close a tag elsewhere.
  state = clickTag(row(new Set(["bio"]), "bio"), new Set(["bio"]), "made-by-ai");
  assert.deepEqual([[...state.unfolded], state.selected], [[], "made-by-ai"]);
  // A tag without subtags only opens and closes its pages.
  state = clickTag(row(new Set(), "made-by-ai"), new Set(), "");
  assert.equal(state.selected, "made-by-ai");
  assert.equal(clickTag(row(new Set(), "made-by-ai"), new Set(), "made-by-ai").selected, "");
  // "bio-notes" is not inside "bio".
  assert.equal(clickTag(row(new Set(["bio"]), "bio"), new Set(["bio"]), "bio-notes").selected, "bio-notes");
});
