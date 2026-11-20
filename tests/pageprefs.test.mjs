// Each page remembers its view and its "Linked from" list on this device.
import test from "node:test";
import assert from "node:assert/strict";
import { MAX_PAGES, cleanPagePrefs, movePages, prefsOf, rememberPage } from "../web/pageprefs.js";

const fallback = { view: "text", linkedFrom: false };

test("a page opens in the view it was left in, and anything it does not remember comes from Settings", () => {
  let prefs = {};
  assert.deepEqual(prefsOf(prefs, "Notes/A.md", fallback), { view: "text", linkedFrom: false });
  prefs = rememberPage(prefs, "Notes/A.md", { view: "split" }, 1);
  assert.deepEqual(prefsOf(prefs, "Notes/A.md", fallback), { view: "split", linkedFrom: false });
  prefs = rememberPage(prefs, "Notes/A.md", { linkedFrom: true }, 2);
  assert.deepEqual(prefsOf(prefs, "Notes/A.md", fallback), { view: "split", linkedFrom: true }, "both are kept");
  assert.deepEqual(prefsOf(prefs, "Notes/B.md", { view: "canvas", linkedFrom: false }), { view: "canvas", linkedFrom: false });
  assert.equal(rememberPage(prefs, "Notes/A.md", { view: "sideways" }, 3)["Notes/A.md"].view, "split", "an unknown view is ignored");
});

test("moving a page or a folder takes what its pages remember along, and a deleted page is dropped", () => {
  let prefs = rememberPage({}, "School/Bio.md", { view: "canvas" }, 1);
  prefs = rememberPage(prefs, "School/Old/Chem.md", { linkedFrom: true }, 2);
  prefs = rememberPage(prefs, "Schoolwork.md", { view: "split" }, 3);
  const moved = movePages(prefs, "School", "Year 2");
  assert.deepEqual(Object.keys(moved).sort(), ["Schoolwork.md", "Year 2/Bio.md", "Year 2/Old/Chem.md"], "a page whose name only starts the same stays");
  assert.deepEqual(Object.keys(movePages(moved, "Year 2/Bio.md", null)).sort(), ["Schoolwork.md", "Year 2/Old/Chem.md"]);
});

test("the settings file is read as untrusted, and only the newest pages are kept", () => {
  const read = cleanPagePrefs({ "A.md": { view: "split", at: 5 }, "B.md": { view: 7, linkedFrom: "yes" }, "": { view: "text" }, "C.md": null, "D.md": { linkedFrom: false } });
  assert.deepEqual(read, { "A.md": { view: "split", at: 5 }, "D.md": { linkedFrom: false, at: 0 } });
  assert.deepEqual(cleanPagePrefs([1, 2]), {});
  assert.deepEqual(cleanPagePrefs(null), {});
  let prefs = {};
  for (let i = 0; i <= MAX_PAGES; i++) prefs = rememberPage(prefs, `P${i}.md`, { view: "split" }, i + 1);
  assert.equal(Object.keys(prefs).length, MAX_PAGES);
  assert.equal(prefs["P0.md"], undefined, "the page not touched longest is dropped");
  assert.ok(prefs[`P${MAX_PAGES}.md`]);
});
