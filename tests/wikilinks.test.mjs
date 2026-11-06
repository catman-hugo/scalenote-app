// The editor's version of the link rules, checked against the cases shared with the Rust code.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createResolver, findWikilinks, hasWikilinks, linkLabel, linkNameFor, parseInner, sameWikilinks, withoutWikilinks } from "../web/wikilinkrules.js";

const squash = (text) => text.split(/\s+/).filter(Boolean).join(" ");

test("the shared cases give the same answers as the Rust code", () => {
  let pages = [];
  let parsed = 0;
  let resolved = 0;
  for (const raw of readFileSync(new URL("./fixtures/wikilinks.txt", import.meta.url), "utf8").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    if (line.startsWith("pages =")) pages = line.slice(7).split(",").map((p) => p.trim());
    else if (line.startsWith("parse ")) {
      const [input, expected] = line.slice(6).split(" => ");
      const got = parseInner(input);
      const text = got ? `${got.page} | ${got.anchor ?? ""} | ${got.alias ?? ""}` : "none";
      assert.equal(squash(text), squash(expected), `parse ${input}`);
      parsed++;
    } else if (line.startsWith("resolve ")) {
      const [head, expected] = line.slice(8).split(" -> ");
      const at = head.indexOf(" | ");
      const got = createResolver(pages).resolve(head.slice(at + 3), head.slice(0, at)) ?? "(none)";
      assert.equal(got, expected.trim(), `resolve ${head}`);
      resolved++;
    }
  }
  assert.ok(parsed >= 8 && resolved >= 12, `${parsed} ${resolved}`);
});

const shape = (text) => findWikilinks(text).map((l) => [l.page, l.anchor, l.alias, l.embed]);

test("finds every form of link, with exact positions", () => {
  assert.deepEqual(shape("a [[Plan]] b [[Plan|the plan]] c [[Plan#Goals]] d [[Plan#^abc-1]] e [[#Here]] f ![[Picture]]"), [
    ["Plan", null, null, false], ["Plan", null, "the plan", false], ["Plan", "Goals", null, false],
    ["Plan", "^abc-1", null, false], ["", "Here", null, false], ["Picture", null, null, true],
  ]);
  const text = "héllo [[Plan|x]] and ![[Pic]].";
  const [first, second] = findWikilinks(text);
  assert.equal(text.slice(first.start, first.end), "[[Plan|x]]");
  assert.equal(text.slice(second.start, second.end), "[[Pic]]");
});

test("code, escapes and broken brackets are not links", () => {
  const found = shape("`[[a]]` and ``[[b]]`` and [[c]]\n```\n[[d]]\n```\n    ~~~\n[[e]]\n~~~\n[[f]]\n~~~\n[[g]]\n").map((l) => l[0]);
  assert.deepEqual(found, ["c", "e", "g"]);
  for (const text of ["[[", "[[]]", "[[ ]]", "[[a", "[[a]", "[[a\nb]]", "[[a[b]]", "[ [a]]", "[[#]]", "[[|x]]", "\\[[a]]"]) assert.deepEqual(shape(text), [], text);
  assert.deepEqual(shape("[[[a]]]"), [["a", null, null, false]]);
  assert.equal(shape(`[[${"a".repeat(301)}]]`).length, 0);
  assert.equal(shape(`[[${"a".repeat(300)}]]`).length, 1);
  assert.deepEqual(shape("| [[Plan\\|alias]] |"), [["Plan", null, "alias", false]]);
});

test("hostile text is read quickly and never throws", () => {
  const started = Date.now();
  assert.equal(findWikilinks("[[a]]".repeat(100000)).length, 5000);
  for (const text of ["`".repeat(100000), "[[".repeat(100000), "[[a".repeat(50000), "é[[é]]é".repeat(1000), "\0[[\0]]", "\\".repeat(100001)]) findWikilinks(text);
  assert.ok(Date.now() - started < 5000, `${Date.now() - started} ms`);
});

test("plain links can be taken out of a text; embeds stay", () => {
  assert.equal(withoutWikilinks("see [[a]] and ![[b]] and [[c|d]]"), "see x  and ![[b]] and x ");
  assert.equal(hasWikilinks("no links [here]"), false);
  assert.equal(hasWikilinks("a [[b]]"), true);
  assert.ok(sameWikilinks("[[a]] x [[b|c]]", "[[a]] y [[b|c]]"));
  assert.ok(!sameWikilinks("[[a]]", "\\[\\[a]]"));
});

test("names written into new links and the text shown", () => {
  const pages = ["A/Plan.md", "B/Plan.md", "Home.md"];
  const resolver = createResolver(pages);
  assert.equal(linkNameFor("Home.md", "A/x.md", resolver), "Home");
  assert.equal(linkNameFor("B/Plan.md", "A/x.md", resolver), "B/Plan"); // "Plan" would mean A/Plan.md
  assert.equal(linkNameFor("A/Plan.md", "A/x.md", resolver), "Plan");
  assert.equal(linkLabel({ page: "School/Plan", anchor: "Goals", alias: null }), "Plan › Goals");
  assert.equal(linkLabel({ page: "Plan", anchor: null, alias: "the plan" }), "the plan");
  assert.equal(linkLabel({ page: "", anchor: "Here", alias: null }), "Here");
});
