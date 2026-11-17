import test from "node:test";
import assert from "node:assert/strict";
import { cleanLastPage, resetSettings, RESETTABLE } from "../web/startrules.js";

test("the last page is read only as a folder and a page path of plain text", () => {
  assert.deepEqual(cleanLastPage({ vault: "/home/alice/Notes", path: "School/A.md" }), { vault: "/home/alice/Notes", path: "School/A.md" });
  for (const bad of [null, "x", 5, {}, { vault: "v" }, { path: "A.md" }, { vault: "", path: "A.md" }, { vault: "v", path: "A.txt" }, { vault: "v", path: "../A.md" }, { vault: "v", path: "a/../b.md" }, { vault: "v", path: "A\n.md" }, { vault: "v", path: "x".repeat(2000) + ".md" }, { vault: "v\u0000", path: "A.md" }]) {
    assert.equal(cleanLastPage(bad), null, JSON.stringify(bad).slice(0, 40));
  }
});

test("Reset to defaults changes the look and page settings and nothing else", () => {
  const before = {
    vaultPath: "/home/alice/Notes", recentVaults: ["/a"], disclosureAccepted: true, wifiOnly: ["x"], lastSeenVersion: "0.5.3", lastUpdateCheck: 5, dismissedUpdate: "9.9.9", lastPage: { vault: "v", path: "A.md" },
    theme: "black", fontSize: 125, editorWidth: "full", sidebarWidth: 400, updates: false, showBacklinks: false, showCovers: true, penButton: "pan", openIn: "canvas", snapShapes: false, reopenLast: false, showWhatsNew: false,
  };
  const after = resetSettings(before);
  for (const key of Object.keys(RESETTABLE)) assert.equal(after[key], RESETTABLE[key], key);
  for (const key of ["vaultPath", "recentVaults", "disclosureAccepted", "wifiOnly", "lastSeenVersion", "lastUpdateCheck", "dismissedUpdate", "lastPage"]) assert.deepEqual(after[key], before[key], key);
  assert.equal(after.theme, "system");
  assert.notEqual(after, before);
});
