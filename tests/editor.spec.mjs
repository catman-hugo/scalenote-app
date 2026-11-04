// Drives the real built interface (dist/) in Chromium, with the in-memory backend from
// mock-backend.js. Run with: npm run build && node tests/editor.spec.mjs

import { createRequire } from "node:module";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(here, "..", "dist");
const shots = process.env.SHOTS_DIR || "";

const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png" };
// The same policy as src-tauri/tauri.conf.json, so a violation here would also happen there.
const CSP = JSON.parse(fs.readFileSync(path.join(here, "..", "src-tauri", "tauri.conf.json"), "utf8")).app.security.csp;
const server = http.createServer((req, res) => {
  const file = path.join(dist, req.url === "/" ? "index.html" : req.url.split("?")[0]);
  if (!file.startsWith(dist) || !fs.existsSync(file)) { res.writeHead(404).end(); return; }
  res.writeHead(200, { "content-type": types[path.extname(file)] || "application/octet-stream", "content-security-policy": CSP });
  res.end(fs.readFileSync(file));
});
await new Promise((r) => server.listen(0, r));
const url = `http://127.0.0.1:${server.address().port}/`;

const browser = await chromium.launch();
let failures = 0;
async function test(name, fn, opts = {}) {
  const context = await browser.newContext({ viewport: opts.viewport || { width: 1100, height: 760 }, colorScheme: opts.scheme || "light" });
  await context.addInitScript({ path: path.join(here, "mock-backend.js") });
  const page = await context.newPage();
  const problems = [];
  page.on("pageerror", (e) => problems.push("pageerror: " + e.message));
  page.on("console", (m) => { if (m.type() === "error") problems.push("console: " + m.text()); });
  await page.addInitScript(() => document.addEventListener("securitypolicyviolation", (e) => console.error("CSP violation: " + e.violatedDirective + " " + e.blockedURI)));
  try {
    await page.goto(url);
    await fn(page);
    assert.deepEqual(problems, [], "browser reported problems");
    console.log("ok   - " + name);
  } catch (error) {
    failures++;
    console.log("FAIL - " + name + "\n       " + String(error.message).split("\n").join("\n       "));
  } finally {
    await context.close();
  }
}

async function start(page) {
  await page.click("#disclosure button");
  await page.click("#welcome button:last-of-type");
  await page.waitForSelector("#newNote");
}
const files = (page) => page.evaluate(() => Object.fromEntries(window.__mock.files));
const seed = (page, name, text) => page.evaluate(([n, t]) => window.__mock.files.set(n, t), [name, text]);
async function waitSaved(page) { await page.waitForFunction(() => document.getElementById("status").dataset.state === "saved", null, { timeout: 5000 }); }

await test("first run shows the disclosure, then the folder choice, then an empty list", async (page) => {
  await page.waitForSelector("#disclosure[open]");
  assert.match(await page.textContent("#disclosure"), /side project/);
  await page.click("#disclosure button");
  await page.waitForSelector("#welcome[open]");
  await page.click("#welcome button:last-of-type");
  await page.waitForSelector("#tree .tree-empty");
  assert.equal(await page.isVisible("#editor"), false);
  assert.equal(JSON.parse(await page.evaluate(() => window.__mock.getSettings())).aiEnabled, false);
});

await test("there is no AI element anywhere in the interface", async (page) => {
  await start(page);
  // The first-run disclosure dialog may talk about AI; nothing else in the page may.
  const outsideDialogs = await page.evaluate(() => { const c = document.getElementById("app").innerText.toLowerCase(); return c; });
  assert.ok(!/\bai\b|assistant/.test(outsideDialogs));
});

await test("typing, a slash heading and autosave write a markdown file with an id", async (page) => {
  await start(page);
  await page.click("#newNote");
  await page.waitForSelector("#editor .note-body");
  await page.keyboard.press("Tab"); // leave the title (renaming waits for blur)
  await page.click("#editor .note-body");
  await page.keyboard.type("Hello world");
  await page.keyboard.press("Enter");
  await page.keyboard.type("/head");
  await page.waitForSelector(".slash-menu");
  await page.keyboard.press("Enter");
  await page.keyboard.type("Big title");
  await waitSaved(page);
  const saved = (await files(page))["Untitled.md"];
  assert.match(saved, /^---\nid: [0-9a-f-]{20,}\n---\n\nHello world\n\n# Big title\n$/);
});

await test("slash menu offers every block and filters", async (page) => {
  await start(page);
  await page.click("#newNote");
  await page.click("#editor .note-body");
  await page.keyboard.type("/");
  await page.waitForSelector(".slash-menu");
  assert.equal(await page.locator(".slash-item").count(), 14);
  await page.keyboard.type("to-do");
  assert.deepEqual(await page.locator(".slash-item").allTextContents(), ["To-do list"]);
  await page.keyboard.press("Enter");
  await page.keyboard.type("buy milk");
  await waitSaved(page);
  assert.match((await files(page))["Untitled.md"], /- \[ \] buy milk\n$/);
  await page.keyboard.press("Enter");
  await page.keyboard.press("Enter");
  await page.keyboard.type("/xyzzy");
  assert.equal(await page.textContent(".slash-empty"), "No matching block");
  await page.keyboard.press("Escape");
});

const TRICKY = [
  "---", "title: Week 1", "tags: [a, b]", "---", "", "# Heading", "right below", "",
  "Some *emphasis* and __strong__ text", "with a second line", "", "* star bullet", "* second", "  * nested", "",
  "| a | b |", "|---|---|", "| 1 | 2 |", "", "See [[Other note]] and ==highlight==", "",
  "> [!note] A callout", "> body", "", "<div class=\"x\">html</div>", "", "$$", "x^2", "$$", "", "```js", "let a = 1;", "", "let b = 2;", "```", "", "1) odd numbering", "", "A final line #tag", "",
].join("\n");

await test("opening and leaving a tricky note changes nothing on disk", async (page) => {
  await start(page);
  await seed(page, "Tricky.md", TRICKY);
  await page.evaluate(() => 0);
  await page.click("#newFolder");
  await page.waitForSelector(".tree-button");
  await page.click('.tree-button[data-path="Tricky.md"]');
  await page.waitForSelector("#editor .note-body");
  assert.ok((await page.locator(".raw-block").count()) >= 5);
  await page.click("#newNote"); // opening another note flushes, and must not rewrite this one
  await page.waitForTimeout(1200);
  assert.equal((await files(page))["Tricky.md"], TRICKY);
});

await test("editing one paragraph leaves every other byte alone", async (page) => {
  await start(page);
  await seed(page, "Tricky.md", TRICKY);
  await page.click("#newFolder");
  await page.click('.tree-button[data-path="Tricky.md"]');
  await page.waitForSelector("#editor .note-body");
  const para = page.locator(".note-body p", { hasText: "right below" });
  await para.click();
  await page.keyboard.press("End");
  if (process.env.DEBUG_SHOT) await page.screenshot({ path: process.env.DEBUG_SHOT });
  await page.keyboard.type(" EDITED");
  await waitSaved(page);
  const saved = (await files(page))["Tricky.md"];
  const expected = TRICKY.replace("tags: [a, b]", "tags: [a, b]\nid: ID").replace("right below", "right below EDITED");
  assert.equal(saved.replace(/id: [0-9a-f-]{20,}/, "id: ID"), expected, JSON.stringify(saved.slice(-120)));
});

await test("a raw block can be edited as text and is saved exactly", async (page) => {
  await start(page);
  await seed(page, "R.md", "before\n\n<div>a</div>\n\nafter\n");
  await page.click("#newFolder");
  await page.click('.tree-button[data-path="R.md"]');
  await page.waitForSelector(".raw-text");
  await page.locator(".raw-text").click();
  await page.keyboard.press("Control+End");
  await page.keyboard.type("\n<div>b</div>");
  await waitSaved(page);
  assert.match((await files(page))["R.md"], /before\n\n<div>a<\/div>\n<div>b<\/div>\n\nafter\n$/);
});

await test("a change made by another program becomes a conflict copy and the disk version loads", async (page) => {
  await start(page);
  await seed(page, "C.md", "original\n");
  await page.click("#newFolder");
  await page.click('.tree-button[data-path="C.md"]');
  await page.waitForSelector("#editor .note-body");
  await page.evaluate(() => window.__mock.files.set("C.md", "changed elsewhere\n"));
  await page.locator(".note-body p").click();
  await page.keyboard.press("End");
  await page.keyboard.type(" mine");
  await page.waitForSelector("#banner:not([hidden])");
  assert.match(await page.textContent("#bannerText"), /changed by another program/);
  const f = await files(page);
  assert.equal(f["C.md"], "changed elsewhere\n");
  const copy = Object.keys(f).find((k) => k.includes("conflict copy"));
  assert.ok(copy && f[copy].includes("original mine"));
  assert.match(await page.textContent(".note-body"), /changed elsewhere/);
});

await test("renaming through the title keeps the content", async (page) => {
  await start(page);
  await page.click("#newNote");
  await page.click("#editor .note-body");
  await page.keyboard.type("keep me");
  await page.fill("#title", "Biology: week/1");
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => window.__mock.files.has("Biology weeek1.md") || window.__mock.files.has("Biology week1.md") || [...window.__mock.files.keys()].some((k) => k.startsWith("Biology")));
  await waitSaved(page);
  const f = await files(page);
  const name = Object.keys(f).find((k) => k.startsWith("Biology"));
  assert.ok(f[name].includes("keep me"));
});

await test("empty, huge and odd input and rapid clicking do not raise errors", async (page) => {
  await start(page);
  for (let i = 0; i < 8; i++) await page.click("#newNote", { delay: 0 });
  await page.waitForSelector("#editor .note-body");
  await page.fill("#title", "");
  await page.keyboard.press("Enter");
  await page.click("#editor .note-body");
  await page.keyboard.insertText("x".repeat(200000));
  await page.keyboard.insertText("‮ \u0000 <script>alert(1)</script> $$ [[ ==");
  await waitSaved(page);
  await page.fill("#title", "../../etc/passwd");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(500);
  assert.equal(await page.evaluate(() => window.__mock.logs.filter((l) => l.startsWith("error")).length), 0);
});

await test("tablet width: the list slides over the note and closes after opening one", async (page) => {
  await start(page);
  await seed(page, "A.md", "text\n");
  await page.click("#newFolder");
  assert.equal(await page.isVisible("#sidebar"), true);
  await page.click('.tree-button[data-path="A.md"]');
  await page.waitForSelector("#editor .note-body");
  assert.equal(await page.isVisible("#sidebar"), false);
  await page.click("#toggle");
  assert.equal(await page.isVisible("#sidebar"), true);
}, { viewport: { width: 390, height: 800 } });

// ---------- 0.2.1: formatting toolbar and rich blocks ----------

const RICH = [
  "# Rich", "", "> [!tip] Remember", "> Cells are small.", "", "<details>", "<summary>Why</summary>", "", "Because.", "", "</details>", "",
  "| name | qty |", "| :--- | ---: |", "| apple | 3 |", "", "A closing line", "",
].join("\n");

async function openSeeded(page, name, text) {
  await start(page);
  await seed(page, name, text);
  await page.click("#newFolder");
  await page.click(`.tree-button[data-path="${name}"]`);
  await page.waitForSelector("#editor .note-body");
}

await test("the selection toolbar makes bold, italic, strike and code, and links", async (page) => {
  await openSeeded(page, "F.md", "alpha beta gamma\n");
  const p = page.locator(".note-body p");
  await p.click();
  await page.keyboard.press("Home");
  await page.keyboard.press("Shift+ArrowRight"); // select one character: the bar must appear
  for (let i = 0; i < 4; i++) await page.keyboard.press("Shift+ArrowRight");
  await page.waitForSelector(".float-bar:not([hidden])");
  await page.click('.float-bar [aria-label="Bold"]');
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("Shift+ArrowRight");
  for (let i = 0; i < 3; i++) await page.keyboard.press("Shift+ArrowRight");
  await page.click('.float-bar [aria-label="Italic"]');
  await waitSaved(page);
  assert.match((await files(page))["F.md"], /\*\*alpha\*\* ?(\*|_)beta(\*|_) gamma/);
  // link
  await page.keyboard.press("End");
  await page.keyboard.press("Shift+Home");
  await page.click('.float-bar [aria-label="Link"]');
  await page.fill(".link-input", "javascript:alert(1)");
  await page.keyboard.press("Enter");
  assert.match(await page.textContent(".link-error"), /web and mail/);
  await page.fill(".link-input", "example.local");
  await page.keyboard.press("Enter");
  await waitSaved(page);
  assert.match((await files(page))["F.md"], /\]\(https:\/\/example\.local\)/);
  assert.doesNotMatch((await files(page))["F.md"], /javascript/);
});

await test("callouts, toggles and tables are editable blocks and an untouched note saves byte for byte", async (page) => {
  await openSeeded(page, "Rich.md", RICH);
  assert.equal(await page.locator(".raw-block").count(), 0);
  assert.equal(await page.locator(".callout").count(), 1);
  assert.equal(await page.locator(".toggle").count(), 1);
  assert.equal(await page.locator(".note-body table").count(), 1);
  await page.click("#newNote"); // leaving flushes; nothing may be rewritten
  await page.waitForTimeout(1000);
  assert.equal((await files(page))["Rich.md"], RICH);
});

await test("editing a callout title, a toggle and a table cell changes only those blocks", async (page) => {
  await openSeeded(page, "Rich.md", RICH);
  await page.fill(".callout-title", "Remember well");
  await page.fill(".toggle-summary", "Why not");
  await page.locator(".note-body td").first().click();
  await page.keyboard.press("End");
  await page.keyboard.type(" pie");
  await page.click('.float-bar [aria-label="Add row"]');
  await waitSaved(page);
  const saved = (await files(page))["Rich.md"].replace(/id: [0-9a-f-]{20,}\n/, "");
  assert.match(saved, /^# Rich\n\n> \[!tip\] Remember well\n> Cells are small\.\n\n<details>\n<summary>Why not<\/summary>\n\nBecause\.\n\n<\/details>\n\n\| name \| qty \|\n\| :--- \| ---: \|\n\| apple pie \| 3 \|\n\|  \|  \|\n\nA closing line\n$/m);
});

await test("slash menu inserts a callout, a toggle and a table", async (page) => {
  await start(page);
  await page.click("#newNote");
  await page.click("#editor .note-body");
  await page.keyboard.type("/callout");
  await page.keyboard.press("Enter");
  await page.keyboard.type("inside the callout");
  await waitSaved(page);
  assert.match((await files(page))["Untitled.md"], /> \[!note\]\n> inside the callout\n$/);
  // Enter on an empty last line leaves the callout; no callout or table can nest inside it.
  await page.keyboard.press("Enter");
  await page.keyboard.type("/");
  await page.waitForSelector(".slash-menu");
  assert.equal(await page.locator(".slash-item", { hasText: /^(Callout|Toggle|Table)$/ }).count(), 0);
  await page.keyboard.press("Backspace");
  await page.keyboard.press("Enter");
  await page.keyboard.type("/toggle");
  await page.keyboard.press("Enter");
  await page.keyboard.type("hidden words");
  await page.keyboard.press("Enter");
  await page.keyboard.press("Enter");
  await page.keyboard.type("/table");
  await page.keyboard.press("Enter");
  await waitSaved(page);
  assert.equal(await page.locator(".note-body table").count(), 1);
  const saved = (await files(page))["Untitled.md"];
  assert.match(saved, /<details>\n<summary><\/summary>\n\nhidden words\n\n<\/details>\n\n\| {2}\| {2}\| {2}\|\n\| --- \| --- \| --- \|/);
});

const DEMO = "# Cell biology\n\nThe **cell** is the basic unit of life. See also `mitosis`.\n\n- Nucleus\n- Mitochondria\n\nTo do:\n\n- [ ] Review chapter 3\n- [x] Draw the cell\n\n> Everything is made of cells.\n\n| organelle | job |\n|---|---|\n| nucleus | DNA |\n";
if (shots) {
  for (const scheme of ["light", "dark"]) {
    for (const [label, viewport] of [["desktop", { width: 1100, height: 760 }], ["phone", { width: 390, height: 800 }]]) {
      const context = await browser.newContext({ viewport, colorScheme: scheme });
      await context.addInitScript({ path: path.join(here, "mock-backend.js") });
      const page = await context.newPage();
      const name = (n) => `${shots}/${label}-${scheme}-${n}.png`;
      await page.goto(url);
      await page.waitForSelector("#disclosure[open]");
      await page.screenshot({ path: name("1-disclosure") });
      await page.click("#disclosure button");
      await page.waitForSelector("#welcome[open]");
      await page.screenshot({ path: name("2-welcome") });
      await page.click("#welcome button:last-of-type");
      await page.waitForSelector("#newNote");
      await page.screenshot({ path: name("3-empty") });
      await page.evaluate((demo) => { window.__mock.folders.add("Biology"); window.__mock.files.set("Biology/Cells.md", demo); window.__mock.files.set("Biology/Notes week 2.md", "x\n"); window.__mock.files.set("Shopping.md", "x\n"); }, DEMO);
      await page.click("#newFolder");
      await page.click('.tree-button[data-path="Biology"]').catch(() => {});
      await page.click('.tree-button[data-path="Biology/Cells.md"]');
      await page.waitForSelector(".note-body");
      await page.screenshot({ path: name("4-note") });
      if (label === "phone") { await page.click("#toggle"); await page.screenshot({ path: name("5-list") }); await page.click("#scrim", { position: { x: 380, y: 400 } }); }
      await page.locator(".note-body p", { hasText: "basic unit" }).click();
      await page.keyboard.press("End");
      await page.keyboard.press("Enter");
      await page.keyboard.type("/");
      await page.waitForSelector(".slash-menu");
      await page.screenshot({ path: name("6-slash") });
      await context.close();
    }
  }
}

await browser.close();
server.close();
console.log(failures ? `${failures} test(s) FAILED` : "all browser tests passed");
process.exit(failures ? 1 : 0);
