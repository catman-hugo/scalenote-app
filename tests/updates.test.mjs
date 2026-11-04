// Tests the real update-check functions with a pretend GitHub answer (no network is used).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { checkForUpdate, compareVersions, newestRelease, parseVersion, readLimited, RELEASE_PAGE, RELEASES_URL, safeReleaseUrl, shouldCheck, CHECK_EVERY_MS } from "../web/updates.js";

const release = (tag, extra = {}) => ({ tag_name: tag, html_url: `${RELEASE_PAGE}/tag/${tag}`, body: `notes for ${tag}`, draft: false, prerelease: false, ...extra });
const answer = (body, init = {}) => async () => new Response(typeof body === "string" ? body : JSON.stringify(body), { status: 200, ...init });

test("versions are read strictly and compared as numbers", () => {
  assert.deepEqual(parseVersion("v0.10.2"), [0, 10, 2]);
  assert.equal(parseVersion("0.2.0-beta.1"), null);
  assert.equal(parseVersion("latest"), null);
  assert.equal(parseVersion("1.2"), null);
  assert.equal(compareVersions([0, 10, 0], [0, 9, 9]), 1);
  assert.equal(compareVersions([0, 2, 0], [0, 2, 0]), 0);
});

test("the newest published release above the current one wins; drafts, pre-releases and odd tags are ignored", () => {
  const list = [release("v0.3.0", { draft: true }), release("v0.2.5", { prerelease: true }), release("v0.2.1"), release("v0.2.0"), release("v0.10.0"), release("nightly"), null, 5];
  const found = newestRelease(list, "0.2.0");
  assert.equal(found.version, "0.10.0");
  assert.equal(newestRelease(list, "0.10.0"), null);
  assert.equal(newestRelease("not a list", "0.1.0"), null);
  assert.equal(newestRelease(list, "garbage"), null);
});

test("only addresses on the project's releases page can be opened", () => {
  assert.equal(safeReleaseUrl(`${RELEASE_PAGE}/tag/v0.2.0`), `${RELEASE_PAGE}/tag/v0.2.0`);
  for (const bad of ["https://example.com/x", "javascript:alert(1)", `${RELEASE_PAGE}/x" onclick="y`, `${RELEASE_PAGE}evil/x`, "", null, 7]) assert.equal(safeReleaseUrl(bad), RELEASE_PAGE);
  assert.equal(newestRelease([release("v0.3.0", { html_url: "https://example.com/phish" })], "0.2.0").url, RELEASE_PAGE);
});

test("release notes from the internet are kept as plain text and cut to a limit", () => {
  const found = newestRelease([release("v0.3.0", { body: "<img src=x onerror=alert(1)>" + "a".repeat(20000) })], "0.2.0");
  assert.ok(found.notes.startsWith("<img"), "kept as text, not interpreted");
  assert.equal(found.notes.length, 8000);
  assert.equal(newestRelease([release("v0.3.0", { body: { evil: true } })], "0.2.0").notes, "");
});

test("the request asks only for the public list and sends nothing else", async () => {
  let seen;
  const fetchImpl = async (url, init) => {
    seen = { url, init };
    return new Response("[]", { status: 200 });
  };
  const result = await checkForUpdate({ current: "0.2.0", fetchImpl });
  assert.equal(result.release, null);
  assert.equal(seen.url, RELEASES_URL);
  assert.equal(seen.init.method, "GET");
  assert.equal(seen.init.credentials, "omit");
  assert.equal(seen.init.referrerPolicy, "no-referrer");
  assert.equal(seen.init.body, undefined);
  assert.deepEqual(Object.keys(seen.init.headers), ["Accept"]);
  assert.equal(new URL(seen.url).search, "?per_page=20");
});

test("a newer release is found through the real check function", async () => {
  const result = await checkForUpdate({ current: "0.2.0", fetchImpl: answer([release("v0.2.1"), release("v0.2.0")]) });
  assert.equal(result.release.version, "0.2.1");
});

test("failures reject instead of guessing: error status, broken json, huge answer, slow answer", async () => {
  await assert.rejects(checkForUpdate({ current: "0.2.0", fetchImpl: async () => new Response("no", { status: 403 }) }));
  await assert.rejects(checkForUpdate({ current: "0.2.0", fetchImpl: answer("{not json") }));
  await assert.rejects(checkForUpdate({ current: "0.2.0", fetchImpl: answer("x".repeat(600 * 1024)) }));
  await assert.rejects(checkForUpdate({ current: "0.2.0", fetchImpl: answer("[]", { headers: { "content-length": "99999999" } }) }));
  const slow = (url, { signal }) => new Promise((_, reject) => signal.addEventListener("abort", () => reject(new Error("aborted"))));
  await assert.rejects(checkForUpdate({ current: "0.2.0", fetchImpl: slow, timeoutMs: 20 }), /aborted/);
});

test("a streamed answer is cut off at the limit without reading all of it", async () => {
  let pulled = 0;
  const stream = new ReadableStream({ pull(controller) { pulled++; controller.enqueue(new Uint8Array(100 * 1024)); } });
  await assert.rejects(readLimited(new Response(stream), 300 * 1024), /too large/);
  assert.ok(pulled < 10, "stopped early, pulled " + pulled);
});

test("the check runs at most every 12 hours, and never when switched off", () => {
  const now = 1_000_000_000_000;
  assert.equal(shouldCheck({ enabled: false, lastCheck: 0, now }), false);
  assert.equal(shouldCheck({ enabled: true, lastCheck: 0, now }), true);
  assert.equal(shouldCheck({ enabled: true, lastCheck: now - 1000, now }), false);
  assert.equal(shouldCheck({ enabled: true, lastCheck: now - CHECK_EVERY_MS - 1, now }), true);
  assert.equal(shouldCheck({ enabled: true, lastCheck: now + 5000, now }), true, "a clock set back does not block checking forever");
});

test("every place that holds the version says the same thing", () => {
  const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
  const tauri = JSON.parse(fs.readFileSync(new URL("../src-tauri/tauri.conf.json", import.meta.url), "utf8")).version;
  const cargo = (file) => /^version = "([^"]+)"/m.exec(fs.readFileSync(new URL(file, import.meta.url), "utf8"))[1];
  assert.equal(tauri, pkg);
  assert.equal(cargo("../src-tauri/Cargo.toml"), pkg);
  assert.equal(cargo("../src-tauri/core/Cargo.toml"), pkg);
});
