import test from "node:test";
import assert from "node:assert/strict";
import { actionLabel, inkAction, pageAction, previewLines, previewTotal, reportLine, sameEntries, statusLineText } from "../web/syncrules.js";
import { strings } from "../web/strings.js";

const lines = strings.syncLine;
const text = strings.settings;
const on = { problem: null, enabled: true, paused: false, syncing: null, peers: [{ id: "a" }], events: [] };

test("the status line is empty when there is nothing to say", () => {
  assert.equal(statusLineText(null, lines), "");
  assert.equal(statusLineText({ ...on, problem: "keys" }, lines), "");
  assert.equal(statusLineText({ ...on, enabled: false }, lines), "");
  assert.equal(statusLineText({ ...on, peers: [] }, lines), "", "no paired device, nothing to sync");
});

test("the status line says paused, syncing, failed, or what the last sync changed", () => {
  assert.equal(statusLineText({ ...on, paused: true }, lines), "Sync paused");
  assert.equal(statusLineText({ ...on, syncing: { name: "bob", done: 2, total: 9 } }, lines), "Syncing with bob · 2 of 9");
  assert.equal(statusLineText({ ...on, syncing: { name: "bob", done: 0, total: 0 } }, lines), "Syncing with bob");
  assert.equal(statusLineText(on, lines), "Sync is on · not synced yet");
  assert.equal(statusLineText({ ...on, events: [{ kind: "synced", changed: 3 }] }, lines), "Synced · 3 changed");
  assert.equal(statusLineText({ ...on, events: [{ kind: "synced", changed: 0 }] }, lines), "Synced · nothing changed");
  assert.equal(statusLineText({ ...on, events: [{ kind: "syncFailed", changed: 0 }, { kind: "synced", changed: 3 }] }, lines), "Last sync did not finish", "the newest event decides (events come newest first)");
  assert.equal(statusLineText({ ...on, events: [{ kind: "paired", changed: 0 }] }, lines), "Sync is on · not synced yet", "pairing is not a sync");
});

test("a preview is summed up in one sentence per kind and empty kinds are left out", () => {
  const preview = { send: 2, receive: 0, deleteHere: 1, deleteThere: 0, conflicts: 1, clashes: 0, skippedHere: 1, skippedThere: 2, tooBig: ["Huge.bin"] };
  assert.equal(previewTotal(preview), 4);
  const out = previewLines(preview, "bob", text);
  assert.deepEqual(out, ["2 to send to bob", "1 to move to the trash on this device, because bob deleted them", "1 changed on both devices; both versions are kept", "1 too big to sync yet (over 64 MB); left alone", "3 left out because of their name, their size or because they are links"]);
  assert.deepEqual(previewLines({ send: 0, receive: 0, deleteHere: 0, deleteThere: 0, conflicts: 0, clashes: 0, skippedHere: 0, skippedThere: 0, tooBig: [] }, "bob", text), []);
  assert.equal(actionLabel("conflict", text), "both changed");
  assert.equal(actionLabel("unknown", text), "unknown", "an action the screen does not know is shown as it is");
});

test("the report after a sync says what changed and what was left for next time", () => {
  const base = { sent: 1, received: 2, deletedHere: 0, deletedThere: 0, conflicts: 0, leftForNext: 0 };
  assert.equal(reportLine(base, "bob", text), "Synced with bob: 3 changed.");
  assert.equal(reportLine({ ...base, sent: 0, received: 0 }, "bob", text), "Synced with bob: nothing to change.");
  assert.match(reportLine({ ...base, leftForNext: 2 }, "bob", text), /2 changed while syncing and will be done next time/);
});

test("an unchanged page list is recognised so the list is not redrawn", () => {
  const a = [{ path: "A.md", kind: "note" }, { path: "F", kind: "folder" }];
  assert.equal(sameEntries(a, [...a]), true);
  assert.equal(sameEntries(a, a.slice(0, 1)), false);
  assert.equal(sameEntries(a, [{ path: "A.md", kind: "note" }, { path: "F", kind: "note" }]), false);
  assert.equal(sameEntries([], []), true);
});

test("an open page is only replaced when it changed on disk and nothing of it is unsaved", () => {
  assert.equal(pageAction({ onDisk: "v1", shown: "v1", busy: false }), "keep");
  assert.equal(pageAction({ onDisk: "v1", shown: "v1", busy: true }), "keep");
  assert.equal(pageAction({ onDisk: "v2", shown: "v1", busy: false }), "reload");
  assert.equal(pageAction({ onDisk: "v2", shown: "v1", busy: true }), "wait", "while typing, the save notices and keeps both texts");
});

test("ink over the open page is read again when only its drawing file changed on disk", () => {
  assert.equal(inkAction({ onDisk: "v2", shown: "v1", loaded: true, busy: false }), "load", "new ink from a sync");
  assert.equal(inkAction({ onDisk: "v1", shown: "v1", loaded: true, busy: false }), "keep");
  assert.equal(inkAction({ onDisk: null, shown: "v1", loaded: true, busy: false }), "load", "the drawing file was removed elsewhere");
  assert.equal(inkAction({ onDisk: "v1", shown: null, loaded: false, busy: false }), "load", "a page without ink here gets its first ink from elsewhere");
  assert.equal(inkAction({ onDisk: "v2", shown: "v1", loaded: true, busy: true }), "wait", "ink being drawn or saved is never replaced");
});
