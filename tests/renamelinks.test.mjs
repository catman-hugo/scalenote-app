import test from "node:test";
import assert from "node:assert/strict";
import { rewriteLinks } from "../web/renamelinks.js";

const PAGES = ["Cells.md", "Bio/Organs.md", "Other/Organs.md", "Notes.md"];
const rename = (text, extra = {}) => rewriteLinks(text, { pages: PAGES, oldPath: "Cells.md", newPath: "Cell biology.md", from: "Notes.md", ...extra });

test("a link to the page gets the new name, with heading, shown text and embed marker kept", () => {
  assert.equal(rename("see [[Cells]] and [[cells#Membrane|the membrane]] and [[Cells#^abc]] and ![[Cells]]"),
    "see [[Cell biology]] and [[Cell biology#Membrane|the membrane]] and [[Cell biology#^abc]] and ![[Cell biology]]");
});

test("nothing else in the text changes, and a text with no link to the page gives null", () => {
  assert.equal(rename("no links here\n"), null);
  assert.equal(rename("[[Notes]] and [[Cellsabc]] and [[#heading]] and `[[Cells]]`\n\n```\n[[Cells]]\n```\n"), null);
  assert.equal(rename("  odd   [[ Cells ]]  spacing\n"), "  odd   [[ Cell biology ]]  spacing\n");
});

test("a link written with folders or with .md keeps that form", () => {
  const pages = ["Bio/Cells.md", "Notes.md"];
  const opts = { pages, oldPath: "Bio/Cells.md", newPath: "Bio/Cell biology.md", from: "Notes.md" };
  assert.equal(rewriteLinks("[[Bio/Cells]] [[Cells.md]] [[Cells]]", opts), "[[Bio/Cell biology]] [[Cell biology.md]] [[Cell biology]]");
});

test("only links that meant this page change: the same name in another folder stays", () => {
  const pages = ["A/Same.md", "B/Same.md", "A/Home.md", "B/Home.md"];
  const opts = { pages, oldPath: "A/Same.md", newPath: "A/Renamed.md" };
  // From A, [[Same]] meant A/Same (same folder wins); from B it meant B/Same.
  assert.equal(rewriteLinks("[[Same]]", { ...opts, from: "A/Home.md" }), "[[Renamed]]");
  assert.equal(rewriteLinks("[[Same]]", { ...opts, from: "B/Home.md" }), null);
});

test("if the new name would mean another page, the link is written with its folder", () => {
  const pages = ["Old.md", "Sub/New.md", "Notes.md"];
  const out = rewriteLinks("[[Old]]", { pages, oldPath: "Old.md", newPath: "New.md", from: "Notes.md" });
  assert.equal(out, "[[New]]", "root New is the one the short name finds");
  const pages2 = ["Sub/Old.md", "New.md", "Notes.md"];
  assert.equal(rewriteLinks("[[Old]]", { pages: pages2, oldPath: "Sub/Old.md", newPath: "Sub/New.md", from: "Notes.md" }), "[[Sub/New]]");
});

test("a table cell link with an escaped bar keeps it", () => {
  assert.equal(rename("| [[Cells\\|cell]] |"), "| [[Cell biology\\|cell]] |");
});

test("the renamed page's own links to itself are rewritten", () => {
  assert.equal(rewriteLinks("self [[Cells#Top]]", { pages: PAGES, oldPath: "Cells.md", newPath: "Cell biology.md", from: "Cells.md", fromAfter: "Cell biology.md" }), "self [[Cell biology#Top]]");
});

test("random texts: only link names change, and renaming back restores the text", () => {
  let seed = 7;
  const rand = (n) => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) % n);
  const bits = ["[[Cells]]", "[[Cells#h|x]]", "![[Cells]]", "[[Notes]]", "text", " ", "\n", "`[[Cells]]`", "[[", "]]", "[[Bio/Organs]]", "[[cells]]"];
  for (let round = 0; round < 2000; round++) {
    const text = Array.from({ length: rand(12) }, () => bits[rand(bits.length)]).join("");
    const out = rename(text);
    if (out === null) continue;
    const back = rewriteLinks(out, { pages: PAGES.map((p) => (p === "Cells.md" ? "Cell biology.md" : p)), oldPath: "Cell biology.md", newPath: "Cells.md", from: "Notes.md" });
    // The case of a link written as [[cells]] comes back as the page's own spelling.
    assert.equal((back ?? out).toLowerCase(), text.toLowerCase().replace(/\[\[cells/g, "[[cells"), JSON.stringify(text));
  }
});
