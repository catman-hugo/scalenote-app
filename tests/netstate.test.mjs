import test from "node:test";
import assert from "node:assert/strict";
import { cleanWifiOnly, withWifiOnly, onWifi, canTellNetwork, MAX_WIFI_ONLY } from "../web/netstate.js";

const A = "a".repeat(64);
const B = "b".repeat(64);

test("the saved list keeps only device ids, once each, and not too many", () => {
  assert.deepEqual(cleanWifiOnly([A, A, "nope", 5, null, "A".repeat(64), B]), [A, B]);
  assert.deepEqual(cleanWifiOnly("x"), []);
  assert.deepEqual(cleanWifiOnly(undefined), []);
  const many = Array.from({ length: 40 }, (_, i) => i.toString(16).padStart(64, "0"));
  assert.equal(cleanWifiOnly(many).length, MAX_WIFI_ONLY);
});

test("turning the limit on and off adds and removes the id", () => {
  assert.deepEqual(withWifiOnly([], A, true), [A]);
  assert.deepEqual(withWifiOnly([A], B, true), [A, B]);
  assert.deepEqual(withWifiOnly([A, B], A, false), [B]);
  assert.deepEqual(withWifiOnly([A], A, true), [A]);
});

test("where the system cannot say, the answer is Wi-Fi so nothing is blocked", () => {
  assert.equal(canTellNetwork(), false);
  assert.equal(onWifi(), true);
});
