import test from "node:test";
import assert from "node:assert/strict";
import { createNavHistory, MAX_ENTRIES } from "../web/navhistory.js";

test("pages opened one after another can be walked back and forward", () => {
  const nav = createNavHistory();
  assert.equal(nav.visit("A.md"), 0);
  assert.equal(nav.visit("B.md"), 1);
  assert.equal(nav.visit("C.md"), 2);
  assert.equal(nav.canBack(), true);
  assert.equal(nav.canForward(), false);
  assert.equal(nav.goto(1), "B.md");
  assert.equal(nav.canForward(), true);
  assert.equal(nav.goto(0), "A.md");
  assert.equal(nav.canBack(), false);
  assert.equal(nav.goto(2), "C.md");
});

test("opening the page that is already shown adds nothing", () => {
  const nav = createNavHistory();
  nav.visit("A.md");
  assert.equal(nav.visit("A.md"), null);
  assert.equal(nav.length, 1);
});

test("opening a new page after going back drops the pages that were ahead", () => {
  const nav = createNavHistory();
  for (const p of ["A.md", "B.md", "C.md"]) nav.visit(p);
  nav.goto(0);
  assert.equal(nav.visit("D.md"), 1);
  assert.equal(nav.length, 2);
  assert.equal(nav.canForward(), false);
  assert.equal(nav.goto(2), null);
});

test("a position that does not exist is refused and changes nothing", () => {
  const nav = createNavHistory();
  nav.visit("A.md");
  nav.visit("B.md");
  for (const bad of [-1, 5, 1.5, NaN, "1", undefined, null]) assert.equal(nav.goto(bad), null);
  assert.equal(nav.position, 1);
});

test("a renamed page keeps its place in the history", () => {
  const nav = createNavHistory();
  nav.visit("A.md");
  nav.visit("B.md");
  nav.visit("A.md");
  nav.remap((p) => (p === "A.md" ? "Z.md" : p));
  assert.equal(nav.goto(0), "Z.md");
  assert.equal(nav.goto(2), "Z.md");
});

test("the list stops growing at its limit instead of using memory without end", () => {
  const nav = createNavHistory();
  for (let i = 0; i < MAX_ENTRIES + 50; i++) nav.visit(`P${i}.md`);
  assert.equal(nav.length, MAX_ENTRIES);
});
