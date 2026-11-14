import test from "node:test";
import assert from "node:assert/strict";
import { groupCode, timeLeftText } from "../web/syncpairrules.js";

test("a code of 8 digits is shown in two groups of four, anything else is left alone", () => {
  assert.equal(groupCode("12345678"), "1234 5678");
  assert.equal(groupCode("123"), "123");
  assert.equal(groupCode(""), "");
});

test("the time left is shown as minutes and two-digit seconds", () => {
  assert.equal(timeLeftText(120), "2:00");
  assert.equal(timeLeftText(65), "1:05");
  assert.equal(timeLeftText(0), "0:00");
});
