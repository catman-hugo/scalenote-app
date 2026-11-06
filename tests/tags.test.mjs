// The editor's version of the tag rules, checked against the cases shared with the Rust code.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { findTags, hasTags, isTagName, MAX_TAG_CHARS, MAX_TAGS, sameTags, withoutTags } from "../web/tagrules.js";

// In the shared cases \n is a line break, \t a tab and \\ a backslash.
const unescape = (text) => text.replace(/\\(.)/g, (_all, letter) => (letter === "n" ? "\n" : letter === "t" ? "\t" : letter));
const names = (text) => findTags(text).map((tag) => tag.name);

test("the shared cases give the same answers as the Rust code", () => {
  let checkedNames = 0;
  let checkedFinds = 0;
  // The file may be checked out with Windows line ends, so lines are split on both kinds.
  for (const line of readFileSync(new URL("./fixtures/tags.txt", import.meta.url), "utf8").split(/\r?\n/)) {
    if (!line.trim() || line.startsWith("#")) continue;
    if (line.startsWith("name ")) {
      const [input, expected] = line.slice(5).split(" => ");
      assert.equal(isTagName(input), expected.trim() === "yes", `name ${input}`);
      checkedNames++;
    } else if (line.startsWith("find ")) {
      const [input, expected] = line.slice(5).split(" => ");
      const want = expected.trim() === "(none)" ? [] : expected.split(", ");
      assert.deepEqual(names(unescape(input)), want, `find ${input}`);
      checkedFinds++;
    }
  }
  assert.ok(checkedNames >= 15 && checkedFinds >= 25, `${checkedNames} ${checkedFinds}`);
});

test("positions cut out exactly the tag", () => {
  const text = "héllo #plan and #日本語 and 😀 #emoji-after";
  const [a, b, c] = findTags(text);
  assert.equal(text.slice(a.start, a.end), "#plan");
  assert.equal(text.slice(b.start, b.end), "#日本語");
  assert.equal(text.slice(c.start, c.end), "#emoji-after");
});

test("a name is limited to 100 letters, counted as letters", () => {
  assert.ok(isTagName("é".repeat(MAX_TAG_CHARS)));
  assert.ok(!isTagName("é".repeat(MAX_TAG_CHARS + 1)));
  assert.ok(isTagName("😀".repeat(3)) === false, "an emoji is not a tag letter");
  assert.equal(names(`#${"a".repeat(MAX_TAG_CHARS + 1)}`).length, 0);
  assert.equal(names(`#${"a".repeat(MAX_TAG_CHARS)}`).length, 1);
});

test("hostile text is read quickly and never throws", () => {
  const started = Date.now();
  assert.equal(findTags("#a ".repeat(100000)).length, MAX_TAGS);
  for (const text of ["`".repeat(100000), "#".repeat(100000), "# ".repeat(100000), `#${"a".repeat(1000000)}`, "é#é".repeat(1000), "\\".repeat(100001), "\0#\0", "[[#".repeat(50000)]) findTags(text);
  assert.ok(Date.now() - started < 5000, `${Date.now() - started} ms`);
});

test("withoutTags leaves the rest of the text and marks where each tag was", () => {
  assert.equal(withoutTags("a #one b #two/x."), "a x b x.");
  assert.equal(withoutTags("no tag here"), "no tag here");
  assert.equal(withoutTags("`#code` #real"), "`#code` x");
  assert.ok(hasTags("x #y") && !hasTags("x # y") && !hasTags("a#b"));
});

test("two texts have the same tags only when the names and their order match", () => {
  assert.ok(sameTags("a #x b #y", "#x and #y"));
  assert.ok(!sameTags("#x", "\\#x"));
  assert.ok(!sameTags("#x #y", "#y #x"));
  assert.ok(!sameTags("#Plan", "#plan"));
});
