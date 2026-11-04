import test from "node:test";
import assert from "node:assert/strict";
import { normalizeUrl } from "../web/links.js";

test("web and mail addresses are accepted, other schemes are refused", () => {
  assert.equal(normalizeUrl("https://example.local/a?b=1"), "https://example.local/a?b=1");
  assert.equal(normalizeUrl("HTTP://example.local"), "HTTP://example.local");
  assert.equal(normalizeUrl("mailto:alice@example.local"), "mailto:alice@example.local");
  assert.equal(normalizeUrl("javascript:alert(1)"), null);
  assert.equal(normalizeUrl("JaVaScRiPt:alert(1)"), null);
  assert.equal(normalizeUrl("data:text/html,x"), null);
  assert.equal(normalizeUrl("file:///etc/passwd"), null);
  assert.equal(normalizeUrl("vbscript:x"), null);
});

test("plain domains get https, and bad input is refused", () => {
  assert.equal(normalizeUrl("example.local"), "https://example.local");
  assert.equal(normalizeUrl("example.local:8080/x"), "https://example.local:8080/x");
  assert.equal(normalizeUrl("#heading"), "#heading");
  assert.equal(normalizeUrl(""), null);
  assert.equal(normalizeUrl("two words"), null);
  assert.equal(normalizeUrl("a".repeat(2001)), null);
  assert.equal(normalizeUrl(null), null);
});
