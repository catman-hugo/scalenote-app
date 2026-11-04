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

// The app looks for updates by default. Tests must never reach the real GitHub, so every page
// gets an empty release list unless a test sets up its own answer (a later route wins).
const GITHUB = "https://api.github.com/repos/catman-hugo/scalenote-app/releases?per_page=20";
const browser = await chromium.launch();
let failures = 0;
async function test(name, fn, opts = {}) {
  if (process.env.ONLY_SHOTS) return; // screenshots only (SHOTS_DIR)
  const context = await browser.newContext({ viewport: opts.viewport || { width: 1100, height: 760 }, colorScheme: opts.scheme || "light" });
  if (opts.settings) await context.addInitScript((text) => { window.__seedSettings = text; }, JSON.stringify(opts.settings));
  await context.addInitScript({ path: path.join(here, "mock-backend.js") });
  const page = await context.newPage();
  const problems = [];
  page.on("pageerror", (e) => problems.push("pageerror: " + e.message));
  page.on("console", (m) => { if (m.type() === "error" && !(opts.allow || []).some((re) => re.test(m.text()))) problems.push("console: " + m.text()); });
  await page.route("https://**/*", (route) => (route.request().url() === GITHUB ? route.fulfill({ status: 200, contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: "[]" }) : route.abort()));
  if (opts.before) await opts.before(page);
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
  // The first-run screen says where the default folder is, under the buttons.
  await page.waitForSelector("#welcome .default-path:not([hidden])");
  assert.equal(await page.textContent("#welcome .default-path"), "Default folder: /home/alice/Documents/ScaleNote");
  const order = await page.evaluate(() => { const y = (s) => document.querySelector(s).getBoundingClientRect().y; return [y("#welcome .dialog-actions"), y("#welcome .default-path")]; });
  assert.ok(order[0] < order[1], "the path is below the buttons");
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
  assert.equal(await page.locator(".slash-item").count(), 15);
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

// ---------- 0.2.2: pictures ----------

const PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const PNG = Buffer.from(PNG_B64, "base64");
const pasteFile = (page, name, type, bytes, kind = "paste") =>
  page.evaluate(([n, t, b, k]) => {
    const dt = new DataTransfer();
    dt.items.add(new File([Uint8Array.from(atob(b), (c) => c.charCodeAt(0))], n, { type: t }));
    const target = document.querySelector(".note-body");
    const event = k === "paste" ? new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }) : new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true, clientX: target.getBoundingClientRect().left + 50, clientY: target.getBoundingClientRect().top + 20 });
    target.dispatchEvent(event);
    return event.defaultPrevented;
  }, [name, type, bytes, kind]);

await test("the slash menu inserts a picture: it is copied to attachments and written as plain markdown", async (page) => {
  await start(page);
  // Listen early: the browser only reports the file chooser if the listener is already known.
  const chooser = new Promise((resolve) => page.once("filechooser", resolve));
  await page.click("#newNote");
  await page.click("#editor .note-body");
  await page.keyboard.type("before");
  await page.keyboard.press("Enter");
  await page.keyboard.type("/image");
  await page.waitForSelector(".slash-menu");
  await page.keyboard.press("Enter");
  await (await chooser).setFiles({ name: "Cell diagram (1).png", mimeType: "image/png", buffer: PNG });
  await page.waitForSelector(".image-img[src]");
  assert.equal(await page.evaluate(() => document.querySelector(".image-img").naturalWidth), 1);
  await page.fill(".image-alt", "a cell");
  await waitSaved(page);
  assert.match((await files(page))["Untitled.md"], /before\n\n!\[a cell\]\(attachments\/Cell-diagram-1\.png\)\n$/);
  assert.deepEqual([...await page.evaluate(() => [...window.__mock.attachments.keys()])], ["attachments/Cell-diagram-1.png"]);
});

await test("a pasted picture is stored, and the same picture pasted twice is stored once", async (page) => {
  await start(page);
  await page.click("#newNote");
  await page.click("#editor .note-body");
  assert.equal(await pasteFile(page, "shot.png", "image/png", PNG_B64), true);
  await page.waitForSelector(".image-img[src]");
  await pasteFile(page, "shot.png", "image/png", PNG_B64);
  await page.waitForFunction(() => document.querySelectorAll(".image-block").length === 2);
  await waitSaved(page);
  assert.equal(await page.evaluate(() => window.__mock.attachments.size), 1);
  assert.match((await files(page))["Untitled.md"], /!\[\]\(attachments\/shot\.png\)\n\n!\[\]\(attachments\/shot\.png\)\n$/);
});

await test("a dropped svg or text file is refused with a calm message and nothing is stored", async (page) => {
  await start(page);
  await page.click("#newNote");
  await page.click("#editor .note-body");
  assert.equal(await pasteFile(page, "evil.svg", "image/svg+xml", btoa("<svg onload=alert(1)/>"), "drop"), true);
  // Dropping outside the note must not let the browser open the file either.
  const outside = await page.evaluate(() => {
    const dt = new DataTransfer();
    dt.items.add(new File(["x"], "a.txt", { type: "text/plain" }));
    const event = new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true });
    document.getElementById("sidebar").dispatchEvent(event);
    return event.defaultPrevented;
  });
  assert.equal(outside, true);
  await page.waitForSelector("#banner:not([hidden])");
  assert.match(await page.textContent("#bannerText"), /png, jpg, gif and webp/);
  assert.equal(await page.locator(".image-block").count(), 0);
  assert.equal(await page.evaluate(() => window.__mock.attachments.size), 0);
  // A file that claims to be a png but is not a picture is refused by the backend.
  await pasteFile(page, "fake.png", "image/png", btoa("not a picture at all"));
  await page.waitForTimeout(300);
  assert.equal(await page.locator(".image-block").count(), 0);
  assert.equal(await page.evaluate(() => window.__mock.attachments.size), 0);
});

await test("a missing picture shows a message and the note is not changed by opening it", async (page) => {
  const text = "intro\n\n![](attachments/gone.png)\n\nend\n";
  await openSeeded(page, "Pic.md", text);
  await page.waitForSelector(".image-missing:not([hidden])");
  assert.equal(await page.locator(".raw-block").count(), 0);
  await page.click("#newNote");
  await page.waitForTimeout(1000);
  assert.equal((await files(page))["Pic.md"], text);
});

await test("picture links that are not safe stay raw blocks", async (page) => {
  const text = "![](attachments/a.svg)\n\n![](https://example.local/a.png)\n\n![](attachments/../x.png)\n";
  await openSeeded(page, "Bad.md", text);
  assert.equal(await page.locator(".raw-block").count(), 3);
  assert.equal(await page.locator(".image-block").count(), 0);
});

// ---------- 0.2.4: markdown source view ----------

await test("source view shows the note exactly, and going back and forth changes nothing on disk", async (page) => {
  await openSeeded(page, "Tricky.md", TRICKY);
  await page.click("#sourceToggle");
  await page.waitForSelector("#source:not([hidden])");
  assert.equal(await page.inputValue("#source"), TRICKY);
  assert.equal(await page.isVisible("#editor"), false);
  await page.click("#sourceToggle");
  await page.waitForSelector("#editor .note-body");
  assert.equal(await page.isVisible("#source"), false);
  await page.click("#sourceToggle");
  await page.click("#sourceToggle");
  await page.waitForTimeout(1200);
  assert.equal((await files(page))["Tricky.md"], TRICKY);
});

await test("saving from source view writes exactly what is in the box, with no id added", async (page) => {
  await openSeeded(page, "S.md", "# Title\n\n* odd bullet\n");
  await page.click("#sourceToggle");
  await page.click("#source");
  await page.keyboard.press("Control+End");
  await page.keyboard.type("\n\n==not tidied==  \n  [[x]]\n");
  await waitSaved(page);
  assert.equal((await files(page))["S.md"], "# Title\n\n* odd bullet\n\n\n==not tidied==  \n  [[x]]\n");
});

await test("switching back reads the edited text as blocks again", async (page) => {
  await openSeeded(page, "S.md", "plain\n");
  await page.click("#sourceToggle");
  await page.click("#source");
  await page.keyboard.press("Control+End");
  await page.keyboard.type("\n# A new heading\n\n- one\n- two\n");
  await page.click("#sourceToggle");
  await page.waitForSelector("#editor .note-body h1");
  assert.equal(await page.textContent(".note-body h1"), "A new heading");
  assert.equal(await page.locator(".note-body li").count(), 2);
  assert.equal((await files(page))["S.md"], "plain\n\n# A new heading\n\n- one\n- two\n");
});

await test("source view keeps the mode when another note is opened, and edits in the editor show up", async (page) => {
  await openSeeded(page, "A.md", "first\n");
  await seed(page, "B.md", "second\n");
  await page.click("#newFolder");
  await page.click("#sourceToggle");
  await page.click('.tree-button[data-path="B.md"]');
  await page.waitForFunction(() => document.getElementById("source").value === "second\n");
  await page.click("#sourceToggle");
  await page.locator(".note-body p").click();
  await page.keyboard.press("End");
  await page.keyboard.type(" edited");
  await page.click("#sourceToggle");
  assert.match(await page.inputValue("#source"), /second edited/);
});

await test("a note with Windows line endings keeps them; a note that mixes both is read-only in source view", async (page) => {
  await openSeeded(page, "W.md", "one\r\n\r\ntwo\r\n");
  await page.click("#sourceToggle");
  await page.click("#source");
  await page.keyboard.press("Control+End");
  await page.keyboard.type("three");
  await waitSaved(page);
  assert.equal((await files(page))["W.md"], "one\r\n\r\ntwo\r\nthree");
  await seed(page, "M.md", "a\r\nb\nc\n");
  await page.click("#newFolder");
  await page.click('.tree-button[data-path="M.md"]');
  await page.waitForFunction(() => document.getElementById("source").readOnly === true);
  assert.match(await page.textContent("#bannerText"), /mixes two kinds/);
  await page.waitForTimeout(800);
  assert.equal((await files(page))["M.md"], "a\r\nb\nc\n");
});

const DEMO = "# Cell biology\n\nThe **cell** is the basic unit of life. See also `mitosis`.\n\n- Nucleus\n- Mitochondria\n\nTo do:\n\n- [ ] Review chapter 3\n- [x] Draw the cell\n\n> Everything is made of cells.\n\n| organelle | job |\n|---|---|\n| nucleus | DNA |\n";
// ---------- block handle ----------

const GUT = ["# Title", "", "First", "", "Second ^keep1", "", "- a", "- b", "", "```js", "code", "```", "", "Last", ""].join("\n");
const order = async (page) => page.evaluate(() => [...document.querySelectorAll(".note-body > *")].map((n) => n.textContent.trim().slice(0, 12)));

async function dragHandle(page, fromText, toText, below = false, type = "mouse") {
  const target = page.locator(".note-body > *", { hasText: toText }).first();
  const source = page.locator(".note-body > *", { hasText: fromText }).first();
  await source.click();
  await page.waitForSelector(".gutter-handle:not([hidden])");
  const h = await page.locator(".gutter-handle").boundingBox();
  const t = await target.boundingBox();
  const y = below ? t.y + t.height - 2 : t.y + 2;
  await page.mouse.move(h.x + 16, h.y + 16);
  await page.mouse.down();
  await page.mouse.move(h.x + 16, h.y + 40, { steps: 3 });
  await page.mouse.move(h.x + 16, y, { steps: 8 });
  await page.mouse.up();
}

await test("the block handle follows the block you are in and moves blocks with the menu", async (page) => {
  await openSeeded(page, "G.md", GUT);
  await page.locator(".note-body p", { hasText: "Second" }).click();
  await page.waitForSelector(".gutter-handle:not([hidden])");
  await page.click(".gutter-handle");
  await page.waitForSelector(".gutter-menu:not([hidden])");
  await page.click('.gutter-menu >> text="Move up"');
  await waitSaved(page);
  let text = (await files(page))["G.md"];
  assert.ok(text.indexOf("Second ^keep1") < text.indexOf("First"), text);
  assert.ok(text.includes("- a\n- b"), "list untouched");
  assert.ok(text.includes("```js\ncode\n```"), "code untouched");
  // keyboard move back down
  await page.locator(".note-body p", { hasText: "Second" }).click();
  await page.keyboard.press("Alt+ArrowDown");
  await waitSaved(page);
  text = (await files(page))["G.md"];
  assert.ok(text.indexOf("First") < text.indexOf("Second ^keep1"), text);
});

await test("duplicate gives a copy without the block id, delete removes one block, one undo takes it back", async (page) => {
  await openSeeded(page, "G.md", GUT);
  await page.locator(".note-body p", { hasText: "Second" }).click();
  await page.click(".gutter-handle");
  await page.click('.gutter-menu >> text="Duplicate"');
  await waitSaved(page);
  let text = (await files(page))["G.md"];
  assert.equal((text.match(/Second/g) || []).length, 2, text);
  assert.equal((text.match(/\^keep1/g) || []).length, 1, "ids stay unique");
  await page.locator(".note-body p", { hasText: "Last" }).click();
  await page.click(".gutter-handle");
  await page.click('.gutter-menu >> text="Delete"');
  await waitSaved(page);
  assert.ok(!(await files(page))["G.md"].includes("Last"));
  await page.keyboard.press("Control+z");
  await waitSaved(page);
  assert.ok((await files(page))["G.md"].includes("Last"));
});

await test("turn into changes a paragraph to a heading and a list to a quote", async (page) => {
  await openSeeded(page, "G.md", GUT);
  await page.locator(".note-body p", { hasText: "First" }).click();
  await page.click(".gutter-handle");
  await page.click('.gutter-menu >> text="Heading 2"');
  await waitSaved(page);
  assert.ok((await files(page))["G.md"].includes("## First"));
  await page.locator(".note-body li", { hasText: "a" }).first().click();
  await page.click(".gutter-handle");
  await page.click('.gutter-menu >> text="Quote"');
  await waitSaved(page);
  assert.match((await files(page))["G.md"], /> a\n> b|> a\n>\n> b/);
});

await test("copy block link adds an id once and puts [[Note#^id]] on the clipboard", async (page) => {
  await openSeeded(page, "G.md", GUT);
  await page.evaluate(() => { window.__copied = null; navigator.clipboard.writeText = async (t) => { window.__copied = t; }; });
  await page.locator(".note-body p", { hasText: "First" }).click();
  await page.click(".gutter-handle");
  await page.click('.gutter-menu >> text="Copy block link"');
  await waitSaved(page);
  const copied = await page.evaluate(() => window.__copied);
  assert.match(copied, /^\[\[G#\^[a-z0-9]+\]\]$/);
  const id = copied.match(/\^([a-z0-9]+)\]\]/)[1];
  assert.ok((await files(page))["G.md"].includes(`First ^${id}`));
  // a list gets an id line after it
  await page.locator(".note-body li", { hasText: "a" }).first().click();
  await page.click(".gutter-handle");
  await page.click('.gutter-menu >> text="Copy block link"');
  await waitSaved(page);
  assert.match((await files(page))["G.md"], /- a\n- b\n\n\^[a-z0-9]+\n/);
  await page.waitForSelector(".toast:not([hidden])");
});

await test("dragging the handle with the mouse moves a block, and Escape cancels", async (page) => {
  await openSeeded(page, "G.md", GUT);
  await dragHandle(page, "Last", "First");
  await waitSaved(page);
  let text = (await files(page))["G.md"];
  assert.ok(text.indexOf("Last") < text.indexOf("First"), text);
  assert.ok(text.includes("```js\ncode\n```"));
  // cancel
  const before = await order(page);
  const src = page.locator(".note-body > *", { hasText: "Second" }).first();
  await src.click();
  const h = await page.locator(".gutter-handle").boundingBox();
  await page.mouse.move(h.x + 16, h.y + 16);
  await page.mouse.down();
  await page.mouse.move(h.x + 16, h.y - 120, { steps: 6 });
  await page.keyboard.press("Escape");
  await page.mouse.up();
  assert.deepEqual(await order(page), before);
});

await test("touch and pen: dragging the handle moves a block (pointer events, not mouse only)", async (page) => {
  await openSeeded(page, "G.md", GUT);
  const cdp = await page.context().newCDPSession(page);
  await page.locator(".note-body p", { hasText: "Last" }).click();
  await page.waitForSelector(".gutter-handle:not([hidden])");
  const h = await page.locator(".gutter-handle").boundingBox();
  const t = await page.locator(".note-body > *", { hasText: "First" }).first().boundingBox();
  const x = h.x + 16, y0 = h.y + 16;
  for (const pointerType of ["touch", "pen"]) {
    const send = (type, y) => pointerType === "touch"
      ? cdp.send("Input.dispatchTouchEvent", { type, touchPoints: type === "touchEnd" ? [] : [{ x, y }] })
      : cdp.send("Input.dispatchMouseEvent", { type, x, y, button: "left", buttons: type === "mouseReleased" ? 0 : 1, pointerType: "pen", clickCount: 1 });
    const [start, move, end] = pointerType === "touch" ? ["touchStart", "touchMove", "touchEnd"] : ["mousePressed", "mouseMoved", "mouseReleased"];
    const hh = await page.locator(".gutter-handle").boundingBox();
    const yy = hh.y + 16;
    await send(start, yy);
    for (let i = 1; i <= 10; i++) await send(move, yy + (t.y + 2 - yy) * (i / 10));
    await send(end, t.y + 2);
    await waitSaved(page);
    const text = (await files(page))["G.md"];
    assert.ok(text.indexOf("Last") < text.indexOf("First"), pointerType + "\n" + text);
    // put it back for the second round: move Last down with the menu command
    await page.locator(".note-body p", { hasText: "Last" }).click();
    for (let i = 0; i < 6; i++) await page.keyboard.press("Alt+ArrowDown");
    await waitSaved(page);
    await page.locator(".note-body p", { hasText: "Last" }).click();
  }
});

await test("a tap on the handle opens the menu and does not move anything", async (page) => {
  await openSeeded(page, "G.md", GUT);
  const before = (await files(page))["G.md"];
  await page.locator(".note-body p", { hasText: "First" }).click();
  await page.click(".gutter-handle");
  await page.waitForSelector(".gutter-menu:not([hidden])");
  await page.keyboard.press("Escape");
  await page.waitForSelector(".gutter-menu", { state: "hidden" });
  assert.equal((await files(page))["G.md"], before);
});

await test("a moved note with a shuffled order opens and saves again without loss", async (page) => {
  await openSeeded(page, "G.md", GUT);
  for (const [from, to] of [["Last", "Title"], ["Second", "Last"], ["First", "Second"]]) await dragHandle(page, from, to);
  await waitSaved(page);
  const saved = (await files(page))["G.md"];
  for (const part of ["# Title", "First", "Second ^keep1", "- a\n- b", "```js\ncode\n```", "Last"]) assert.ok(saved.includes(part), part + "\n" + saved);
  await page.click("#sourceToggle");
  await page.click("#sourceToggle");
  await page.waitForTimeout(400);
  assert.equal((await files(page))["G.md"], saved);
});

// ---------- themes and settings ----------

await test("settings: theme, text size, note width and list width apply at once and are saved", async (page) => {
  await openSeeded(page, "S.md", "hello\n");
  await page.click("#openSettings");
  await page.waitForSelector("#settings[open]");
  await page.selectOption('#settings select >> nth=0', "sage");
  await page.selectOption('#settings select >> nth=1', "125");
  await page.selectOption('#settings select >> nth=2', "wide");
  await page.locator('#settings input[type="range"]').fill("360");
  const look = await page.evaluate(() => ({
    theme: document.documentElement.dataset.theme,
    size: document.documentElement.style.fontSize,
    side: getComputedStyle(document.querySelector("#sidebar")).width,
    bodyWidth: getComputedStyle(document.querySelector(".note-body")).maxWidth,
    bg: getComputedStyle(document.body).backgroundColor,
  }));
  assert.equal(look.theme, "sage");
  assert.equal(look.size, "125%");
  assert.equal(look.side, "360px");
  assert.equal(look.bodyWidth, "1200px"); // 60rem at 125% text size
  assert.equal(look.bg, "rgb(248, 250, 247)");
  const saved = JSON.parse(await page.evaluate(() => window.__mock.getSettings()));
  assert.deepEqual([saved.theme, saved.fontSize, saved.editorWidth, saved.sidebarWidth], ["sage", 125, "wide", 360]);
  assert.equal(saved.vaultPath !== undefined, true);
  await page.click("#settings button.primary");
  await page.waitForSelector("#settings", { state: "hidden" });
  // back to the system choice removes the attribute
  await page.click("#openSettings");
  await page.selectOption('#settings select >> nth=0', "system");
  assert.equal(await page.evaluate(() => document.documentElement.hasAttribute("data-theme")), false);
});

await test("every theme draws the whole interface without errors", async (page) => {
  await openSeeded(page, "T.md", RICH);
  for (const theme of ["light", "dark", "sepia", "midnight", "sage", "forest", "lavender", "dusk"]) {
    await page.evaluate((t) => document.documentElement.setAttribute("data-theme", t), theme);
    const colours = await page.evaluate(() => [getComputedStyle(document.body).backgroundColor, getComputedStyle(document.querySelector(".sidebar")).backgroundColor]);
    assert.notEqual(colours[0], colours[1], theme + ": page and list differ");
  }
});

// ---------- update check and what's new ----------

const VERSION = JSON.parse(fs.readFileSync(path.join(here, "..", "package.json"), "utf8")).version;
const RELEASE_URL = "https://github.com/catman-hugo/scalenote-app/releases/tag/v9.9.9";
const EVIL_NOTES = "## Fixed\n- a thing\n<img src=x onerror=\"window.__pwned=1\">\n<script>window.__pwned=1</script>";
const existingUser = (extra = {}) => ({ vaultPath: "/vault", disclosureAccepted: true, lastSeenVersion: VERSION, ...extra });
function githubReturns(list, seen = []) {
  return async (page) => {
    await page.route(GITHUB, (route) => {
      seen.push({ headers: route.request().headers(), body: route.request().postData(), method: route.request().method() });
      route.fulfill({ status: 200, contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: JSON.stringify(list) });
    });
  };
}
const NEWER = [{ tag_name: "v9.9.9", html_url: RELEASE_URL, body: EVIL_NOTES, draft: false, prerelease: false }];

// ---------- 0.2.1: handle position, sidebar, icons, what's new ----------

const ALIGN = ["# Title", "", "Some text here", "", "---", "", "- a", "- b", "", "```js", "code", "```", "", "> [!note] Heads up", "> body", "", "<details>", "<summary>More</summary>", "", "inside", "", "</details>", ""].join("\n");

for (const [label, viewport] of [["desktop", { width: 1100, height: 760 }], ["phone", { width: 390, height: 800 }]]) await test(`the block handle is centred on the first line of every kind of block, also the divider (${label})`, async (page) => {
  await openSeeded(page, "A.md", ALIGN);
  const blocks = await page.locator(".note-body > *").count();
  assert.ok(blocks >= 7, "blocks: " + blocks);
  for (let i = 0; i < blocks; i++) {
    const block = page.locator(".note-body > *").nth(i);
    await block.scrollIntoViewIfNeeded();
    const box = await block.boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + Math.min(box.height / 2, 12));
    await page.waitForSelector(".gutter-handle:not([hidden])");
    const result = await page.evaluate((index) => {
      const dom = document.querySelectorAll(".note-body > *")[index];
      const handle = document.querySelector(".gutter-handle").getBoundingClientRect();
      // What the eye sees as the first line: the first piece of text, field or picture, or the divider itself.
      let middle;
      const head = dom.querySelector(".callout-head, .toggle-head");
      if (dom.querySelector("hr") || dom.tagName === "HR") {
        const r = dom.getBoundingClientRect();
        middle = r.top + r.height / 2;
      } else if (head) {
        // A callout or toggle starts with its title row.
        const r = head.getBoundingClientRect();
        middle = r.top + r.height / 2;
      } else {
        const target = [...dom.querySelectorAll("*")].find((n) => /^(INPUT|IMG)$/.test(n.tagName)) || dom;
        const walker = document.createTreeWalker(dom, NodeFilter.SHOW_TEXT);
        let text = null;
        for (let n = walker.nextNode(); n; n = walker.nextNode()) if (n.nodeValue.trim() && !n.parentElement.closest("select")) { text = n; break; }
        const range = document.createRange();
        if (text) range.selectNodeContents(text);
        const r = text ? range.getClientRects()[0] : target.getBoundingClientRect();
        middle = r.top + r.height / 2;
      }
      return { kind: dom.className || dom.tagName, handle: handle.top + handle.height / 2, middle };
    }, i);
    assert.ok(Math.abs(result.handle - result.middle) <= 4, `block ${i} (${result.kind}): handle at ${result.handle}, first line at ${result.middle}`);
  }
}, { viewport });

await test("the grabbed handle is hidden while a block is dragged and comes back after the drop", async (page) => {
  await openSeeded(page, "G.md", GUT);
  await page.locator(".note-body p", { hasText: "Second" }).click();
  await page.waitForSelector(".gutter-handle:not([hidden])");
  const h = await page.locator(".gutter-handle").boundingBox();
  const opacity = () => page.evaluate(() => getComputedStyle(document.querySelector(".gutter-handle")).opacity);
  assert.equal(await opacity(), "1");
  await page.mouse.move(h.x + 16, h.y + 16);
  await page.mouse.down();
  await page.mouse.move(h.x + 16, h.y + 60, { steps: 5 });
  assert.equal(await opacity(), "0", "hidden while dragging");
  await page.keyboard.press("Escape");
  await page.mouse.up();
  assert.equal(await opacity(), "1", "visible again");
});

for (const fontSize of [100, 125]) await test(`the sidebar keeps its buttons on one line at the narrowest width and shows icons only (text size ${fontSize})`, async (page) => {
  await page.waitForSelector("#newNote");
  const m = await page.evaluate(() => {
    const box = (id) => document.getElementById(id).getBoundingClientRect();
    const labelShown = (id) => { const l = document.querySelector("#" + id + " .btn-label"); return l.getBoundingClientRect().width > 4; };
    return {
      width: document.getElementById("sidebar").getBoundingClientRect().width,
      newNote: box("newNote"), newFolder: box("newFolder"), openOther: box("openOther"), openSettings: box("openSettings"),
      labels: { newNote: labelShown("newNote"), openOther: labelShown("openOther"), openSettings: labelShown("openSettings") },
      icons: ["newNote", "newFolder", "openOther", "openSettings"].map((id) => document.querySelectorAll("#" + id + " svg").length),
      names: ["newNote", "newFolder", "openOther", "openSettings"].map((id) => document.getElementById(id).getAttribute("aria-label")),
      overflow: document.getElementById("sidebar").scrollWidth > document.getElementById("sidebar").clientWidth,
    };
  });
  assert.equal(m.width, 200);
  assert.ok(m.newNote.height <= 48 && m.newFolder.height <= 48 && m.openOther.height <= 48 && m.openSettings.height <= 48, JSON.stringify(m));
  assert.ok(Math.abs(m.newNote.y - m.newFolder.y) < 1, "New note and New folder share one row");
  assert.equal(m.labels.newNote, false);
  assert.equal(m.labels.openOther, false);
  assert.ok(m.icons.every((n) => n === 1), "every sidebar button has an icon: " + m.icons);
  assert.ok(m.names.every((n) => n && n.length > 3), "every button keeps a name: " + m.names);
  assert.equal(m.overflow, false);
}, { settings: { vaultPath: "/vault", disclosureAccepted: true, lastSeenVersion: VERSION, updates: false, sidebarWidth: 200, fontSize }, viewport: { width: 1100, height: 760 } });

await test("at the normal width the sidebar shows labels, with Open another folder at the top and a gear for Settings", async (page) => {
  await page.waitForSelector("#newNote");
  const m = await page.evaluate(() => {
    const y = (id) => document.getElementById(id).getBoundingClientRect().y;
    const label = (id) => document.querySelector("#" + id + " .btn-label").getBoundingClientRect().width;
    return { open: y("openOther"), actions: y("newNote"), tree: y("tree"), foot: y("openSettings"), openLabel: label("openOther"), noteLabel: label("newNote"), settingsLabel: label("openSettings"), svg: document.querySelectorAll("#openSettings svg path").length, text: document.getElementById("openSettings").textContent };
  });
  assert.ok(m.open < m.actions && m.actions < m.tree && m.tree < m.foot, JSON.stringify(m));
  assert.ok(m.openLabel > 40 && m.noteLabel > 30 && m.settingsLabel > 30, JSON.stringify(m));
  assert.equal(m.svg, 1, "the gear is one drawn icon");
  assert.equal(m.text, "Settings");
}, { settings: { vaultPath: "/vault", disclosureAccepted: true, lastSeenVersion: VERSION, updates: false } });

await test("no emoji or typed symbol stands in for an icon anywhere in the screens", async (page) => {
  await openSeeded(page, "A.md", ALIGN);
  await page.locator(".note-body p", { hasText: "Some text" }).click();
  await page.waitForSelector(".gutter-handle:not([hidden])");
  const found = await page.evaluate(() => {
    const text = (document.getElementById("app").innerText + document.querySelector(".gutter-handle").textContent + document.querySelector(".toggle-fold").textContent);
    return text.match(/[\p{Extended_Pictographic}•⋮▾▸⚙]/gu) || [];
  });
  assert.deepEqual(found, []);
  assert.equal(await page.locator(".gutter-handle svg").count(), 1);
  assert.equal(await page.locator(".toggle-fold svg").count(), 1);
});

await test("the What's new box is wide and tall enough for a long list of notes", async (page) => {
  await page.waitForSelector("#updateNotice:not([hidden])");
  await page.click("#updateDetails");
  await page.waitForSelector("#whatsnew[open]");
  const m = await page.evaluate(() => {
    const d = document.querySelector("#whatsnew").getBoundingClientRect();
    const n = document.querySelector("#whatsnew .notes");
    return { width: d.width, height: d.height, scrolls: n.scrollHeight > n.clientHeight, notesHeight: n.clientHeight, view: window.innerHeight };
  });
  assert.ok(m.width >= 700, JSON.stringify(m));
  assert.ok(m.notesHeight >= m.view * 0.5, JSON.stringify(m));
  assert.ok(m.height <= m.view, "the box fits in the window: " + JSON.stringify(m));
}, { settings: existingUser(), before: githubReturns([{ tag_name: "v9.9.9", html_url: RELEASE_URL, body: Array.from({ length: 40 }, (_, i) => "- A fairly long line of release notes number " + i + " that takes some room on screen.").join("\n"), draft: false, prerelease: false }]) });


await test("a newer release shows a notice with a download button and its notes as plain text", async (page) => {
  await page.waitForSelector("#updateNotice:not([hidden])");
  assert.match(await page.textContent("#updateText"), /ScaleNote 9\.9\.9 is available/);
  await page.click("#updateDetails");
  await page.waitForSelector("#whatsnew[open]");
  const dialog = await page.evaluate(() => ({ imgs: document.querySelectorAll("#whatsnew img, #whatsnew script").length, text: document.querySelector("#whatsnew").textContent, pwned: window.__pwned || 0 }));
  assert.equal(dialog.imgs, 0, "no html from the notes became elements");
  assert.equal(dialog.pwned, 0);
  assert.ok(dialog.text.includes("<img src=x"), "the notes are shown as text");
  await page.click("#whatsnew button");
  await page.click("#updateDownload");
  assert.deepEqual(await page.evaluate(() => window.__mock.opened), [RELEASE_URL]);
}, { settings: existingUser(), before: githubReturns(NEWER) });

await test("Not now hides the notice and remembers that version", async (page) => {
  await page.waitForSelector("#updateNotice:not([hidden])");
  await page.click("#updateLater");
  assert.equal(await page.isVisible("#updateNotice"), false);
  assert.equal(JSON.parse(await page.evaluate(() => window.__mock.getSettings())).dismissedUpdate, "9.9.9");
}, { settings: existingUser(), before: githubReturns(NEWER) });

await test("a dismissed version is not offered again", async (page) => {
  await page.waitForSelector("#newNote");
  await page.waitForTimeout(500);
  assert.equal(await page.isVisible("#updateNotice"), false);
}, { settings: existingUser({ dismissedUpdate: "9.9.9" }), before: githubReturns(NEWER) });

const seenRequests = [];
await test("the check sends no vault data, no cookies and no referrer", async (page) => {
  await page.waitForSelector("#updateNotice:not([hidden])");
  assert.equal(seenRequests.length, 1);
  const r = seenRequests[0];
  assert.equal(r.method, "GET");
  assert.equal(r.body, null);
  assert.equal(r.headers.cookie, undefined);
  assert.equal(r.headers.referer, undefined);
  assert.equal(r.headers.authorization, undefined);
}, { settings: existingUser(), before: (page) => githubReturns(NEWER, seenRequests)(page) });

await test("with the update setting off, nothing is requested and no notice appears", async (page) => {
  let asked = 0;
  await page.route(GITHUB, (route) => { asked++; route.abort(); });
  await page.reload();
  await page.waitForSelector("#newNote");
  await page.waitForTimeout(500);
  assert.equal(asked, 0);
  assert.equal(await page.isVisible("#updateNotice"), false);
}, { settings: existingUser({ updates: false }) });

await test("the update setting is one switch in Settings and is saved", async (page) => {
  await page.waitForSelector("#newNote");
  await page.click("#openSettings");
  const box = page.locator('#settings input[type="checkbox"]');
  assert.equal(await box.isChecked(), true);
  await box.uncheck();
  assert.equal(JSON.parse(await page.evaluate(() => window.__mock.getSettings())).updates, false);
  assert.match(await page.textContent("#settings"), /Nothing from your notes is sent/);
}, { settings: existingUser(), before: githubReturns([]) });

await test("Check now says when the version is current, and a failed check is calm", async (page) => {
  await page.waitForSelector("#newNote");
  await page.click("#openSettings");
  await page.click('#settings button:has-text("Check now")');
  await page.waitForFunction(() => /latest version/.test(document.querySelector("#settings").textContent));
  await page.unroute(GITHUB);
  await page.route(GITHUB, (route) => route.fulfill({ status: 503, body: "no" }));
  await page.click('#settings button:has-text("Check now")');
  await page.waitForFunction(() => /Could not check/.test(document.querySelector("#settings").textContent));
  assert.equal(await page.isVisible("#banner"), false);
}, { settings: existingUser({ lastUpdateCheck: Date.now() }), before: githubReturns([]), allow: [/Failed to load resource/] });

await test("after an update the new notes are shown once; a new install sees nothing", async (page) => {
  await page.waitForSelector("#whatsnew[open]");
  assert.match(await page.textContent("#whatsnew h2"), new RegExp("ScaleNote was updated to " + VERSION.replace(/\./g, "\\.")));
  await page.click("#whatsnew button");
  await page.waitForSelector("#newNote");
  assert.equal(JSON.parse(await page.evaluate(() => window.__mock.getSettings())).lastSeenVersion, VERSION);
}, { settings: existingUser({ lastSeenVersion: "0.0.1", updates: false }) });

await test("a fresh install shows the disclosure with the update line and no what's new screen", async (page) => {
  await page.waitForSelector("#disclosure[open]");
  assert.match(await page.textContent("#disclosure"), /looks for new versions on GitHub/);
  assert.match(await page.textContent("#disclosure"), /turn this off in Settings/);
  await page.click("#disclosure button");
  await page.waitForSelector("#welcome[open]");
  assert.equal(await page.isVisible("#whatsnew"), false);
  assert.equal(JSON.parse(await page.evaluate(() => window.__mock.getSettings())).lastSeenVersion, VERSION);
}, { before: githubReturns([]) });

await test("the content security policy lets the app talk to the app itself and to GitHub's release list only", async () => {
  const connect = CSP.split(";").map((p) => p.trim()).find((p) => p.startsWith("connect-src"));
  assert.equal(connect, "connect-src ipc: http://ipc.localhost https://api.github.com");
  assert.ok(!/unsafe/.test(CSP) && !/\*/.test(CSP));
});

await test("on a phone the note list is open at the start", async (page) => {
  await page.waitForSelector("#newNote");
  assert.equal(await page.evaluate(() => document.body.classList.contains("sidebar-open")), true);
  assert.equal(await page.isVisible("#sidebar"), true);
}, { viewport: { width: 390, height: 780 }, settings: existingUser({ updates: false }) });

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
      // A short plain paragraph: it does not wrap on a phone and does not end in inline code.
      await page.locator(".note-body p", { hasText: "To do:" }).click();
      // Wait until the editor itself has moved its cursor there; keys sent before that act on the old cursor.
      await page.waitForFunction(() => document.querySelector(".note-body").editor.state.selection.$from.parent.textContent === "To do:");
      await page.keyboard.press("End");
      await page.keyboard.press("Enter");
      await page.keyboard.type("/");
      await page.waitForSelector(".slash-menu", { timeout: 8000 }).catch(async (error) => { await page.screenshot({ path: name("FAILED-slash") }); throw error; });
      await page.screenshot({ path: name("6-slash") });
      await context.close();
    }
  }
}

// Screenshots of the screens added in 0.2 (only when SHOTS_DIR is set), in light and dark.
if (shots) {
  const PICTURE = "iVBORw0KGgoAAAANSUhEUgAAAPAAAACMCAIAAADN17N/AAACbklEQVR4nO3dQQ3AMAwEQeMMpgILjYDovzAibUcygbH2f7PPe+XWs68cb9s7fwPztr2C5k15Bc2b8gqaN+UVNG/KK2jelFfQvCmvoHlTXkHzpryC5k15Bc2b8gqaN+UVNG/KK2jelFfQvCmvoHlTXkHzpryC5k15Bc2b8gqaN+UVNG/KK2jelFfQvCmvoHlTXkHzpryC5k15Bc2b8gqaN+UVNG/KK2jelFfQvCmvoHlTXkHzpryC5k15x6N5S15B86a8guZNeQXNm/IKmjflFTRvyito3pRX0Lwpr6B5U15B86a8guZNeQXNm/IKmjflFTRvyito3pRX0Lwpr6B5U15B86a8guZNeQXNm/IKmjflFTRvyito3pRX0Lwpr6B5U15B86a8guZNeQXNm/IKmjflFTRvyito3pRX0Lwpr6B5U15B86a8guZNeW2s8Ka8guZNeQXNm/IKmjflFTRvyito3pRX0Lwpr6B5U15B86a8guZNeQXNm/IKmjflFTRvyito3pRX0Lwpr6B5U15B86a8guZNeQXNm/IKmjflFTRvyito3pRX0Lwpr6B5U15B86a8guZNeQXNm/IKmjflFTRvyito3pRX0Lwpr6B5U15B86a8guZNeQXNm/LaWOFNeQXNm/IKmjflFTRvyito3pRX0Lwpr6B5U15B86a8guZNeQXNm/IKmjflFTRvyito3pRX0Lwpr6B5U15B86a8guZNeQXNm/IKmjflFTRvyito3pRX0Lwpr6B5U15B86a8guZNeQXNm/IKmjflFTRvyito3pRX0Lwpr6B5U15B86a8guZNeQXNm/IKmjfl/QC99AwHVDSuFQAAAABJRU5ErkJggg==";
  const NOTE = ["# Photosynthesis", "", "Plants turn **light** into *sugar*. See [the guide](https://example.local/guide).", "", "> [!tip] Remember", "> Chlorophyll absorbs red and blue light.", "", "> [!warning]- Common mistake", "> Plants do not eat soil.", "", "<details>", "<summary>Why are leaves green?</summary>", "", "Green light is reflected, not absorbed.", "", "</details>", "", "| stage | where |", "| :--- | ---: |", "| light reactions | thylakoid |", "| Calvin cycle | stroma |", "", "![A diagram of a leaf](attachments/leaf.png)", "", "Last line ^last1", ""].join("\n");
  const prepare = async (page, settings) => {
    await page.route("https://**/*", (route) => (route.request().url() === GITHUB ? route.fulfill({ status: 200, contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: JSON.stringify(settings.releases || []) }) : route.abort()));
  };
  const open = async (page) => {
    await page.evaluate(([note, picture]) => { window.__mock.files.set("Photosynthesis.md", note); window.__mock.attachments.set("attachments/leaf.png", picture); }, [NOTE, PICTURE]);
    await page.click("#newFolder");
    await page.click('.tree-button[data-path="Photosynthesis.md"]');
    await page.waitForSelector(".note-body");
    await page.waitForSelector(".image-img[src]");
  };
  const baseSettings = { vaultPath: "/vault", disclosureAccepted: true, lastSeenVersion: VERSION };
  const phoneClose = async (page, label) => { if (label === "phone") await page.evaluate(() => document.body.classList.remove("sidebar-open")); };
  for (const scheme of ["light", "dark"]) {
    for (const [label, viewport] of [["desktop", { width: 1100, height: 760 }], ["phone", { width: 390, height: 800 }]]) {
      const context = await browser.newContext({ viewport, colorScheme: scheme });
      await context.addInitScript((text) => { window.__seedSettings = text; }, JSON.stringify({ ...baseSettings, updates: false }));
      await context.addInitScript({ path: path.join(here, "mock-backend.js") });
      const page = await context.newPage();
      await prepare(page, {});
      const name = (n) => `${shots}/v02-${label}-${scheme}-${n}.png`;
      await page.goto(url);
      await page.waitForSelector("#newNote");
      await open(page);
      await phoneClose(page, label);
      await page.screenshot({ path: name("1-rich-note") });
      await page.locator(".note-body p", { hasText: "Plants turn" }).click();
      await page.waitForSelector(".gutter-handle:not([hidden])");
      await page.screenshot({ path: name("2-handle") });
      await page.click(".gutter-handle");
      await page.waitForSelector(".gutter-menu:not([hidden])");
      await page.screenshot({ path: name("3-block-menu") });
      await page.keyboard.press("Escape");
      await page.locator(".note-body p", { hasText: "Plants turn" }).click();
      await page.keyboard.press("Home");
      for (let i = 0; i < 6; i++) await page.keyboard.press("Shift+ArrowRight");
      await page.waitForSelector(".float-bar:not([hidden])");
      await page.screenshot({ path: name("4-format-bar") });
      await page.locator(".note-body table td").first().click();
      await page.waitForSelector(".float-bar:not([hidden])");
      await page.screenshot({ path: name("5-table-bar") });
      await page.click("#sourceToggle");
      await page.waitForSelector("#source:not([hidden])");
      await page.screenshot({ path: name("6-source") });
      await page.click("#sourceToggle");
      if (label === "phone") await page.click("#toggle");
      await page.click("#openSettings");
      await page.waitForSelector("#settings[open]");
      await page.screenshot({ path: name("7-settings") });
      await context.close();

      const update = await browser.newContext({ viewport, colorScheme: scheme });
      await update.addInitScript((text) => { window.__seedSettings = text; }, JSON.stringify({ ...baseSettings, lastSeenVersion: "0.1.1" }));
      await update.addInitScript({ path: path.join(here, "mock-backend.js") });
      const up = await update.newPage();
      await prepare(up, { releases: [{ tag_name: "v9.9.9", html_url: RELEASE_URL, body: "# ScaleNote 9.9.9\n\n## New\n- Something nice\n- Another thing\n\n## Fixed\n- A small bug", draft: false, prerelease: false }] });
      await up.goto(url);
      await up.waitForSelector("#whatsnew[open]");
      await up.screenshot({ path: name("8-whats-new") });
      await up.click("#whatsnew button");
      await up.waitForSelector("#updateNotice:not([hidden])");
      await phoneClose(up, label);
      await up.screenshot({ path: name("9-update-notice") });
      await update.close();
    }
  }
  // 0.2.1 screens: the sidebar at normal and narrowest width, the handle on a heading, the
  // divider and a callout, the handle while dragging, and a long What's new box.
  for (const scheme of ["light", "dark"]) {
    for (const [label, viewport] of [["desktop", { width: 1100, height: 760 }], ["phone", { width: 390, height: 800 }]]) {
      for (const width of label === "desktop" ? [280, 200] : [280]) {
        const context = await browser.newContext({ viewport, colorScheme: scheme });
        await context.addInitScript((text) => { window.__seedSettings = text; }, JSON.stringify({ ...baseSettings, updates: false, sidebarWidth: width }));
        await context.addInitScript({ path: path.join(here, "mock-backend.js") });
        const page = await context.newPage();
        await prepare(page, {});
        const name = (n) => `${shots}/v021-${label}-${scheme}-${n}.png`;
        await page.goto(url);
        await page.waitForSelector("#newNote");
        await page.evaluate(([text]) => window.__mock.files.set("Alignment.md", text), [ALIGN]);
        await page.click("#newFolder");
        await page.screenshot({ path: name(`1-sidebar-${width}`) });
        if (width === 200 || label === "phone") { await context.close(); continue; }
        await page.click('.tree-button[data-path="Alignment.md"]');
        await page.waitForSelector(".note-body");
        for (const [key, selector] of [["heading", ".note-body h1"], ["divider", ".note-body hr"], ["code", ".note-body pre"], ["callout", ".note-body .callout"], ["toggle", ".note-body .toggle"]]) {
          const box = await page.locator(selector).first().boundingBox();
          await page.mouse.move(box.x + box.width / 2, box.y + Math.min(box.height / 2, 10));
          await page.waitForSelector(".gutter-handle:not([hidden])");
          await page.screenshot({ path: name(`2-handle-${key}`) });
        }
        const para = await page.locator(".note-body p").first().boundingBox();
        await page.mouse.move(para.x + 10, para.y + 8);
        const h = await page.locator(".gutter-handle").boundingBox();
        await page.mouse.move(h.x + 16, h.y + 16);
        await page.mouse.down();
        await page.mouse.move(h.x + 16, h.y + 120, { steps: 6 });
        await page.screenshot({ path: name("3-dragging") });
        await page.keyboard.press("Escape");
        await page.mouse.up();
        await context.close();
      }
    }
    for (const [label, viewport] of [["desktop", { width: 1100, height: 760 }], ["phone", { width: 390, height: 800 }]]) {
      const first = await browser.newContext({ viewport, colorScheme: scheme });
      await first.addInitScript({ path: path.join(here, "mock-backend.js") });
      const fp = await first.newPage();
      await prepare(fp, {});
      await fp.goto(url);
      await fp.click("#disclosure button");
      await fp.waitForSelector("#welcome .default-path:not([hidden])");
      await fp.screenshot({ path: `${shots}/v021-${label}-${scheme}-5-welcome.png` });
      await first.close();
    }
    const update = await browser.newContext({ viewport: { width: 1100, height: 760 }, colorScheme: scheme });
    await update.addInitScript((text) => { window.__seedSettings = text; }, JSON.stringify({ ...baseSettings, lastSeenVersion: "0.1.1" }));
    await update.addInitScript({ path: path.join(here, "mock-backend.js") });
    const up = await update.newPage();
    const longNotes = ["## New", ...Array.from({ length: 14 }, (_, i) => "- A fairly long line of release notes number " + (i + 1) + " that takes a little room on the screen so the box has to show a lot.")].join("\n");
    await prepare(up, { releases: [{ tag_name: "v9.9.9", html_url: RELEASE_URL, body: longNotes, draft: false, prerelease: false }] });
    await up.goto(url);
    await up.waitForSelector("#whatsnew[open]");
    await up.screenshot({ path: `${shots}/v021-desktop-${scheme}-4-whats-new.png` });
    await update.close();
  }
  // Every theme, desktop only. The named themes do not depend on the system setting.
  for (const theme of ["light", "dark", "sepia", "midnight", "sage", "forest", "lavender", "dusk"]) {
    const context = await browser.newContext({ viewport: { width: 1100, height: 760 }, colorScheme: "light" });
    await context.addInitScript((text) => { window.__seedSettings = text; }, JSON.stringify({ ...baseSettings, updates: false, theme }));
    await context.addInitScript({ path: path.join(here, "mock-backend.js") });
    const page = await context.newPage();
    await prepare(page, {});
    await page.goto(url);
    await page.waitForSelector("#newNote");
    await open(page);
    await page.locator(".note-body p", { hasText: "Plants turn" }).click();
    await page.keyboard.press("Home");
    for (let i = 0; i < 6; i++) await page.keyboard.press("Shift+ArrowRight");
    await page.waitForSelector(".float-bar:not([hidden])");
    await page.screenshot({ path: `${shots}/theme-${theme}.png` });
    await context.close();
  }
}

await browser.close();
server.close();
console.log(failures ? `${failures} test(s) FAILED` : "all browser tests passed");
process.exit(failures ? 1 : 0);
