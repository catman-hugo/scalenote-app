import test from "node:test";
import assert from "node:assert/strict";
import { COLOURS, COLOUR_HEX, STYLES, parseIcons, readEntry, withIcon, withRenamed } from "../web/foldericons.js";

test("every colour has a picture colour and the list has OneNote's sixteen", () => {
  assert.equal(COLOURS.length, 16);
  for (const name of COLOURS) assert.match(COLOUR_HEX[name], /^#[0-9a-f]{6}$/);
  assert.deepEqual(STYLES, ["folder", "notebook", "line"]);
});

test("no file means the normal look and a file that can be written", () => {
  const parsed = parseIcons(null);
  assert.deepEqual(parsed.icons, {});
  assert.equal(parsed.readOnly, false);
});

test("choosing a look writes only that folder and reads back", () => {
  const first = withIcon(parseIcons(null), "School", "notebook", "blue");
  const second = withIcon(parseIcons(first), "School/Maths", "line", "redChalk");
  const parsed = parseIcons(second);
  assert.deepEqual(parsed.icons, {
    School: { style: "notebook", colour: "blue" },
    "School/Maths": { style: "line", colour: "redChalk" },
  });
  assert.equal(JSON.parse(second).format, 1);
});

test("the normal look removes the entry", () => {
  const set = withIcon(parseIcons(null), "School", "line", "red");
  const reset = withIcon(parseIcons(set), "School", "folder", "none");
  assert.deepEqual(parseIcons(reset).icons, {});
});

test("a style without a colour, and a colour on the plain folder, are both fine", () => {
  const text = withIcon(parseIcons(null), "A", "line", "none");
  assert.deepEqual(parseIcons(text).icons.A, { style: "line", colour: "none" });
  const text2 = withIcon(parseIcons(null), "B", "folder", "teal");
  assert.deepEqual(parseIcons(text2).icons.B, { style: "folder", colour: "teal" });
});

test("unknown values are ignored when drawing but kept when another folder changes", () => {
  const file = JSON.stringify({ format: 1, icons: { X: { style: "star", colour: "blue" }, Y: { style: "line", colour: "red" } } });
  const parsed = parseIcons(file);
  assert.deepEqual(Object.keys(parsed.icons), ["Y"]);
  const after = JSON.parse(withIcon(parsed, "Z", "notebook", "green"));
  assert.deepEqual(after.icons.X, { style: "star", colour: "blue" });
  assert.deepEqual(after.icons.Z, { style: "notebook", colour: "green" });
});

test("bad values are refused when writing", () => {
  const parsed = parseIcons(null);
  assert.equal(withIcon(parsed, "A", "star", "blue"), null);
  assert.equal(withIcon(parsed, "A", "line", "pink"), null);
  assert.equal(withIcon(parsed, "", "line", "red"), null);
  assert.equal(withIcon(parsed, "x".repeat(2000), "line", "red"), null);
});

test("broken, newer and odd files are read-only and show nothing", () => {
  for (const text of ["{", "[]", "null", "{\"format\":2,\"icons\":{}}", "{\"format\":1}", "{\"format\":1,\"icons\":[]}", "{\"format\":0,\"icons\":{}}"]) {
    const parsed = parseIcons(text);
    assert.equal(parsed.readOnly, true, text);
    assert.deepEqual(parsed.icons, {});
    assert.equal(withIcon(parsed, "A", "line", "red"), null);
  }
});

test("special names do not break anything", () => {
  const names = ["__proto__", "constructor", "a/b c/ü", "😀", "x".repeat(1024)];
  let text = null;
  for (const name of names) text = withIcon(parseIcons(text), name, "line", "red") ?? text;
  const parsed = parseIcons(text);
  for (const name of names) assert.deepEqual(Object.getOwnPropertyDescriptor(parsed.icons, name).value, { style: "line", colour: "red" }, name);
  assert.equal(({}).polluted, undefined);
});

test("entries from a huge file are capped and bad entry shapes are skipped", () => {
  const icons = {};
  for (let i = 0; i < 6000; i++) icons[`f${i}`] = { style: "line", colour: "red" };
  const parsed = parseIcons(JSON.stringify({ format: 1, icons }));
  assert.equal(Object.keys(parsed.icons).length, 5000);
  assert.equal(readEntry("line"), null);
  assert.equal(readEntry([]), null);
  assert.equal(readEntry(null), null);
});

test("renaming or moving a folder carries its entry and the entries inside it", () => {
  let text = withIcon(parseIcons(null), "School", "notebook", "blue");
  text = withIcon(parseIcons(text), "School/Maths", "line", "red");
  text = withIcon(parseIcons(text), "Schools", "line", "green");
  const moved = parseIcons(withRenamed(parseIcons(text), "School", "Uni/School"));
  assert.deepEqual(Object.keys(moved.icons).sort(), ["Schools", "Uni/School", "Uni/School/Maths"]);
  assert.equal(withRenamed(parseIcons(text), "Nothing", "Else"), null);
  assert.equal(withRenamed(parseIcons("{"), "A", "B"), null);
});
