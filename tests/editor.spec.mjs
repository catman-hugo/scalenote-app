// Drives the real built interface (dist/) in Chromium, with the in-memory backend from
// mock-backend.js. Run with: npm run build && node tests/editor.spec.mjs

import { createRequire } from "node:module";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { COLOURS } from "../web/inlinestyles.js";
import { pageFill } from "../web/canvasrules.js";

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
  if (process.env.ONLY && !name.includes(process.env.ONLY)) return; // run the tests whose name contains this text
  const context = await browser.newContext({ viewport: opts.viewport || { width: 1100, height: 760 }, colorScheme: opts.scheme || "light", ...(opts.userAgent ? { userAgent: opts.userAgent } : {}), ...(opts.hasTouch ? { hasTouch: true } : {}) });
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
    console.log("FAIL - " + name + "\n       " + String(error.message).split("\n").join("\n       ") + (problems.length ? "\n       page problems: " + problems.join(" | ") : ""));
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
  "| a | b |", "|---|---|", "| 1 | 2 |", "", "See ![[Other note]] and ==highlight==", "", "A plain [[Other note]] link and ==highlight==", "",
  "> [!note] A callout", "> body", "", "<div class=\"x\">html</div>", "", "$$", "x^2", "$$", "", "```js", "let a = 1;", "", "let b = 2;", "```", "", "1) odd numbering", "", "A final line #tag", "", "Issue #1984 stays as written", "",
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
  // Grab the middle of the handle: a fixed offset can miss it when the handle is smaller on another machine.
  const cx = h.x + h.width / 2, cy = h.y + h.height / 2;
  // hover() waits until the handle really receives the pointer, and says what is in the way if it never does.
  let hoverNote = "hover ok";
  await page.locator(".gutter-handle").hover({ timeout: 8000 }).catch((e) => { hoverNote = "hover failed: " + String(e.message).split("\n").slice(0, 6).join(" / "); });
  await page.mouse.move(cx, cy);
  const under = hoverNote + " | " + await page.evaluate(([x, y]) => {
    const h = document.querySelector(".gutter-handle");
    const cs = getComputedStyle(h);
    const stack = document.elementsFromPoint(x, y).slice(0, 5).map((e) => e.tagName + "." + e.className).join(" > ");
    return stack + " | handle z=" + cs.zIndex + " pe=" + cs.pointerEvents + " display=" + cs.display + " vis=" + cs.visibility + " viewport=" + innerWidth + "x" + innerHeight;
  }, [cx, cy]);
  await page.mouse.down();
  await page.mouse.move(cx, cy + 44, { steps: 5 });
  await page.waitForFunction(() => getComputedStyle(document.querySelector(".gutter-handle")).opacity === "0", null, { timeout: 2000 }).catch(() => {});
  const info = await page.evaluate(() => ({ body: document.body.className, handle: document.querySelector(".gutter-handle").getBoundingClientRect().toJSON(), hidden: document.querySelector(".gutter-handle").hidden }));
  assert.equal(await opacity(), "0", "hidden while dragging; under the pointer: " + under + "; grabbed at " + JSON.stringify(h) + "; now " + JSON.stringify(info));
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
      newNote: box("newNote"), newFolder: box("newFolder"), vault: box("vaultButton"), openSettings: box("openSettings"),
      labels: { newNote: labelShown("newNote"), newFolder: labelShown("newFolder") },
      icons: ["newNote", "newFolder", "openSettings"].map((id) => document.querySelectorAll("#" + id + " svg").length),
      names: ["newNote", "newFolder", "openSettings"].map((id) => document.getElementById(id).getAttribute("aria-label")),
      overflow: document.getElementById("sidebar").scrollWidth > document.getElementById("sidebar").clientWidth,
    };
  });
  assert.equal(m.width, 200);
  assert.ok(m.newNote.height <= 48 && m.newFolder.height <= 48 && m.vault.height <= 48 && m.openSettings.height <= 48, JSON.stringify(m));
  assert.ok(Math.abs(m.newNote.y - m.newFolder.y) < 1, "New page and New folder share one row");
  assert.equal(m.labels.newNote, false);
  assert.equal(m.labels.newFolder, false);
  assert.ok(m.icons.every((n) => n === 1), "every sidebar button has an icon: " + m.icons);
  assert.ok(m.names.every((n) => n && n.length > 3), "every button keeps a name: " + m.names);
  assert.equal(m.overflow, false);
}, { settings: { vaultPath: "/vault", disclosureAccepted: true, lastSeenVersion: VERSION, updates: false, sidebarWidth: 200, fontSize }, viewport: { width: 1100, height: 760 } });

await test("at the normal width the sidebar shows labels, with the folder name on top and a gear for Settings", async (page) => {
  await page.waitForSelector("#newNote");
  const m = await page.evaluate(() => {
    const y = (id) => document.getElementById(id).getBoundingClientRect().y;
    const label = (id) => (id === "vaultName" ? document.getElementById(id) : document.querySelector("#" + id + " .btn-label")).getBoundingClientRect().width;
    return { open: y("vaultButton"), actions: y("newNote"), tree: y("tree"), foot: y("openSettings"), openLabel: 20 + label("vaultName"), noteLabel: label("newNote"), settingsLabel: label("openSettings"), svg: document.querySelectorAll("#openSettings svg path").length, text: document.getElementById("openSettings").textContent };
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

// The download choices. The user agent decides which release file is offered; the browser opens it.
const FILES9 = "https://github.com/catman-hugo/scalenote-app/releases/download/v9.9.9";
const WITH_FILES = [{ tag_name: "v9.9.9", html_url: RELEASE_URL, body: "notes", draft: false, prerelease: false, assets: [
  { name: "ScaleNote_9.9.9_arm64-debug.apk", state: "uploaded", browser_download_url: `${FILES9}/ScaleNote_9.9.9_arm64-debug.apk` },
  { name: "ScaleNote_9.9.9_x64-setup.exe", state: "uploaded", browser_download_url: `${FILES9}/ScaleNote_9.9.9_x64-setup.exe` },
  { name: "ScaleNote_9.9.9_x64_en-US.msi", state: "uploaded", browser_download_url: `${FILES9}/ScaleNote_9.9.9_x64_en-US.msi` },
  { name: "ScaleNote_9.9.9_amd64.deb", state: "uploaded", browser_download_url: `${FILES9}/ScaleNote_9.9.9_amd64.deb` },
] }];
const ANDROID_UA = "Mozilla/5.0 (Linux; Android 14; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36";
const WINDOWS_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

await test("on Android the Download button opens the apk file straight away", async (page) => {
  await page.waitForSelector("#updateNotice:not([hidden])");
  assert.equal((await page.textContent("#updateDownload")).trim(), "Download");
  await page.click("#updateDownload");
  assert.deepEqual(await page.evaluate(() => window.__mock.opened), [`${FILES9}/ScaleNote_9.9.9_arm64-debug.apk`]);
}, { settings: existingUser(), before: githubReturns(WITH_FILES), userAgent: ANDROID_UA });

await test("on Windows the Download button opens the msi, not the other files", async (page) => {
  await page.waitForSelector("#updateNotice:not([hidden])");
  await page.click("#updateDownload");
  assert.deepEqual(await page.evaluate(() => window.__mock.opened), [`${FILES9}/ScaleNote_9.9.9_x64_en-US.msi`]);
}, { settings: existingUser(), before: githubReturns(WITH_FILES), userAgent: WINDOWS_UA });

await test("where no single file fits (Linux) the button opens the release page and says so", async (page) => {
  await page.waitForSelector("#updateNotice:not([hidden])");
  assert.equal((await page.textContent("#updateDownload")).trim(), "Open release page");
  await page.click("#updateDownload");
  assert.deepEqual(await page.evaluate(() => window.__mock.opened), [RELEASE_URL]);
}, { settings: existingUser(), before: githubReturns(WITH_FILES), userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15" });

await test("when the file cannot be opened the release page is opened instead", async (page) => {
  await page.waitForSelector("#updateNotice:not([hidden])");
  await page.evaluate(() => { window.__mock.failOpen = "/download/"; });
  await page.click("#updateDownload");
  assert.deepEqual(await page.evaluate(() => window.__mock.opened), [RELEASE_URL]);
  assert.equal(await page.isVisible("#banner:not([hidden])").catch(() => false), false, "no warning when the fallback worked");
}, { settings: existingUser(), before: githubReturns(WITH_FILES), userAgent: ANDROID_UA });

await test("when nothing can be opened a calm message points to the releases page", async (page) => {
  await page.waitForSelector("#updateNotice:not([hidden])");
  await page.evaluate(() => { window.__mock.failOpen = "github.com"; });
  await page.click("#updateDownload");
  await page.waitForFunction(() => /releases page on GitHub/.test(document.body.textContent));
  assert.deepEqual(await page.evaluate(() => window.__mock.opened), []);
}, { settings: existingUser(), before: githubReturns(WITH_FILES), userAgent: ANDROID_UA });

await test("a file address from another site is not offered; the release page is", async (page) => {
  await page.waitForSelector("#updateNotice:not([hidden])");
  await page.click("#updateDownload");
  assert.deepEqual(await page.evaluate(() => window.__mock.opened), [RELEASE_URL]);
}, { settings: existingUser(), before: githubReturns([{ ...WITH_FILES[0], assets: [{ name: "x.apk", state: "uploaded", browser_download_url: "https://example.com/x.apk" }] }]), userAgent: ANDROID_UA });

await test("Check now shows Download and the release page inside Settings, where the banner is hidden", async (page) => {
  await page.waitForSelector("#newNote");
  await page.click("#openSettings");
  await page.click('#settings button:has-text("Check now")');
  await page.waitForSelector('#settings .setting-actions button:has-text("Download")');
  assert.match(await page.textContent("#settings"), /Version 9\.9\.9 is available/);
  assert.match(await page.textContent("#settings"), /Your browser downloads the file/);
  await page.click('#settings .setting-actions button:has-text("Download")');
  await page.click('#settings .setting-actions button:has-text("Open the release page")');
  assert.deepEqual(await page.evaluate(() => window.__mock.opened), [`${FILES9}/ScaleNote_9.9.9_arm64-debug.apk`, RELEASE_URL]);
}, { settings: existingUser({ updates: false }), before: githubReturns(WITH_FILES), userAgent: ANDROID_UA });

await test("in Settings with no matching file there is one button, for the release page", async (page) => {
  await page.waitForSelector("#newNote");
  await page.click("#openSettings");
  await page.click('#settings button:has-text("Check now")');
  await page.waitForSelector('#settings .setting-actions button');
  assert.equal(await page.locator("#settings .setting-actions button").count(), 1);
  assert.equal((await page.textContent("#settings .setting-actions button")).trim(), "Open the release page");
}, { settings: existingUser({ updates: false }), before: githubReturns(WITH_FILES), userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15" });

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
  const box = page.locator('#settings .setting-row:has-text("new versions") input');
  assert.equal(await box.isChecked(), true);
  await box.uncheck();
  assert.equal(JSON.parse(await page.evaluate(() => window.__mock.getSettings())).updates, false);
  assert.match(await page.textContent("#settings"), /Nothing from your pages is sent/);
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

// ---------- 0.2.2: folder menu, dialogs, text sizes, toggles ----------

const FOLDER_SETTINGS = { vaultPath: "/home/alice/Documents/ScaleNote", recentVaults: ["/home/alice/Documents/ScaleNote", "/home/alice/Work", "/home/alice/gone"], disclosureAccepted: true, lastSeenVersion: VERSION, updates: false };
const settingsNow = (page) => page.evaluate(() => JSON.parse(window.__mock.getSettings()));

await test("the folder name opens a menu with recent folders, and choosing one switches to it", async (page) => {
  await page.waitForSelector("#vaultButton");
  await page.evaluate(() => window.__mock.files.set("Page.md", "hello\n"));
  await page.click("#newFolder");
  await page.click('.tree-button[data-path="Page.md"]');
  await page.waitForSelector(".note-body");
  await page.click(".note-body p");
  await page.keyboard.type(" edited");
  await page.click("#vaultButton");
  await page.waitForSelector(".folder-menu");
  const labels = await page.locator(".folder-menu .menu-item").allTextContents();
  assert.deepEqual(labels, ["ScaleNote", "Work", "gone", "Open another folder", "Use the default folder"]);
  assert.equal(await page.locator('.folder-menu [aria-current="true"]').count(), 1);
  assert.equal(await page.getAttribute("#vaultButton", "aria-expanded"), "true");
  await page.click('.folder-menu .menu-item:has-text("Work")');
  await page.waitForFunction(() => JSON.parse(window.__mock.getSettings()).vaultPath === "/home/alice/Work");
  assert.equal(await page.locator(".folder-menu").count(), 0);
  const now = await settingsNow(page);
  assert.deepEqual(now.recentVaults.slice(0, 3), ["/home/alice/Work", "/home/alice/Documents/ScaleNote", "/home/alice/gone"]);
  assert.ok((await files(page))["Page.md"].endsWith("hello edited\n"), "the open page was saved before switching");
  assert.equal(await page.isVisible("#welcome"), false, "no first-run screen");
}, { settings: FOLDER_SETTINGS });

await test("Open another folder goes straight to the picker, and Use the default folder works", async (page) => {
  await page.waitForSelector("#vaultButton");
  await page.click("#vaultButton");
  await page.click('.folder-menu .menu-item:has-text("Open another folder")');
  await page.waitForFunction(() => JSON.parse(window.__mock.getSettings()).vaultPath === "/picked/folder");
  assert.equal(await page.isVisible("#welcome"), false, "the first-run screen is not shown again");
  assert.equal((await settingsNow(page)).recentVaults[0], "/picked/folder");
  await page.click("#vaultButton");
  await page.click('.folder-menu .menu-item:has-text("Use the default folder")');
  await page.waitForFunction(() => JSON.parse(window.__mock.getSettings()).vaultPath === "/vault");
}, { settings: FOLDER_SETTINGS });

await test("the folder menu closes with Escape and by clicking elsewhere", async (page) => {
  await page.waitForSelector("#vaultButton");
  await page.click("#vaultButton");
  await page.waitForSelector(".folder-menu");
  await page.keyboard.press("Escape");
  assert.equal(await page.locator(".folder-menu").count(), 0);
  await page.click("#vaultButton");
  await page.mouse.click(700, 400);
  assert.equal(await page.locator(".folder-menu").count(), 0);
  assert.equal((await settingsNow(page)).vaultPath, FOLDER_SETTINGS.vaultPath, "nothing changed");
}, { settings: FOLDER_SETTINGS });

await test("a recent folder that cannot be opened gives a calm message and is removed from the list", async (page) => {
  await page.waitForSelector("#vaultButton");
  await page.click("#vaultButton");
  await page.click('.folder-menu .menu-item:has-text("gone")');
  await page.waitForSelector("#banner:not([hidden])");
  assert.match(await page.textContent("#bannerText"), /could not be opened, so it was removed/);
  const now = await settingsNow(page);
  assert.ok(!now.recentVaults.includes("/home/alice/gone"), JSON.stringify(now.recentVaults));
  assert.equal(now.vaultPath, FOLDER_SETTINGS.vaultPath, "the folder that was open stays the saved one");
}, { settings: FOLDER_SETTINGS });

await test("recent folders from a damaged settings file are cleaned, not trusted", async (page) => {
  await page.waitForSelector("#vaultButton");
  await page.click("#vaultButton");
  const labels = await page.locator(".folder-menu .menu-item").allTextContents();
  assert.deepEqual(labels.slice(0, 2), ["ScaleNote", "Work"]);
  assert.equal(labels.length, 4, "the bad entries are gone: " + labels);
}, { settings: { ...FOLDER_SETTINGS, recentVaults: [5, null, "", "/home/alice/Work", "/home/alice/Work", "bad\u0000path", { a: 1 }] } });

await test("Settings and What's new close with Escape or by clicking outside the box; the first-run screens do not", async (page) => {
  await page.waitForSelector("#vaultButton");
  await page.click("#openSettings");
  await page.waitForSelector("#settings[open]");
  await page.keyboard.press("Escape");
  assert.equal(await page.isVisible("#settings"), false);
  await page.click("#openSettings");
  const box = await page.locator("#settings").boundingBox();
  await page.mouse.click(box.x + box.width / 2, box.y + 20); // inside: stays open
  assert.equal(await page.isVisible("#settings"), true);
  await page.mouse.click(5, 5); // outside
  assert.equal(await page.isVisible("#settings"), false);
  await page.click("#updateDetails");
  await page.waitForSelector("#whatsnew[open]");
  await page.mouse.click(5, 5);
  assert.equal(await page.isVisible("#whatsnew"), false);
}, { settings: { ...FOLDER_SETTINGS, updates: true }, before: githubReturns(NEWER) });

await test("the first-run disclosure and folder choice cannot be dismissed", async (page) => {
  await page.waitForSelector("#disclosure[open]");
  await page.keyboard.press("Escape");
  await page.mouse.click(5, 5);
  assert.equal(await page.isVisible("#disclosure"), true);
  await page.click("#disclosure button");
  await page.waitForSelector("#welcome[open]");
  await page.keyboard.press("Escape");
  await page.mouse.click(5, 5);
  assert.equal(await page.isVisible("#welcome"), true);
});

await test("there are five text sizes, the smallest is 80 percent, and the icons scale with the text", async (page) => {
  await page.waitForSelector("#vaultButton");
  const iconWidth = () => page.evaluate(() => document.querySelector("#newNote svg").getBoundingClientRect().width);
  const normal = await iconWidth();
  await page.click("#openSettings");
  const options = await page.locator("#settings select").nth(1).locator("option").allTextContents();
  assert.deepEqual(options, ["Smallest", "Small", "Normal", "Large", "Largest"]);
  await page.locator("#settings select").nth(1).selectOption("80");
  assert.equal(await page.evaluate(() => document.documentElement.style.fontSize || getComputedStyle(document.documentElement).fontSize), "80%");
  const small = await iconWidth();
  await page.locator("#settings select").nth(1).selectOption("125");
  const large = await iconWidth();
  assert.ok(small < normal && normal < large, `icon widths ${small}, ${normal}, ${large}`);
  assert.equal((await settingsNow(page)).fontSize, 125);
}, { settings: FOLDER_SETTINGS });

await test("the sidebar says page, not note", async (page) => {
  await page.waitForSelector("#vaultButton");
  assert.equal(await page.textContent("#newNote"), "New page");
  assert.match(await page.textContent("#empty"), /Open a page from the list/);
  const text = await page.evaluate(() => document.getElementById("app").innerText);
  assert.ok(!/\bnotes?\b/i.test(text), "the word note is still on screen: " + text);
}, { settings: FOLDER_SETTINGS });

const TOGGLE = ["Intro", "", "<details>", "<summary>Title</summary>", "", "Hello", "", "flip", "", "</details>", ""].join("\n");

await test("a toggle folds and unfolds, and folding is not an edit", async (page) => {
  await openSeeded(page, "T.md", TOGGLE);
  await page.waitForSelector(".toggle");
  const state = () => page.evaluate(() => ({ folded: document.querySelector(".toggle").classList.contains("folded"), body: getComputedStyle(document.querySelector(".toggle-body")).display, expanded: document.querySelector(".toggle-fold").getAttribute("aria-expanded") }));
  assert.deepEqual(await state(), { folded: false, body: "block", expanded: "true" });
  await page.click(".toggle-fold");
  assert.deepEqual(await state(), { folded: true, body: "none", expanded: "false" });
  // Typing in the title must not unfold it.
  await page.click(".toggle-summary");
  await page.keyboard.type("x");
  assert.equal((await state()).folded, true);
  await page.click(".toggle-fold");
  assert.deepEqual(await state(), { folded: false, body: "block", expanded: "true" });
  await page.waitForTimeout(700);
  await waitSaved(page).catch(() => {});
  const saved = (await files(page))["T.md"];
  assert.ok(saved.includes("<summary>Titlex</summary>"), saved);
  assert.ok(!/folded/.test(saved), "the fold state is never written to the page");
});

await test("a toggle shows only its arrow and title until you work in it", async (page) => {
  await openSeeded(page, "T.md", TOGGLE);
  await page.waitForSelector(".toggle");
  const edge = (selector) => page.evaluate((sel) => { const c = getComputedStyle(document.querySelector(sel)); return [c.borderTopColor, c.backgroundColor]; }, selector);
  const clear = (rgba) => /rgba\(0, 0, 0, 0\)|transparent/.test(rgba);
  await page.locator(".note-body p").first().click(); // outside the toggle
  assert.ok(clear((await edge(".toggle"))[0]), "no outline around the block");
  assert.ok(clear((await edge(".toggle-summary"))[0]) && clear((await edge(".toggle-summary"))[1]), "no field around the title");
  await page.click(".toggle-summary");
  assert.ok(!clear((await edge(".toggle"))[0]), "outline while working in the toggle");
  assert.ok(!clear((await edge(".toggle-summary"))[0]), "the title field shows when selected");
  await page.locator(".note-body p").first().click();
  assert.ok(clear((await edge(".toggle"))[0]), "hidden again after leaving");
});

await test("on a phone the note list is open at the start", async (page) => {
  await page.waitForSelector("#newNote");
  assert.equal(await page.evaluate(() => document.body.classList.contains("sidebar-open")), true);
  assert.equal(await page.isVisible("#sidebar"), true);
}, { viewport: { width: 390, height: 780 }, settings: existingUser({ updates: false }) });

// ---------- 0.2.4: the right-click menu and renaming in the page list ----------

const ctxOpts = { settings: existingUser({ updates: false }) };
const treeNames = (page) => page.evaluate(() => [...document.querySelectorAll(".tree-label")].map((n) => n.textContent));
async function withFolderAndPage(page) {
  await page.waitForSelector("#newNote");
  await page.evaluate(() => { window.__mock.folders.add("Biology"); window.__mock.files.set("Biology/Cells.md", "cells\n"); window.__mock.files.set("Plan.md", "plan\n"); });
  await page.click("#newFolder"); // draws the list again; also adds "New folder", which these tests ignore
  await page.waitForSelector('.tree-button[data-path="Biology"]');
}

await test("right-clicking a folder opens a menu with Rename, and renaming keeps the pages inside", async (page) => {
  await withFolderAndPage(page);
  const prevented = await page.evaluate(() => new Promise((resolve) => {
    const b = document.querySelector('.tree-button[data-path="Biology"]');
    b.addEventListener("contextmenu", (e) => queueMicrotask(() => resolve(e.defaultPrevented)), { once: true });
    b.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 60, clientY: 80 }));
  }));
  assert.equal(prevented, true, "the browser's own menu is replaced");
  await page.waitForSelector(".context-menu");
  assert.deepEqual(await page.locator(".context-menu .menu-item").allTextContents(), ["Rename", "Icon", "Move to", "Delete"]);
  await page.click(".context-menu .menu-item");
  assert.equal(await page.locator(".context-menu").count(), 0, "the menu closes after choosing");
  const input = page.locator(".inline-rename");
  assert.equal(await input.inputValue(), "Biology");
  assert.equal(await page.evaluate(() => document.activeElement.className), "inline-rename");
  await input.fill("Plants");
  await page.keyboard.press("Enter");
  await page.waitForSelector('.tree-button[data-path="Plants"]');
  const state = await page.evaluate(() => ({ folders: [...window.__mock.folders], files: [...window.__mock.files.keys()] }));
  assert.ok(state.folders.includes("Plants") && !state.folders.includes("Biology"), JSON.stringify(state));
  assert.ok(state.files.includes("Plants/Cells.md") && !state.files.includes("Biology/Cells.md"), JSON.stringify(state));
}, ctxOpts);

await test("right-clicking a page renames it, and an open page follows its new name", async (page) => {
  await withFolderAndPage(page);
  await page.click('.tree-button[data-path="Plan.md"]');
  await page.waitForSelector("#editor .note-body");
  await page.locator(".note-body p").click();
  await page.keyboard.type(" more");
  await page.click('.tree-button[data-path="Plan.md"]', { button: "right" });
  await page.click(".context-menu .menu-item");
  const input = page.locator(".inline-rename");
  assert.equal(await input.inputValue(), "Plan", "the .md ending is not shown");
  await input.fill("Schedule");
  await page.keyboard.press("Enter");
  await page.waitForSelector('.tree-button[data-path="Schedule.md"]');
  assert.equal(await page.inputValue("#title"), "Schedule");
  const saved = await files(page);
  assert.ok(!("Plan.md" in saved) && /plan more/.test(saved["Schedule.md"]), "what was typed before the rename is kept: " + JSON.stringify(saved["Schedule.md"]));
}, ctxOpts);

await test("the menu closes with Escape or a click elsewhere, and Escape in the name field changes nothing", async (page) => {
  await withFolderAndPage(page);
  await page.click('.tree-button[data-path="Biology"]', { button: "right" });
  await page.waitForSelector(".context-menu");
  await page.keyboard.press("Escape");
  assert.equal(await page.locator(".context-menu").count(), 0);
  await page.click('.tree-button[data-path="Biology"]', { button: "right" });
  await page.waitForSelector(".context-menu");
  await page.click("#empty");
  assert.equal(await page.locator(".context-menu").count(), 0);
  await page.click('.tree-button[data-path="Biology"]', { button: "right" });
  await page.click(".context-menu .menu-item");
  await page.locator(".inline-rename").fill("Nope");
  await page.keyboard.press("Escape");
  await page.waitForSelector('.tree-button[data-path="Biology"]');
  assert.ok(!(await treeNames(page)).includes("Nope"));
  assert.equal(await page.evaluate(() => window.__mock.folders.has("Biology")), true);
}, ctxOpts);

await test("F2 renames the focused entry, and clicking inside the name field does not fold or open it", async (page) => {
  await withFolderAndPage(page);
  await page.focus('.tree-button[data-path="Biology"]');
  await page.keyboard.press("F2");
  const input = page.locator(".inline-rename");
  await input.waitFor();
  await input.click();
  await input.click();
  assert.equal(await page.locator(".inline-rename").count(), 1, "still editing after clicks in the field");
  assert.equal(await page.locator('.tree-button[data-path="Biology/Cells.md"]').count(), 0, "the folder did not open");
  await page.keyboard.press("Space");
  await input.fill("Life");
  await page.keyboard.press("Enter");
  await page.waitForSelector('.tree-button[data-path="Life"]');
}, ctxOpts);

await test("a name that is taken or empty leaves things as they are and says so calmly", async (page) => {
  await withFolderAndPage(page);
  await page.evaluate(() => window.__mock.folders.add("Chemistry"));
  await page.click("#newFolder");
  await page.click('.tree-button[data-path="Biology"]', { button: "right" });
  await page.click(".context-menu .menu-item");
  await page.locator(".inline-rename").fill("Chemistry");
  await page.keyboard.press("Enter");
  await page.waitForSelector("#banner:not([hidden])");
  assert.equal(await page.evaluate(() => window.__mock.folders.has("Biology")), true);
  await page.click('.tree-button[data-path="Biology"]', { button: "right" });
  await page.click(".context-menu .menu-item");
  await page.locator(".inline-rename").fill("   ");
  await page.keyboard.press("Enter");
  await page.waitForSelector('.tree-button[data-path="Biology"]');
  assert.equal(await page.locator(".inline-rename").count(), 0);
}, ctxOpts);

await test("the menu stays inside the window when opened near the bottom right", async (page) => {
  await withFolderAndPage(page);
  await page.evaluate(() => document.querySelector('.tree-button[data-path="Biology"]').dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: window.innerWidth - 2, clientY: window.innerHeight - 2 })));
  const box = await page.locator(".context-menu").boundingBox();
  const size = await page.evaluate(() => ({ w: innerWidth, h: innerHeight }));
  assert.ok(box.x >= 0 && box.y >= 0 && box.x + box.width <= size.w && box.y + box.height <= size.h, JSON.stringify({ box, size }));
}, ctxOpts);

// ---------- 0.2.5: moving pages and folders in the page list ----------

async function dragEntry(page, fromPath, to, { drop = true } = {}) {
  const from = await page.locator(`.tree-button[data-path="${fromPath}"]`).boundingBox();
  let x, y;
  if (to === "empty") {
    const tree = await page.locator("#tree").boundingBox();
    x = tree.x + tree.width / 2; y = tree.y + tree.height - 20;
  } else {
    const target = await page.locator(`.tree-button[data-path="${to}"]`).boundingBox();
    x = target.x + target.width / 2; y = target.y + target.height / 2;
  }
  await page.mouse.move(from.x + 30, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(from.x + 30, from.y + from.height / 2 + 20, { steps: 4 });
  await page.mouse.move(x, y, { steps: 8 });
  if (drop) await page.mouse.up();
}
const mockState = (page) => page.evaluate(() => ({ folders: [...window.__mock.folders].filter(Boolean).sort(), files: [...window.__mock.files.keys()].sort() }));
async function moveSetup(page) {
  await page.waitForSelector("#newNote");
  await page.evaluate(() => {
    for (const f of ["Biology", "Archive", "Archive/Old"]) window.__mock.folders.add(f);
    window.__mock.files.set("Biology/Cells.md", "cells\n");
    window.__mock.files.set("Plan.md", "plan\n");
    window.__mock.files.set("Archive/Old/Deep.md", "deep\n");
  });
  await page.click("#newFolder");
  await page.waitForSelector('.tree-button[data-path="Biology"]');
}

await test("dragging a page onto a folder moves it in, shows a preview while dragging, and opens the folder", async (page) => {
  await moveSetup(page);
  await dragEntry(page, "Plan.md", "Biology", { drop: false });
  assert.equal(await page.locator(".drag-preview").count(), 1, "a preview follows the pointer");
  assert.match(await page.textContent(".drag-preview"), /Plan/);
  assert.equal(await page.locator(".tree-row.drop-target").count(), 1, "the receiving folder is marked");
  await page.mouse.up();
  await page.waitForSelector('.tree-button[data-path="Biology/Plan.md"]');
  assert.equal(await page.locator(".drag-preview").count(), 0);
  assert.equal(await page.evaluate(() => document.body.classList.contains("tree-dragging")), false);
  const state = await mockState(page);
  assert.ok(state.files.includes("Biology/Plan.md") && !state.files.includes("Plan.md"), JSON.stringify(state));
  assert.equal(await page.locator('.tree-button[data-path="Plan.md"]').count(), 0);
}, { settings: existingUser({ updates: false }) });

await test("dragging a folder moves everything in it, and dragging to the empty space moves to the top", async (page) => {
  await moveSetup(page);
  await dragEntry(page, "Biology", "Archive");
  await page.waitForSelector('.tree-button[data-path="Archive/Biology"]');
  let state = await mockState(page);
  assert.ok(state.files.includes("Archive/Biology/Cells.md") && !state.folders.includes("Biology"), JSON.stringify(state));
  await dragEntry(page, "Archive/Biology", "empty");
  await page.waitForSelector('.tree-button[data-path="Biology"]');
  state = await mockState(page);
  assert.ok(state.files.includes("Biology/Cells.md") && !state.folders.includes("Archive/Biology"), JSON.stringify(state));
}, { settings: existingUser({ updates: false }) });

await test("a folder cannot be dropped into itself or below itself, and Escape cancels a drag", async (page) => {
  await moveSetup(page);
  await page.click('.tree-button[data-path="Archive"]'); // open it, so its subfolder is in the list
  await page.waitForSelector('.tree-button[data-path="Archive/Old"]');
  const before = await mockState(page);
  await dragEntry(page, "Archive", "Archive/Old", { drop: false });
  assert.equal(await page.locator(".tree-row.drop-target").count(), 0, "no folder is offered");
  await page.mouse.up();
  await dragEntry(page, "Archive", "Archive", { drop: false });
  assert.equal(await page.locator(".tree-row.drop-target").count(), 0);
  await page.mouse.up();
  await dragEntry(page, "Plan.md", "Biology", { drop: false });
  await page.keyboard.press("Escape");
  assert.equal(await page.locator(".drag-preview").count(), 0, "Escape ends the drag");
  await page.mouse.up();
  assert.deepEqual(await mockState(page), before, "nothing moved");
}, { settings: existingUser({ updates: false }) });

await test("a drag does not open the page it started on, and a plain click still does", async (page) => {
  await moveSetup(page);
  await dragEntry(page, "Plan.md", "Biology", { drop: false });
  await page.mouse.up();
  await page.waitForSelector('.tree-button[data-path="Biology/Plan.md"]');
  assert.equal(await page.locator(".tree-row.current").count(), 0, "no page was opened by the drag");
  await page.click('.tree-button[data-path="Biology/Plan.md"]');
  await page.waitForSelector("#editor .note-body");
}, { settings: existingUser({ updates: false }) });

await test("a name that is already taken in the target stops the move and says so", async (page) => {
  await moveSetup(page);
  await page.evaluate(() => window.__mock.files.set("Biology/Plan.md", "other\n"));
  await page.click("#newFolder");
  await dragEntry(page, "Plan.md", "Biology");
  await page.waitForSelector("#banner:not([hidden])");
  assert.match(await page.textContent("#bannerText"), /already exists/);
  const state = await mockState(page);
  assert.ok(state.files.includes("Plan.md") && state.files.includes("Biology/Plan.md"), JSON.stringify(state));
}, { settings: existingUser({ updates: false }) });

await test("moving the open page keeps what was typed and keeps the page open", async (page) => {
  await moveSetup(page);
  await page.click('.tree-button[data-path="Plan.md"]');
  await page.waitForSelector("#editor .note-body");
  await page.locator(".note-body p").click();
  await page.keyboard.type(" typed");
  await dragEntry(page, "Plan.md", "Biology");
  await page.waitForSelector('.tree-button[data-path="Biology/Plan.md"]');
  const saved = await files(page);
  assert.ok(/plan typed/.test(saved["Biology/Plan.md"]) && !("Plan.md" in saved), JSON.stringify(saved));
  assert.equal(await page.inputValue("#title"), "Plan");
  assert.equal(await page.locator('.tree-row.current > .tree-button[data-path="Biology/Plan.md"]').count(), 1);
}, { settings: existingUser({ updates: false }) });

await test("the right-click menu has Move to, which lists only folders it can go to", async (page) => {
  await moveSetup(page);
  await page.click('.tree-button[data-path="Biology"]', { button: "right" });
  assert.deepEqual(await page.locator(".context-menu .menu-item").allTextContents(), ["Rename", "Icon", "Move to", "Delete"]);
  await page.click(".context-menu .menu-item:has-text('Move to')");
  const names = await page.locator(".context-menu .menu-item").allTextContents();
  assert.ok(names.includes("Archive") && names.includes("Old") && !names.includes("Biology"), JSON.stringify(names));
  assert.equal(names.includes("Top level"), false, "it is already at the top");
  await page.click(".context-menu .menu-item:has-text('Archive')");
  await page.waitForSelector('.tree-button[data-path="Archive/Biology"]');
  await page.click('.tree-button[data-path="Archive/Biology"]', { button: "right" });
  await page.click(".context-menu .menu-item:has-text('Move to')");
  await page.click(".context-menu .menu-item:has-text('Top level')");
  await page.waitForSelector('.tree-button[data-path="Biology"]');
}, { settings: existingUser({ updates: false }) });

// ---------- 0.2.5: block editing polish ----------

await test("a see-through copy of the block follows the pointer while it is dragged, and the original stays", async (page) => {
  await openSeeded(page, "G.md", GUT);
  await page.locator(".note-body p", { hasText: "First" }).click();
  await page.waitForSelector(".gutter-handle:not([hidden])");
  const original = await page.locator(".note-body > *", { hasText: "First" }).first().boundingBox();
  await page.locator(".gutter-handle").hover();
  const h = await page.locator(".gutter-handle").boundingBox();
  await page.mouse.down();
  await page.mouse.move(h.x + 16, h.y + 16 + 30, { steps: 4 });
  await page.mouse.move(h.x + 16, h.y + 16 + 80, { steps: 4 });
  await page.waitForSelector(".drag-ghost");
  const ghost = await page.locator(".drag-ghost").boundingBox();
  assert.match(await page.textContent(".drag-ghost"), /First/);
  assert.ok(Math.abs(ghost.y - (original.y + 80)) <= 3, `the copy keeps the grab distance: ${ghost.y} vs ${original.y + 80}`);
  assert.ok(Number(await page.evaluate(() => getComputedStyle(document.querySelector(".drag-ghost")).opacity)) < 1, "it is see-through");
  assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector(".drag-ghost")).pointerEvents), "none");
  assert.equal(await page.locator(".note-body > *", { hasText: "First" }).count(), 1, "the original is still in the page");
  assert.equal(await page.locator(".drag-ghost [id], .drag-ghost [contenteditable]").count(), 0, "the copy has no ids or editable parts");
  await page.keyboard.press("Escape");
  await page.mouse.up();
  assert.equal(await page.locator(".drag-ghost").count(), 0, "the copy is gone after the drag");
});

// Selects "First" and "Second" together with the keyboard.
async function selectFirstTwo(page) {
  await page.locator(".note-body p", { hasText: "First" }).click();
  await page.keyboard.press("Home");
  await page.keyboard.down("Shift");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("End");
  await page.keyboard.up("Shift");
  // The editor learns about a selection made with the keyboard a moment later; the bar showing
  // up is the sign that it has.
  await page.waitForSelector(".float-bar:not([hidden])");
}

await test("several selected blocks move together by dragging, and one Undo puts them back", async (page) => {
  await openSeeded(page, "G.md", GUT);
  await selectFirstTwo(page);
  const before = await order(page);
  await page.waitForSelector(".gutter-handle:not([hidden])");
  await page.locator(".gutter-handle").hover();
  const h = await page.locator(".gutter-handle").boundingBox();
  const last = await page.locator(".note-body > *", { hasText: "Last" }).first().boundingBox();
  await page.mouse.down();
  await page.mouse.move(h.x + 16, h.y + 16 + 30, { steps: 3 });
  await page.waitForSelector(".drag-ghost");
  assert.match(await page.textContent(".drag-ghost"), /First[\s\S]*Second/, "the copy holds both blocks");
  await page.mouse.move(h.x + 16, last.y + last.height - 2, { steps: 10 });
  await page.mouse.up();
  const after = await order(page);
  assert.ok(after.indexOf("Last") < after.indexOf("First") && after.indexOf("First") + 1 === after.indexOf(after.find((x) => x.startsWith("Second"))), "First and Second now come after Last, in the same order: " + JSON.stringify(after));
  await page.keyboard.press("Control+z");
  assert.deepEqual(await order(page), before, "one Undo restores both");
});

await test("with several blocks selected the menu and Alt+Arrow act on all of them", async (page) => {
  await openSeeded(page, "G.md", GUT);
  await selectFirstTwo(page);
  await page.keyboard.press("Alt+ArrowDown");
  let now = await order(page);
  const firstAt = now.findIndex((x) => x.startsWith("First"));
  assert.ok(firstAt > 1 && now[firstAt + 1].startsWith("Second"), "both moved down one place together: " + JSON.stringify(now));
  await page.waitForSelector(".gutter-handle:not([hidden])");
  await page.click(".gutter-handle");
  const items = await page.locator(".gutter-menu .menu-item").allTextContents();
  assert.ok(!items.includes("Copy block link") && !items.includes("Heading 1"), "single-block actions are not offered: " + JSON.stringify(items));
  await page.click(".gutter-menu .menu-item:has-text('Delete')");
  now = await order(page);
  assert.ok(!now.some((x) => x.startsWith("First") || x.startsWith("Second")), "both were deleted: " + JSON.stringify(now));
});

await test("the plus button adds an empty block below and puts the cursor in it", async (page) => {
  await openSeeded(page, "G.md", GUT);
  await page.locator(".note-body p", { hasText: "First" }).click();
  await page.waitForSelector(".gutter-plus:not([hidden])");
  // Read both boxes in one browser call, and wait for the layout to settle: two separate
  // reads can straddle a refresh and see the buttons at different moments.
  const box = () => page.evaluate(() => {
    const r = (s) => { const b = document.querySelector(s).getBoundingClientRect(); return { x: b.x, y: b.y, width: b.width }; };
    return { p: r(".gutter-plus"), h: r(".gutter-handle") };
  });
  let last = await box();
  for (let i = 0; i < 20 && Math.abs(last.p.y - last.h.y) > 1; i++) {
    await page.waitForTimeout(100);
    last = await box();
  }
  const { p, h } = last;
  assert.ok(p.x + p.width <= h.x + 1 && Math.abs(p.y - h.y) <= 1, "the plus sits left of the grip on the same line: plus " + JSON.stringify(p) + " grip " + JSON.stringify(h));
  await page.click(".gutter-plus");
  await page.keyboard.type("brand new");
  const now = await order(page);
  assert.equal(now[now.findIndex((x) => x.startsWith("First")) + 1], "brand new", JSON.stringify(now));
}, { viewport: { width: 1400, height: 800 } });

// ---------- text styles: highlight, underline, subscript, superscript, colour ----------
const STYLED = 'Plain ==marked== and <u>under</u> and H<sub>2</sub>O x<sup>2</sup> and <span style="color:#F72525">red</span> end\n';
const bodyOf = (text) => text.replace(/^---\n(id: [^\n]*\n)?---\n\n/, "");
const select = async (page, from, to) => {
  // Selects the characters from..to of the first paragraph's text. Done with a DOM range, not
  // arrow keys, because the cursor takes an extra step at the edge of every styled stretch.
  await page.locator(".note-body p").first().click();
  await page.evaluate(([a, b]) => {
    const paragraph = document.querySelector(".note-body p");
    const walker = document.createTreeWalker(paragraph, NodeFilter.SHOW_TEXT);
    let offset = 0;
    let start = null;
    let end = null;
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const length = node.textContent.length;
      if (start === null && a <= offset + length) start = [node, a - offset];
      if (b <= offset + length) { end = [node, b - offset]; break; }
      offset += length;
    }
    getSelection().setBaseAndExtent(start[0], start[1], end[0], end[1]);
  }, [from, to]);
  // The editor reads the new selection on the browser's own event, a moment later.
  await page.waitForTimeout(150);
  await page.waitForSelector(".float-bar:not([hidden])");
};

await test("styled text opens as styles, shown as such, and an untouched note stays byte for byte", async (page) => {
  await openSeeded(page, "S.md", STYLED);
  const dom = await page.evaluate(() => ({
    mark: document.querySelector(".note-body mark.text-highlight")?.textContent,
    u: document.querySelector(".note-body u")?.textContent,
    sub: document.querySelector(".note-body sub")?.textContent,
    sup: document.querySelector(".note-body sup")?.textContent,
    red: document.querySelector(".note-body span.sn-text-red")?.textContent,
    raw: document.querySelectorAll(".raw-block").length,
    inline: document.querySelectorAll(".note-body [style]").length,
  }));
  assert.deepEqual(dom, { mark: "marked", u: "under", sub: "2", sup: "2", red: "red", raw: 0, inline: 0 });
  // The colour really is drawn (class, not an inline style attribute: the page forbids those).
  // STYLED holds a colour in the form 0.2.9 wrote (a colour code); it is read as the colour with that name.
  assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector(".note-body span.sn-text-red")).color), "rgb(207, 81, 72)", "Notion's red, light shade");
  await page.waitForTimeout(800);
  assert.equal((await files(page))["S.md"], STYLED, "nothing was rewritten");
});

await test("editing next to styled text keeps every style and writes them in one spelling", async (page) => {
  await openSeeded(page, "S.md", STYLED);
  await page.locator(".note-body p").click();
  await page.keyboard.press("End");
  await page.keyboard.type(" more");
  await waitSaved(page);
  const text = (await files(page))["S.md"];
  for (const part of ["==marked==", "<u>under</u>", "H<sub>2</sub>O", "x<sup>2</sup>", '<span class="sn-text-red">red</span>', "end more"]) assert.ok(text.includes(part), `${part} in ${JSON.stringify(text)}`);
});

await test("markers the editor cannot keep safely stay raw blocks and are never changed", async (page) => {
  const raws = ["a <b>bold</b> b", "a <u>unclosed", "a <u>b <sub>c</u> d</sub>", 'x <span style="color:#123456">y</span> z', "a ==b == c", "a <mark>m</mark> <u>u</u>", 'x <span class="sn-text-chartreuse">y</span> z', 'x <span class="sn-text-red sn-text-blue">y</span> z', 'x <span class="other">y</span> z', 'x <span class="sn-bg-red">y <span class="sn-text-blue">z</span></span>'];
  const note = ["Normal one", ...raws].join("\n\n") + "\n";
  await openSeeded(page, "R.md", note);
  assert.equal(await page.locator(".raw-block").count(), raws.length);
  await page.locator(".note-body p").first().click();
  await page.keyboard.press("End");
  await page.keyboard.type(" edited");
  await waitSaved(page);
  const saved = (await files(page))["R.md"].replace(/id: [0-9a-f-]{20,}\n/, "");
  assert.ok(saved.includes("Normal one edited"));
  for (const raw of raws) assert.ok(saved.includes(raw), `${raw} is unchanged`);
});

await test("styles inside a callout, a toggle and a table are kept when the block is edited", async (page) => {
  const note = [
    "> [!note] Title",
    "> a ==marked== and <u>under</u>",
    "",
    "<details>",
    "<summary>Sum</summary>",
    "",
    "x <sub>2</sub> y",
    "",
    "</details>",
    "",
    "| a | b |",
    "| - | - |",
    "| <u>u</u> | ==h== |",
    "",
    "Last",
    "",
  ].join("\n");
  await openSeeded(page, "Rich2.md", note);
  await page.waitForTimeout(500);
  assert.equal((await files(page))["Rich2.md"], note, "an untouched note stays byte for byte");
  // Edit the callout text, then check nothing styled was lost anywhere. (A table with html in its
  // cells is kept as a raw block, so it is written back exactly as it was.)
  await page.locator(".callout p").last().click();
  await page.keyboard.press("End");
  await page.keyboard.type(" more");
  await waitSaved(page);
  const saved = (await files(page))["Rich2.md"];
  // (typing at the end of underlined text continues the underline, as in any editor)
  for (const part of ["==marked==", "<u>under more</u>", "<sub>2</sub>", "| <u>u</u> | ==h== |"]) assert.ok(saved.includes(part), `${part} in ${JSON.stringify(saved)}`);
  assert.ok(saved.includes(" more"));
});

await test("the selection bar makes underline, highlight, subscript, superscript and colour", async (page) => {
  await openSeeded(page, "T.md", "alpha beta gamma delta epsilon\n");
  await select(page, 0, 5);
  await page.click('.float-bar [aria-label="Underline"]');
  await page.click('.float-bar [aria-label="Highlight"]');
  await select(page, 6, 10);
  await page.click('.float-bar [aria-label="Subscript"]');
  await select(page, 11, 16);
  await page.click('.float-bar [aria-label="Superscript"]');
  await select(page, 17, 22);
  await page.click('.float-bar [aria-label="Colour"]');
  await page.waitForSelector(".colour-menu:not([hidden])");
  await page.click('.colour-menu [aria-label="Red text"]');
  assert.equal(await page.isVisible(".colour-menu"), false, "choosing a colour closes the palette");
  assert.match(await page.getAttribute(".float-bar .colour-letter", "class"), /sn-text-red/, "the button shows the colour in use");
  await waitSaved(page);
  assert.equal(bodyOf((await files(page))["T.md"]), '<u>==alpha==</u> <sub>beta</sub> <sup>gamma</sup> <span class="sn-text-red">delta</span> epsilon\n');
  // clearing the colour
  await select(page, 17, 22);
  await page.click('.float-bar [aria-label="Colour"]');
  await page.click('.colour-menu [aria-label="Default text"]');
  await waitSaved(page);
  assert.ok(!(await files(page))["T.md"].includes("<span"));
  // and the style survives closing and reopening the note
  assert.equal(await page.locator(".raw-block").count(), 0);
}, { viewport: { width: 1100, height: 760 } });

await test("the colour palette has Notion's two rows, with default first, and the current choice marked", async (page) => {
  await openSeeded(page, "P.md", '<span class="sn-text-blue sn-bg-pink">alpha</span> beta\n');
  await select(page, 0, 5);
  await page.click('.float-bar [aria-label="Colour"]');
  await page.waitForSelector(".colour-menu:not([hidden])");
  const groups = await page.evaluate(() => [...document.querySelectorAll(".colour-menu [role=group]")].map((g) => ({
    label: g.getAttribute("aria-label"),
    tiles: [...g.querySelectorAll(".swatch")].map((t) => t.getAttribute("aria-label")),
    current: [...g.querySelectorAll('.swatch[aria-current="true"]')].map((t) => t.getAttribute("aria-label")),
  })));
  assert.equal(groups.length, 2);
  assert.equal(groups[0].label, "Text colour");
  assert.equal(groups[1].label, "Background colour");
  assert.deepEqual(groups[0].tiles, ["Default text", ...COLOURS.map((c) => `${c[0].toUpperCase()}${c.slice(1)} text`)]);
  assert.deepEqual(groups[1].tiles, ["Default background", ...COLOURS.map((c) => `${c[0].toUpperCase()}${c.slice(1)} background`)]);
  assert.deepEqual(groups[0].current, ["Blue text"]);
  assert.deepEqual(groups[1].current, ["Pink background"]);
  // The tiles are drawn with the colour classes, never with style attributes.
  assert.equal(await page.locator(".colour-menu [style]").count(), 0);
  assert.equal(await page.locator(".colour-menu .swatch.sn-bg-pink").count(), 1);
}, { viewport: { width: 1100, height: 760 } });

await test("text and background colours are set, combined in one span, and taken off separately", async (page) => {
  await openSeeded(page, "C.md", "alpha beta gamma delta\n");
  const choose = async (label) => {
    await select(page, 0, 5);
    await page.click('.float-bar [aria-label="Colour"]');
    await page.waitForSelector(".colour-menu:not([hidden])");
    await page.click(`.colour-menu [aria-label="${label}"]`);
    await waitSaved(page);
    return bodyOf((await files(page))["C.md"]);
  };
  assert.equal(await choose("Yellow background"), '<span class="sn-bg-yellow">alpha</span> beta gamma delta\n');
  assert.equal(await choose("Red text"), '<span class="sn-text-red sn-bg-yellow">alpha</span> beta gamma delta\n');
  assert.equal(await choose("Default background"), '<span class="sn-text-red">alpha</span> beta gamma delta\n');
  assert.equal(await choose("Green background"), '<span class="sn-text-red sn-bg-green">alpha</span> beta gamma delta\n');
  assert.equal(await choose("Default text"), '<span class="sn-bg-green">alpha</span> beta gamma delta\n');
  assert.equal(await choose("Default background"), "alpha beta gamma delta\n");
  assert.equal(await page.locator(".raw-block").count(), 0);
}, { viewport: { width: 1100, height: 760 } });

await test("choosing a text colour over pieces with different backgrounds keeps each background", async (page) => {
  await openSeeded(page, "M.md", '<span class="sn-bg-blue">one</span> <span class="sn-bg-pink">two</span> three\n');
  await select(page, 0, 7);
  await page.click('.float-bar [aria-label="Colour"]');
  await page.click('.colour-menu [aria-label="Green text"]');
  await waitSaved(page);
  const text = (await files(page))["M.md"];
  assert.ok(text.includes('<span class="sn-text-green sn-bg-blue">one</span>'), text);
  assert.ok(text.includes('<span class="sn-text-green sn-bg-pink">two</span>'), text);
  assert.ok(text.endsWith(" three\n"), text);
  assert.equal(await page.locator(".raw-block").count(), 0);
}, { viewport: { width: 1100, height: 760 } });

await test("the 0.2.9 colour form still opens as that colour, stays byte for byte, and is rewritten in the new form on edit", async (page) => {
  const old = 'a <span style="color:#339142">green</span> word\n';
  await openSeeded(page, "L.md", old);
  assert.equal(await page.locator(".note-body span.sn-text-green").textContent(), "green");
  await page.waitForTimeout(800);
  assert.equal((await files(page))["L.md"], old, "nothing rewritten without an edit");
  await page.locator(".note-body p").click();
  await page.keyboard.press("End");
  await page.keyboard.type("!");
  await waitSaved(page);
  assert.equal(bodyOf((await files(page))["L.md"]), 'a <span class="sn-text-green">green</span> word!\n');
}, { viewport: { width: 1100, height: 760 } });

for (const [label, scheme, theme, bg, text] of [
  ["a light system", "light", undefined, "rgb(249, 243, 220)", "rgb(166, 121, 43)"],
  ["a dark system", "dark", undefined, "rgb(80, 68, 37)", "rgb(203, 148, 52)"],
  ["the dark theme on a light system", "light", "dark", "rgb(80, 68, 37)", "rgb(203, 148, 52)"],
  ["the sepia theme on a dark system", "dark", "sepia", "rgb(249, 243, 220)", "rgb(166, 121, 43)"],
]) {
  await test(`colours take the light or dark shade of the theme: ${label}`, async (page) => {
    await openSeeded(page, "D.md", '<span class="sn-text-yellow sn-bg-yellow">shade</span>\n');
    // The named themes are chosen with this attribute on the page (appearance.js sets it).
    if (theme) await page.evaluate((name) => document.documentElement.setAttribute("data-theme", name), theme);
    const [b, t] = await page.evaluate(() => {
      const style = getComputedStyle(document.querySelector(".note-body .sn-bg-yellow"));
      return [style.backgroundColor, style.color];
    });
    assert.equal(b, bg);
    assert.equal(t, text);
  }, { scheme });
}

await test("Settings can make a copy for Obsidian, shows where it is, and reports a problem calmly", async (page) => {
  await openSeeded(page, "O.md", "plain\n");
  await page.click("#openSettings");
  const button = page.locator('#settings button:has-text("Make a copy for Obsidian")');
  await button.waitFor();
  assert.match(await page.textContent("#settings"), /background colours become a plain highlight/);
  await button.click();
  await page.waitForFunction(() => /copy is ready/.test(document.getElementById("settings").textContent));
  const done = await page.textContent("#settings");
  assert.match(done, /ready in \/home\/alice\/ScaleNote \(Obsidian copy\)/);
  assert.match(done, /3 pages \(1 had colours converted\) and 2 other files/);
  assert.doesNotMatch(done, /left out/);
  assert.equal(await page.evaluate(() => window.__exports), 1);
  // Files that were left out are mentioned.
  await page.evaluate(() => { window.__skippedExport = 4; });
  await button.click();
  await page.waitForFunction(() => /4 files were left out/.test(document.getElementById("settings").textContent));
  // A problem shows the matching sentence and the button works again.
  await page.evaluate(() => { window.__failExport = "io"; });
  await button.click();
  await page.waitForFunction(() => /could not read or write/.test(document.getElementById("settings").textContent));
  assert.equal(await button.isDisabled(), false);
  // Making a copy never touches the page that is open.
  assert.equal((await files(page))["O.md"], "plain\n");
}, { viewport: { width: 1100, height: 760 } });

await test("the Obsidian copy button is not offered on an Android phone", async (page) => {
  await openSeeded(page, "O.md", "plain\n");
  await page.click("#toggle"); // on a phone the page list (with Settings) is closed after a page opens
  await page.click("#openSettings");
  await page.waitForSelector("#settings .settings-body");
  assert.equal(await page.locator('#settings button:has-text("Make a copy for Obsidian")').count(), 0);
  assert.doesNotMatch(await page.textContent("#settings"), /Obsidian/);
}, { userAgent: ANDROID_UA, viewport: { width: 412, height: 860 } });

// ---------- 0.3.0: delete and trash ----------

const treePaths = (page) => page.$$eval(".tree-button", (b) => b.map((x) => x.dataset.path));
const treeItem = (page, p) => page.locator(`.tree-button[data-path="${p}"]`);
async function rightClick(page, p) {
  await treeItem(page, p).click({ button: "right" });
  await page.waitForSelector(".context-menu");
}
const trashed = (page) => page.evaluate(() => window.__mock.trashed.map((i) => ({ name: i.name, from: i.from, folder: i.is_folder, files: Object.fromEntries(i.files) })));

await test("Delete in the right-click menu moves a page to the trash without asking, and Restore puts it back unchanged", async (page) => {
  await withFolderAndPage(page);
  await page.click('.tree-button[data-path="Plan.md"]');
  await page.waitForSelector("#editor .note-body");
  await rightClick(page, "Plan.md");
  await page.click('.context-menu .menu-item:has-text("Delete")');
  await page.waitForFunction(() => !document.querySelector('.tree-button[data-path="Plan.md"]'));
  assert.match(await page.textContent("#toast"), /Moved to the trash: Plan/);
  assert.equal(await page.isVisible("#editor"), false, "the deleted page is closed");
  assert.equal(await page.isVisible("#empty"), true);
  assert.equal("Plan.md" in (await files(page)), false);
  assert.deepEqual((await trashed(page)).map((i) => [i.name, i.from]), [["Plan.md", ""]]);
  // The trash lists it, with where it came from, and Restore puts it back with the same text.
  await page.click("#openTrash");
  await page.waitForSelector("#trash[open] .trash-row");
  assert.match(await page.textContent("#trash .trash-row"), /Plan/);
  assert.match(await page.textContent("#trash .trash-row"), /From the top level/);
  await page.click('#trash .trash-row button:has-text("Restore")');
  await page.waitForSelector("#trash .trash-empty");
  assert.equal((await files(page))["Plan.md"], "plan\n");
  assert.match(await page.textContent("#toast"), /Restored: Plan/);
  await page.click('#trash button:has-text("Close")');
  assert.ok((await treePaths(page)).includes("Plan.md"), "it is in the list again");
}, ctxOpts);

await test("the Delete key moves the focused page to the trash, and a folder goes with everything in it", async (page) => {
  await withFolderAndPage(page);
  await page.click('.tree-button[data-path="Biology"]'); // opens the folder
  await page.click('.tree-button[data-path="Biology/Cells.md"]');
  await page.waitForSelector("#editor .note-body");
  await treeItem(page, "Biology").focus();
  await page.keyboard.press("Delete");
  await page.waitForFunction(() => !document.querySelector('.tree-button[data-path="Biology"]'));
  assert.equal(await page.isVisible("#editor"), false, "a page inside a deleted folder is closed too");
  assert.equal(await page.evaluate(() => [...window.__mock.folders].includes("Biology")), false);
  const items = await trashed(page);
  assert.equal(items.length, 1);
  assert.equal(items[0].folder, true);
  assert.equal(items[0].files["Cells.md"], "cells\n");
  // Focus is not lost to the page body.
  assert.equal(await page.evaluate(() => document.activeElement.closest("#tree") !== null), true);
  await page.click("#openTrash");
  await page.click('#trash .trash-row button:has-text("Restore")');
  await page.waitForSelector("#trash .trash-empty");
  await page.click('#trash button:has-text("Close")');
  assert.equal((await files(page))["Biology/Cells.md"], "cells\n");
  assert.ok((await treePaths(page)).includes("Biology"));
}, ctxOpts);

await test("what was typed just before deleting is in the trash, and no conflict copy appears", async (page) => {
  await openSeeded(page, "Typed.md", "start\n");
  await page.locator(".note-body p").click();
  await page.keyboard.press("End");
  await page.keyboard.type(" last words");
  await rightClick(page, "Typed.md");
  await page.click('.context-menu .menu-item:has-text("Delete")');
  await page.waitForFunction(() => !document.querySelector('.tree-button[data-path="Typed.md"]'));
  await page.waitForTimeout(1500); // longer than the save delay: a late save would show up now
  const items = await trashed(page);
  assert.match(items[0].files[""], /start last words/);
  assert.deepEqual(Object.keys(await files(page)).filter((n) => n.includes("Typed")), [], "nothing was written back");
});

await test("Delete forever and Empty trash ask first, Cancel keeps everything, and Cancel has the focus", async (page) => {
  await start(page);
  await page.evaluate(() => { window.__mock.files.set("One.md", "1\n"); window.__mock.files.set("Two.md", "2\n"); });
  await page.click("#newFolder");
  for (const p of ["One.md", "Two.md"]) { await treeItem(page, p).focus(); await page.keyboard.press("Delete"); await page.waitForFunction((x) => !document.querySelector(`.tree-button[data-path="${x}"]`), p); }
  await page.click("#openTrash");
  await page.waitForSelector("#trash .trash-row");
  assert.equal(await page.locator("#trash .trash-row").count(), 2);
  // Newest first.
  assert.match(await page.locator("#trash .trash-row").first().textContent(), /Two/);
  await page.locator('#trash .trash-row button:has-text("Delete forever")').first().click();
  assert.match(await page.textContent("#trash"), /cannot be brought back/);
  assert.equal(await page.evaluate(() => document.activeElement.textContent), "Cancel");
  await page.keyboard.press("Enter"); // Enter on the focused button cancels
  assert.equal(await page.locator("#trash .trash-row").count(), 2);
  assert.equal((await trashed(page)).length, 2);
  await page.locator('#trash .trash-row button:has-text("Delete forever")').first().click();
  await page.click('#trash button:has-text("Yes, delete")');
  await page.waitForFunction(() => document.querySelectorAll("#trash .trash-row").length === 1);
  assert.deepEqual((await trashed(page)).map((i) => i.name), ["One.md"]);
  // Empty trash also asks.
  await page.click('#trash button:has-text("Empty trash")');
  assert.match(await page.textContent("#trash"), /everything in the trash/);
  await page.click('#trash button:has-text("Cancel")');
  assert.equal((await trashed(page)).length, 1);
  await page.click('#trash button:has-text("Empty trash")');
  await page.click('#trash button:has-text("Yes, delete")');
  await page.waitForSelector("#trash .trash-empty");
  assert.equal((await trashed(page)).length, 0);
  assert.equal(await page.locator('#trash button:has-text("Empty trash")').count(), 0, "nothing to empty");
  await page.keyboard.press("Escape");
  assert.equal(await page.isVisible("#trash"), false);
});

await test("restoring while the old name is taken keeps both, and an item that is already gone is explained inside the box", async (page) => {
  await start(page);
  await page.evaluate(() => window.__mock.files.set("Same.md", "old\n"));
  await page.click("#newFolder");
  await treeItem(page, "Same.md").focus();
  await page.keyboard.press("Delete");
  await page.waitForFunction(() => !document.querySelector('.tree-button[data-path="Same.md"]'));
  await page.evaluate(() => window.__mock.files.set("Same.md", "new\n"));
  await page.click("#openTrash");
  await page.click('#trash button:has-text("Restore")');
  await page.waitForSelector("#trash .trash-empty");
  const now = await files(page);
  assert.equal(now["Same.md"], "new\n");
  assert.equal(now["Same (restored).md"], "old\n");
  // Another window emptied the trash in the meantime.
  await page.evaluate(() => window.__mock.files.set("Gone.md", "g\n"));
  await page.click('#trash button:has-text("Close")');
  await page.click("#newFolder");
  await treeItem(page, "Gone.md").focus();
  await page.keyboard.press("Delete");
  await page.waitForFunction(() => !document.querySelector('.tree-button[data-path="Gone.md"]'));
  await page.click("#openTrash");
  await page.waitForSelector("#trash .trash-row");
  await page.evaluate(() => { window.__mock.trashed.length = 0; });
  await page.click('#trash button:has-text("Delete forever")');
  await page.click('#trash button:has-text("Yes, delete")');
  await page.waitForSelector("#trash .trash-error");
  assert.match(await page.textContent("#trash .trash-error"), /already gone/);
});

// ---------- 0.3.0: search and commands ----------

// The box is ready when its input is empty and has the focus: typing before that can land in the
// old text or be lost, which made the search tests fail now and then on a slow machine.
const openPaletteBox = async (page) => {
  await page.keyboard.press("Control+k");
  await page.waitForSelector("#palette[open] .palette-input");
  await page.waitForFunction(() => {
    const input = document.querySelector("#palette .palette-input");
    return input && document.activeElement === input && input.value === "";
  });
};
// Escape closes the box a moment later. Opening it again before that finished would find the old box
// still open, and what is typed next would go into a box that is about to disappear.
const closePaletteBox = async (page) => { await page.keyboard.press("Escape"); await page.waitForSelector("#palette", { state: "hidden" }); };
const rowTexts = (page) => page.$$eval("#palette .palette-row", (r) => r.map((x) => x.textContent));

async function searchVault(page) {
  await start(page);
  await page.evaluate(() => {
    const f = window.__mock.files;
    window.__mock.folders.add("School");
    f.set("Biology.md", "Cells and Mitochondria\nthe powerhouse of the cell\n");
    f.set("School/Maths.md", "Nothing here\nthe quadratic formula\n");
    f.set("Plants.md", "all about plants\n");
    f.set("Notes on plants.md", "x\n");
    f.set("Html.md", "<b>bold</b> <img src=x onerror=\"window.__pwned=1\"> text\n");
  });
  await page.click("#newFolder");
}

await test("Ctrl+K opens the search box with recent pages and commands, and Escape closes it", async (page) => {
  await searchVault(page);
  await page.click('.tree-button[data-path="Biology.md"]');
  await page.waitForSelector("#editor .note-body");
  await page.click('.tree-button[data-path="Plants.md"]');
  await page.waitForFunction(() => document.querySelector("#title").value === "Plants");
  await openPaletteBox(page);
  assert.equal(await page.evaluate(() => document.activeElement.className), "palette-input");
  const texts = await rowTexts(page);
  assert.match(texts[0], /^Biology/, "the page that is open is not offered, the one before it is");
  assert.deepEqual(texts.slice(1), ["New page", "New folder", "Open settings", "Open trash", "Open tags", "Show or hide the page list", "Add or remove this page from favorites", "Show the history of this page", "Switch between the text and the canvas of this page", "Show or hide the markdown text of this page", "Export this page as markdown", "Print this page or save it as PDF"]);
  assert.equal(await page.getAttribute(".palette-input", "role"), "combobox");
  assert.equal(await page.getAttribute("#palette .palette-list", "role"), "listbox");
  assert.equal(await page.getAttribute(".palette-row >> nth=0", "aria-selected"), "true");
  assert.equal(await page.getAttribute(".palette-input", "aria-activedescendant"), await page.getAttribute(".palette-row >> nth=0", "id"));
  await page.keyboard.press("Escape");
  assert.equal(await page.isVisible("#palette"), false);
});

await test("typing finds pages by title and text, ranks titles first, marks the match, and Enter opens the page", async (page) => {
  await searchVault(page);
  await openPaletteBox(page);
  await page.keyboard.type("plants");
  await page.waitForSelector("#palette .palette-row .palette-title");
  const titles = await page.$$eval("#palette .palette-title", (t) => t.map((x) => x.textContent));
  assert.deepEqual(titles, ["Plants", "Notes on plants"], "the exact title first, then titles that contain it");
  await closePaletteBox(page);
  await openPaletteBox(page);
  await page.keyboard.type("quadratic");
  await page.waitForSelector('#palette .palette-title:has-text("Maths")');
  assert.equal(await page.locator("#palette .palette-where").first().textContent(), "School");
  assert.equal(await page.locator("#palette .palette-snippet mark").first().textContent(), "quadratic");
  assert.equal(await page.locator("#palette .palette-snippet").first().textContent(), "the quadratic formula");
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => document.querySelector("#title").value === "Maths");
  assert.equal(await page.isVisible("#palette"), false);
  assert.ok(await page.evaluate(() => document.querySelector('.tree-button[data-path="School/Maths.md"]')?.getAttribute("aria-current")) === "page");
});

await test("Up and Down move through the results, and Enter straight after typing opens the page typed for", async (page) => {
  await searchVault(page);
  await page.evaluate(() => { window.__searchDelay = 400; });
  await openPaletteBox(page);
  await page.keyboard.type("mitochondria");
  await page.keyboard.press("Enter"); // before the answer arrives
  await page.waitForFunction(() => document.querySelector("#title").value === "Biology", null, { timeout: 5000 });
  await page.evaluate(() => { window.__searchDelay = 0; });
  await openPaletteBox(page);
  await page.keyboard.type("plants");
  await page.waitForSelector("#palette .palette-title");
  await page.keyboard.press("ArrowDown");
  assert.equal(await page.locator("#palette .palette-row.active .palette-title").textContent(), "Notes on plants");
  await page.keyboard.press("ArrowDown");
  assert.match(await page.locator("#palette .palette-row.active").textContent(), /./);
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("ArrowUp");
  assert.equal(await page.getAttribute(".palette-input", "aria-activedescendant"), await page.locator("#palette .palette-row").last().getAttribute("id"), "it wraps around");
});

await test("an older answer arriving late never replaces the newer results", async (page) => {
  await searchVault(page);
  await openPaletteBox(page);
  await page.evaluate(() => { window.__searchDelay = 700; });
  await page.keyboard.type("quadratic");
  await page.waitForTimeout(250); // the slow search has started
  await page.evaluate(() => { window.__searchDelay = 0; });
  await page.locator(".palette-input").fill("powerhouse");
  await page.waitForSelector('#palette .palette-title:has-text("Biology")');
  await page.waitForTimeout(900);
  const titles = await page.$$eval("#palette .palette-title", (t) => t.map((x) => x.textContent));
  assert.deepEqual(titles, ["Biology"]);
});

await test("text from a page is shown as text, never run, and odd queries and failures stay calm", async (page) => {
  await searchVault(page);
  await openPaletteBox(page);
  await page.keyboard.type("onerror");
  await page.waitForSelector('#palette .palette-title:has-text("Html")');
  assert.equal(await page.locator("#palette .palette-snippet b, #palette .palette-snippet img").count(), 0);
  assert.match(await page.locator("#palette .palette-snippet").textContent(), /<img src=x onerror=/);
  assert.equal(await page.evaluate(() => window.__pwned), undefined);
  for (const q of ["(", "[", "\\", ".*", "<script>", "%", "a".repeat(500)]) {
    await page.locator(".palette-input").fill(q);
    await page.waitForTimeout(300);
  }
  assert.ok((await page.locator(".palette-input").inputValue()).length <= 200, "the box limits the length");
  await page.locator(".palette-input").fill("zzzzzz");
  await page.waitForFunction(() => /Nothing found/.test(document.querySelector("#palette").textContent));
  await page.evaluate(() => { window.__failSearch = "io"; });
  await page.locator(".palette-input").fill("plants");
  await page.waitForFunction(() => /search did not work/.test(document.querySelector("#palette").textContent));
  assert.equal(await page.isVisible("#banner"), false, "no alarm for a failed search");
});

await test("commands can be found by typing and run with Enter", async (page) => {
  await searchVault(page);
  await openPaletteBox(page);
  await page.keyboard.type("settings");
  await page.waitForSelector('#palette .palette-command:has-text("Open settings")');
  await page.keyboard.press("Enter");
  await page.waitForSelector("#settings[open]");
  await page.click('#settings button:has-text("Close")');
  await openPaletteBox(page);
  await page.keyboard.type("trash");
  await page.keyboard.press("Enter");
  await page.waitForSelector("#trash[open]");
  await closePaletteBox(page);
  await openPaletteBox(page);
  await page.keyboard.type("new page");
  await page.waitForSelector('#palette .palette-command:has-text("New page")');
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => document.querySelector("#title").value === "Untitled");
  assert.ok(Object.keys(await files(page)).some((n) => n.endsWith("Untitled.md")), "the page was created");
});

await test("Ctrl+K with text selected in a page still opens the link box, not the search", async (page) => {
  await openSeeded(page, "Link.md", "alpha beta\n");
  await select(page, 0, 5);
  await page.keyboard.press("Control+k");
  await page.waitForSelector(".link-input", { state: "visible", timeout: 3000 });
  assert.equal(await page.isVisible("#palette"), false);
  // With nothing selected it opens the search from inside the page.
  await page.keyboard.press("Escape");
  await page.locator(".note-body p").click();
  await page.waitForTimeout(150); // the editor notices the new cursor position a moment after the click
  await page.keyboard.press("Control+k");
  await page.waitForSelector("#palette[open]");
});

await test("the Search button opens the box, and the page list shows the shortcut", async (page) => {
  await searchVault(page);
  assert.match(await page.textContent("#openSearch"), /Search/);
  assert.match(await page.textContent("#openSearch"), /Ctrl K/);
  await page.click("#openSearch");
  await page.waitForSelector("#palette[open]");
  // Clicking outside the box closes it.
  await page.mouse.click(5, 5);
  assert.equal(await page.isVisible("#palette"), false);
  // Ctrl+K again while it is open keeps one box.
  await openPaletteBox(page);
  await page.keyboard.press("Control+k");
  assert.equal(await page.locator("dialog#palette[open]").count(), 1);
});

await test("on an Android phone the Search button works with touch, shows no keyboard hint, and fits the screen", async (page) => {
  await searchVault(page);
  assert.doesNotMatch(await page.textContent("#openSearch"), /Ctrl/);
  await page.tap("#openSearch");
  await page.waitForSelector("#palette[open]");
  await page.keyboard.type("plants");
  await page.waitForSelector("#palette .palette-title");
  const fit = await page.evaluate(() => {
    const box = document.querySelector("#palette").getBoundingClientRect();
    return { left: box.left, right: box.right, width: window.innerWidth, scroll: document.documentElement.scrollWidth };
  });
  assert.ok(fit.left >= 0 && fit.right <= fit.width && fit.scroll <= fit.width, JSON.stringify(fit));
  await page.tap('#palette .palette-title:has-text("Notes on plants")');
  await page.waitForFunction(() => document.querySelector("#title").value === "Notes on plants");
  assert.equal(await page.isVisible("#palette"), false);
}, { userAgent: ANDROID_UA, viewport: { width: 412, height: 860 }, hasTouch: true });

await test("Delete works from the long-press menu on a phone and the trash dialog fits the screen", async (page) => {
  await searchVault(page);
  await rightClick(page, "Plants.md");
  await page.click('.context-menu .menu-item:has-text("Delete")');
  await page.waitForFunction(() => !document.querySelector('.tree-button[data-path="Plants.md"]'));
  await page.tap("#openTrash");
  await page.waitForSelector("#trash .trash-row");
  const fit = await page.evaluate(() => { const b = document.querySelector("#trash").getBoundingClientRect(); return { left: b.left, right: b.right, width: window.innerWidth, scroll: document.documentElement.scrollWidth }; });
  assert.ok(fit.left >= 0 && fit.right <= fit.width && fit.scroll <= fit.width, JSON.stringify(fit));
  await page.tap('#trash button:has-text("Restore")');
  await page.waitForSelector("#trash .trash-empty");
  assert.ok("Plants.md" in (await files(page)));
}, { userAgent: ANDROID_UA, viewport: { width: 412, height: 860 }, hasTouch: true });

await test("on an Android phone the folder name has no arrow, because the folder cannot be changed", async (page) => {
  await start(page);
  assert.equal(await page.locator("#vaultButton svg").count(), 0);
  assert.equal(await page.isDisabled("#vaultButton"), true);
}, { userAgent: ANDROID_UA, viewport: { width: 412, height: 860 } });

await test("on desktop the folder name keeps its arrow and opens the folder menu", async (page) => {
  await start(page);
  assert.equal(await page.locator("#vaultButton svg").count(), 1);
});

// ---------- 0.3.2: new entries at the top, and finger gestures in the page list ----------

await test("New page and New folder go to the top when no folder is open, and into the open folder otherwise", async (page) => {
  await withFolderAndPage(page); // Biology/Cells.md and Plan.md; "New folder" is also made at the top
  await page.click('.tree-button[data-path="Biology"]'); // opens it and selects it
  await page.click("#newNote");
  await page.waitForFunction(() => document.querySelector("#title").value === "Untitled");
  assert.ok("Biology/Untitled.md" in (await files(page)), "into the folder that is open");
  await page.click('.tree-button[data-path="Biology"]'); // closes it again
  await page.click("#newNote");
  await page.waitForFunction(() => document.querySelector("#title").value === "Untitled" && document.querySelectorAll(".tree-button").length > 0);
  assert.ok("Untitled.md" in (await files(page)), "at the top: the folder is closed");
  await page.click("#newFolder");
  await page.waitForSelector('.tree-button[data-path="New folder 2"], .tree-button[data-path="New folder"]');
  const folders = await page.evaluate(() => [...window.__mock.folders]);
  assert.ok(folders.every((f) => !f.startsWith("Biology/")), "no folder was made inside the closed folder: " + folders);
  // A page opened inside a folder that is then closed does not pull new things into that folder.
  await page.click('.tree-button[data-path="Biology"]');
  await page.click('.tree-button[data-path="Biology/Cells.md"]');
  await page.waitForSelector("#editor .note-body");
  await page.click('.tree-button[data-path="Biology"]');
  await page.click("#newNote");
  await page.waitForFunction(() => document.querySelector("#title").value === "Untitled 2");
  assert.ok("Untitled 2.md" in (await files(page)));
}, ctxOpts);

// A finger on the page list, sent as real touch input (the browser turns it into pointer events).
async function fingerSetup(page) {
  await start(page);
  await page.evaluate(() => { window.__mock.folders.add("Biology"); window.__mock.files.set("Plan.md", "plan\n"); window.__mock.files.set("Biology/Cells.md", "cells\n"); });
  await page.click("#newFolder");
  const cdp = await page.context().newCDPSession(page);
  const send = (type, x, y) => cdp.send("Input.dispatchTouchEvent", { type, touchPoints: type === "touchEnd" ? [] : [{ x, y }] });
  const centre = async (p) => { const b = await page.locator(`.tree-button[data-path="${p}"]`).boundingBox(); return [b.x + b.width / 2, b.y + b.height / 2]; };
  return { send, centre };
}

await test("on a touch screen, holding an entry and moving it onto a folder moves it, without a menu or opening it", async (page) => {
  const { send, centre } = await fingerSetup(page);
  const [px, py] = await centre("Plan.md");
  const [fx, fy] = await centre("Biology");
  await send("touchStart", px, py);
  await page.waitForTimeout(500);
  assert.equal(await page.locator(".tree-row.picked-up").count(), 1, "picked up");
  assert.equal(await page.locator(".context-menu").count(), 0, "no system menu at this point");
  for (let i = 1; i <= 8; i++) { await send("touchMove", px + ((fx - px) * i) / 8, py + ((fy - py) * i) / 8); await page.waitForTimeout(30); }
  await page.waitForSelector(".drag-preview");
  await page.waitForSelector(".tree-row.drop-target");
  await send("touchEnd");
  await page.waitForFunction(() => window.__mock.files.has("Biology/Plan.md"));
  assert.equal("Plan.md" in (await files(page)), false);
  assert.equal(await page.locator(".drag-preview").count(), 0);
  assert.equal(await page.isVisible("#editor"), false, "dropping did not open the page");
  assert.equal(await page.locator(".context-menu").count(), 0);
}, { userAgent: ANDROID_UA, viewport: { width: 412, height: 860 }, hasTouch: true });

await test("on a touch screen, holding still for longer opens the menu, and nothing is opened or moved", async (page) => {
  const { send, centre } = await fingerSetup(page);
  const [px, py] = await centre("Plan.md");
  await send("touchStart", px, py);
  await page.waitForTimeout(600);
  assert.equal(await page.locator(".context-menu").count(), 0, "still only picked up");
  await page.waitForSelector(".context-menu", { timeout: 2000 });
  await send("touchEnd");
  await page.waitForTimeout(200);
  assert.deepEqual(await page.locator(".context-menu .menu-item").allTextContents(), ["Rename", "Move to", "Delete"]);
  assert.equal(await page.isVisible("#editor"), false, "lifting the finger did not open the page");
  assert.ok("Plan.md" in (await files(page)));
}, { userAgent: ANDROID_UA, viewport: { width: 412, height: 860 }, hasTouch: true });

await test("on a touch screen, two quick taps open the menu, and a folder is not renamed by them", async (page) => {
  const { send, centre } = await fingerSetup(page);
  const [fx, fy] = await centre("Biology");
  for (let i = 0; i < 2; i++) { await send("touchStart", fx, fy); await page.waitForTimeout(40); await send("touchEnd"); await page.waitForTimeout(80); }
  await page.waitForSelector(".context-menu");
  assert.equal(await page.locator(".inline-rename").count(), 0);
  // Two slow taps are two separate taps, not a menu.
  await page.keyboard.press("Escape");
  await page.waitForTimeout(500);
  await send("touchStart", fx, fy); await send("touchEnd");
  await page.waitForTimeout(600);
  await send("touchStart", fx, fy); await send("touchEnd");
  await page.waitForTimeout(200);
  assert.equal(await page.locator(".context-menu").count(), 0);
}, { userAgent: ANDROID_UA, viewport: { width: 412, height: 860 }, hasTouch: true });

await test("on a touch screen, moving the finger at once scrolls instead of picking up, and a quick tap still opens a page", async (page) => {
  const { send, centre } = await fingerSetup(page);
  const [px, py] = await centre("Plan.md");
  await send("touchStart", px, py);
  for (let i = 1; i <= 5; i++) { await send("touchMove", px, py + i * 8); await page.waitForTimeout(20); }
  await page.waitForTimeout(500);
  assert.equal(await page.locator(".tree-row.picked-up, .drag-preview, .context-menu").count(), 0);
  await send("touchEnd");
  assert.ok("Plan.md" in (await files(page)));
  const [qx, qy] = await centre("Plan.md");
  await send("touchStart", qx, qy); await page.waitForTimeout(40); await send("touchEnd");
  await page.waitForSelector("#editor .note-body");
}, { userAgent: ANDROID_UA, viewport: { width: 412, height: 860 }, hasTouch: true });

await test("a mouse drag still works and a drag that is interrupted leaves nothing stuck", async (page) => {
  await withFolderAndPage(page);
  const from = await page.locator('.tree-button[data-path="Plan.md"]').boundingBox();
  const to = await page.locator('.tree-button[data-path="Biology"]').boundingBox();
  await page.mouse.move(from.x + 20, from.y + 10);
  await page.mouse.down();
  await page.mouse.move(to.x + 20, to.y + 10, { steps: 6 });
  await page.waitForSelector(".drag-preview");
  await page.dispatchEvent("body", "pointercancel", { pointerId: 1, bubbles: true });
  await page.waitForFunction(() => !document.querySelector(".drag-preview") && !document.body.classList.contains("tree-dragging"));
  await page.mouse.up();
  assert.ok("Plan.md" in (await files(page)), "an interrupted drag moves nothing");
  // A second drag works afterwards.
  const again = await page.locator('.tree-button[data-path="Plan.md"]').boundingBox();
  await page.mouse.move(again.x + 20, again.y + 10);
  await page.mouse.down();
  await page.mouse.move(to.x + 20, to.y + 10, { steps: 6 });
  await page.mouse.up();
  await page.waitForFunction(() => window.__mock.files.has("Biology/Plan.md"));
}, ctxOpts);

await test("the keyboard shortcuts for underline, highlight, subscript and superscript work", async (page) => {
  await openSeeded(page, "K2.md", "one two three four\n");
  await select(page, 0, 3);
  await page.keyboard.press("Control+u");
  await select(page, 4, 7);
  await page.keyboard.press("Control+Shift+h");
  await select(page, 8, 13);
  await page.keyboard.press("Control+,");
  await select(page, 14, 18);
  await page.keyboard.press("Control+.");
  await waitSaved(page);
  assert.equal(bodyOf((await files(page))["K2.md"]), "<u>one</u> ==two== <sub>three</sub> <sup>four</sup>\n");
});

await test("subscript and superscript do not apply to the same text at once", async (page) => {
  await openSeeded(page, "X.md", "abc\n");
  await select(page, 0, 3);
  await page.click('.float-bar [aria-label="Subscript"]');
  await page.click('.float-bar [aria-label="Superscript"]');
  await waitSaved(page);
  assert.equal(bodyOf((await files(page))["X.md"]), "<sup>abc</sup>\n");
});

await test("the selection bar shows for a finger selection that never reports the finger lifting", async (page) => {
  await openSeeded(page, "A.md", "alpha beta gamma\n");
  await page.locator(".note-body p").click();
  // A finger press, then the system takes the touch over (long press and its own selection
  // handles): the page gets a pointerdown and then nothing, or a pointercancel.
  await page.evaluate(() => document.querySelector(".note-body").dispatchEvent(new PointerEvent("pointerdown", { pointerType: "touch", pointerId: 7, bubbles: true })));
  await page.keyboard.press("Home");
  for (let i = 0; i < 5; i++) await page.keyboard.press("Shift+ArrowRight");
  await page.waitForSelector(".float-bar:not([hidden])", { timeout: 2000 });
  // With a finger the bar sits clear of the system's selection handles under the text.
  const gap = await page.evaluate(() => {
    const r = getSelection().getRangeAt(0).getBoundingClientRect();
    return document.querySelector(".float-bar:not([hidden])").getBoundingClientRect().top - r.bottom;
  });
  assert.ok(gap >= 30, `the bar is ${gap}px under the selection`);
}, { viewport: { width: 412, height: 860 } });

await test("with a mouse the bar waits for the button to be released, or the press to be cancelled", async (page) => {
  await openSeeded(page, "M.md", "alpha beta gamma\n");
  await page.locator(".note-body p").click();
  await page.evaluate(() => document.querySelector(".note-body").dispatchEvent(new PointerEvent("pointerdown", { pointerType: "mouse", pointerId: 1, bubbles: true })));
  await page.keyboard.press("Home");
  for (let i = 0; i < 5; i++) await page.keyboard.press("Shift+ArrowRight");
  await page.waitForTimeout(150);
  assert.equal(await page.isVisible(".float-bar"), false, "hidden while the mouse is down");
  await page.evaluate(() => document.dispatchEvent(new PointerEvent("pointercancel", { pointerType: "mouse", pointerId: 1, bubbles: true })));
  await page.waitForSelector(".float-bar:not([hidden])", { timeout: 2000 });
});

await test("on a phone width the bar with all its buttons stays inside the window", async (page) => {
  await openSeeded(page, "W.md", "alpha beta gamma\n");
  await select(page, 0, 5);
  const box = await page.locator(".float-bar:not([hidden])").boundingBox();
  assert.ok(box.x >= 0 && box.x + box.width <= 412, JSON.stringify(box));
  const overflow = await page.evaluate(() => [...document.querySelectorAll(".float-bar:not([hidden]) > *")].filter((n) => n.getBoundingClientRect().right > innerWidth).length);
  assert.equal(overflow, 0, "no button is cut off");
}, { viewport: { width: 412, height: 860 } });

// The Android half of the keyboard fix (the window gets shorter) cannot run here. This tests what
// the page does once the window is shorter: the top bar stays, and the cursor is kept in view.
const LONG = Array.from({ length: 40 }, (_, i) => `Line number ${i + 1} of a long page`).join("\n\n") + "\n";
const PHONE = { viewport: { width: 412, height: 860 } };

await test("when the keyboard shortens the window the top bar stays and the cursor is scrolled into view", async (page) => {
  await openSeeded(page, "K.md", LONG);
  await page.locator(".note-body p", { hasText: /^Line number 40 of/ }).click();
  await page.keyboard.press("End");
  await page.setViewportSize({ width: 412, height: 420 }); // about what is left above a keyboard
  await page.waitForFunction(() => {
    const ed = document.querySelector("#editor").getBoundingClientRect();
    const sel = window.getSelection();
    if (!sel.rangeCount) return false;
    const node = sel.anchorNode.nodeType === 3 ? sel.anchorNode.parentElement : sel.anchorNode;
    const line = node.closest("p").getBoundingClientRect();
    return line.bottom <= ed.bottom + 1 && line.top >= ed.top - 1;
  }, null, { timeout: 3000 });
  const bar = await page.locator(".topbar").boundingBox();
  assert.ok(bar.y >= 0 && bar.y + bar.height <= 420, "the top bar is on screen: " + JSON.stringify(bar));
  assert.equal(await page.evaluate(() => window.scrollY + document.documentElement.scrollTop + document.body.scrollTop), 0, "the page itself never scrolls");
}, PHONE);

await test("when the cursor is already visible the keyboard does not scroll the note", async (page) => {
  await openSeeded(page, "K.md", LONG);
  // The cursor must really be on line 2 before the window shrinks. Clicking once is not enough
  // on a slow machine, because opening a note can still be placing the cursor at the end.
  const line2 = page.locator(".note-body p", { hasText: /^Line number 2 of/ });
  const onLine2 = () => page.evaluate(() => {
    const node = window.getSelection().anchorNode;
    const p = node && (node.nodeType === 3 ? node.parentElement : node).closest("p");
    return !!p && p.textContent.startsWith("Line number 2 of");
  });
  for (let i = 0; i < 10 && !(await onLine2()); i++) {
    await line2.click();
    await page.keyboard.press("End");
    await page.waitForTimeout(100);
  }
  assert.ok(await onLine2(), "the cursor is on line 2");
  const before = await page.evaluate(() => document.querySelector("#editor").scrollTop);
  await page.setViewportSize({ width: 412, height: 420 });
  await page.waitForTimeout(300);
  const after = await page.evaluate(() => document.querySelector("#editor").scrollTop);
  assert.equal(after, before, "the note stays where it was");
}, PHONE);

await test("on a narrow screen the plus button is hidden and the menu has Add block below", async (page) => {
  await openSeeded(page, "G.md", GUT);
  await page.locator(".note-body p", { hasText: "First" }).click();
  await page.waitForSelector(".gutter-handle:not([hidden])");
  assert.equal(await page.locator(".gutter-plus:not([hidden])").count(), 0);
  await page.click(".gutter-handle");
  await page.click(".gutter-menu .menu-item:has-text('Add block below')");
  await page.keyboard.type("from menu");
  const now = await order(page);
  assert.equal(now[now.findIndex((x) => x.startsWith("First")) + 1], "from menu", JSON.stringify(now));
}, { viewport: { width: 390, height: 800 } });

await test("the selection bar starts with the block type, and choosing another type changes the block", async (page) => {
  await openSeeded(page, "G.md", GUT);
  await page.locator(".note-body p", { hasText: "Second" }).click();
  await page.keyboard.press("Home");
  await page.keyboard.down("Shift");
  await page.keyboard.press("End");
  await page.keyboard.up("Shift");
  await page.waitForSelector(".float-bar:not([hidden]) .type-button:not([hidden])");
  assert.equal((await page.textContent(".type-button .type-label")).trim(), "Text");
  const barLeft = await page.evaluate(() => [...document.querySelector(".float-bar").children].filter((n) => !n.hidden)[0].className);
  assert.match(barLeft, /type-button/, "the block type is the first thing in the bar");
  await page.click(".type-button");
  await page.waitForSelector(".type-menu:not([hidden])");
  assert.equal(await page.locator(".type-menu .menu-item").count(), 10);
  assert.equal((await page.textContent(".type-menu .menu-item[aria-current]")).trim(), "Text");
  await page.click(".type-menu .menu-item:has-text('Heading 2')");
  assert.equal(await page.locator(".note-body h2", { hasText: "Second" }).count(), 1, "the block is now a heading");
  assert.equal(await page.locator(".type-menu:not([hidden])").count(), 0, "the list closes");
  assert.equal((await page.textContent(".type-button .type-label")).trim(), "Heading 2");
});

await test("the block type button is not shown when the selection covers several blocks, and a click elsewhere closes the list", async (page) => {
  await openSeeded(page, "G.md", GUT);
  await selectFirstTwo(page);
  await page.waitForSelector(".float-bar:not([hidden])");
  assert.equal(await page.locator(".type-button:not([hidden])").count(), 0);
  await page.locator(".note-body p", { hasText: "Last" }).click();
  await page.keyboard.press("Home");
  await page.keyboard.down("Shift");
  await page.keyboard.press("End");
  await page.keyboard.up("Shift");
  await page.click(".type-button");
  await page.waitForSelector(".type-menu:not([hidden])");
  await page.click("#title");
  assert.equal(await page.locator(".type-menu:not([hidden])").count(), 0, "a click elsewhere closes the list");
});

await test("Undo right after opening a page changes nothing and nothing is written", async (page) => {
  await openSeeded(page, "G.md", GUT);
  const before = await order(page);
  const saved = (await files(page))["G.md"];
  await page.locator(".note-body p", { hasText: "First" }).click();
  await page.waitForTimeout(1000);
  await page.keyboard.press("Control+z");
  await page.keyboard.press("Control+z");
  assert.deepEqual(await order(page), before, "the page is still all there");
  await page.waitForTimeout(1200); // longer than the autosave delay
  assert.equal((await files(page))["G.md"], saved, "the file on disk was not touched");
  // Undo still works for what was typed.
  await page.keyboard.press("End");
  await page.keyboard.type("XYZ");
  assert.ok((await order(page)).includes("FirstXYZ"));
  await page.keyboard.press("Control+z");
  assert.deepEqual(await order(page), before, "Undo takes back the typing and no more");
});

// ---------- 0.3.3: links between pages ----------

const FILLER = Array.from({ length: 60 }, (_, i) => `Filler paragraph number ${i}.`).join("\n\n");
async function linksVault(page) {
  await page.waitForSelector("#newNote");
  await page.evaluate((filler) => {
    const f = window.__mock.files;
    window.__mock.folders.add("School");
    f.set("Plan.md", `# Plan\n\n${filler}\n\n## Goals\n\nLearn things\n\nThe last point ^last\n\n${filler}\n`);
    f.set("Home.md", "Start at [[Plan]] or [[Plan|the plan]] or [[Plan#Goals]] or [[Plan#^last]] or [[Missing page]].\n\nMore text\n");
    f.set("School/Biology.md", "see [[Plan]] and [[plan]]\n");
    f.set("Blank.md", "start\n");
  }, FILLER);
  await page.click("#newFolder"); // draws the list again; also adds "New folder", which these tests ignore
  await page.waitForSelector('.tree-button[data-path="Home.md"]');
}
async function openLinked(page, name) {
  await page.click(`.tree-button[data-path="${name}"]`);
  await page.waitForFunction((n) => document.querySelector("#title").value === n.replace(/^.*\//, "").replace(/\.md$/, ""), name);
  await page.waitForSelector("#editor .note-body");
}
const chips = (page) => page.locator(".note-body .wikilink").allTextContents();

await test("links are shown as links, a link to a missing page is marked, and saving changes nothing around them", async (page) => {
  await linksVault(page);
  await openLinked(page, "Home.md");
  assert.deepEqual(await chips(page), ["Plan", "the plan", "Plan › Goals", "Plan › ^last", "Missing page"]);
  assert.equal(await page.locator(".raw-block").count(), 0, "a page with links is edited as normal text");
  assert.deepEqual(await page.locator(".note-body .wikilink.unresolved").allTextContents(), ["Missing page"]);
  await page.locator(".note-body p").last().click();
  await page.keyboard.press("Control+End");
  await page.keyboard.type(" extra");
  await waitSaved(page);
  const text = (await files(page))["Home.md"];
  assert.ok(text.includes("Start at [[Plan]] or [[Plan|the plan]] or [[Plan#Goals]] or [[Plan#^last]] or [[Missing page]].\n\nMore text extra"), text);
}, ctxOpts);

await test("a page with links, opened and closed without a change, is not written again", async (page) => {
  await linksVault(page);
  const before = (await files(page))["Home.md"];
  await openLinked(page, "Home.md");
  await openLinked(page, "Blank.md");
  assert.equal((await files(page))["Home.md"], before);
}, ctxOpts);

await test("typing [[ lists the pages, narrows as you type, and choosing one writes the link", async (page) => {
  await linksVault(page);
  await openLinked(page, "Blank.md");
  await page.locator(".note-body p").click();
  await page.keyboard.press("Control+End");
  await page.keyboard.type(" see [[Pl");
  await page.waitForSelector(".slash-menu");
  assert.deepEqual(await page.locator(".slash-item").allTextContents(), ["Plan", "Link to “Pl”"]);
  await page.keyboard.press("Enter");
  assert.equal(await page.locator(".slash-menu").count(), 0);
  assert.deepEqual(await chips(page), ["Plan"]);
  await waitSaved(page);
  assert.ok((await files(page))["Blank.md"].includes("start see [[Plan]]"), (await files(page))["Blank.md"]);
}, ctxOpts);

await test("the picker keeps a heading or alias typed after the name, and offers to link to a page that does not exist", async (page) => {
  await linksVault(page);
  await openLinked(page, "Blank.md");
  await page.locator(".note-body p").click();
  await page.keyboard.press("Control+End");
  await page.keyboard.type(" [[Plan#Goals");
  await page.waitForSelector(".slash-menu");
  await page.keyboard.press("Enter");
  await page.keyboard.type(" and [[Brand new");
  await page.waitForSelector('.slash-item:has-text("Link to")');
  assert.deepEqual(await page.locator(".slash-item").allTextContents(), ["Link to “Brand new”"]);
  await page.keyboard.press("Enter");
  await waitSaved(page);
  assert.ok((await files(page))["Blank.md"].includes("start [[Plan#Goals]] and [[Brand new]]"), JSON.stringify((await files(page))["Blank.md"]));
  assert.ok(!(await files(page))["Blank.md"].includes("\u00a0"), "a space after a link stays a normal space");
  assert.deepEqual(await page.locator(".note-body .wikilink.unresolved").allTextContents(), ["Brand new"]);
}, ctxOpts);

await test("writing a whole link by hand turns it into a link, and Escape leaves the text alone", async (page) => {
  await linksVault(page);
  await openLinked(page, "Blank.md");
  await page.locator(".note-body p").click();
  await page.keyboard.press("Control+End");
  await page.keyboard.type(" [[Plan|my plan]]");
  assert.deepEqual(await chips(page), ["my plan"]);
  assert.equal(await page.locator(".slash-menu").count(), 0);
  await page.keyboard.type(" [[open");
  await page.waitForSelector(".slash-menu");
  await page.keyboard.press("Escape");
  assert.equal(await page.locator(".slash-menu").count(), 0);
  await waitSaved(page);
  assert.ok((await files(page))["Blank.md"].includes("start [[Plan|my plan]] \\[\\[open"), (await files(page))["Blank.md"]); // loose brackets are written escaped, as the editor always does
}, ctxOpts);

await test("a link can be deleted with Backspace as one piece and undone", async (page) => {
  await linksVault(page);
  await openLinked(page, "Blank.md");
  await page.locator(".note-body p").click();
  await page.keyboard.press("Control+End");
  await page.keyboard.type(" [[Plan]] x");
  await page.waitForTimeout(700); // so the undo below is a separate step from the typing
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("Backspace");
  assert.deepEqual(await chips(page), []);
  await page.keyboard.press("Control+z");
  assert.deepEqual(await chips(page), ["Plan"]);
}, ctxOpts);

await test("clicking a link opens that page; a link to a missing page makes it, once even on a double click", async (page) => {
  await linksVault(page);
  await openLinked(page, "Home.md");
  await page.locator(".note-body .wikilink", { hasText: "the plan" }).click();
  await page.waitForFunction(() => document.querySelector("#title").value === "Plan");
  await openLinked(page, "Home.md");
  await page.locator(".note-body .wikilink.unresolved").dblclick();
  await page.waitForFunction(() => document.querySelector("#title").value === "Missing page");
  const names = Object.keys(await files(page)).filter((n) => n.startsWith("Missing page"));
  assert.deepEqual(names, ["Missing page.md"]);
  await openLinked(page, "Home.md");
  assert.equal(await page.locator(".note-body .wikilink.unresolved").count(), 0, "the link is no longer marked once the page exists");
}, ctxOpts);

await test("a link with a heading or a block id scrolls to it, and a missing one says so", async (page) => {
  await linksVault(page);
  await openLinked(page, "Home.md");
  const offset = () => page.evaluate(() => Math.round(document.querySelector(".note-body h2").getBoundingClientRect().top - document.querySelector("#editor").getBoundingClientRect().top));
  await page.locator(".note-body .wikilink", { hasText: "Goals" }).click();
  await page.waitForFunction(() => document.querySelector("#title").value === "Plan");
  await page.waitForFunction(() => document.querySelector("#editor").scrollTop > 100);
  assert.ok(Math.abs(await offset()) < 80, `the heading is at the top: ${await offset()}`);
  assert.equal(await page.isVisible("#toast"), false);
  await openLinked(page, "Home.md");
  await page.locator(".note-body .wikilink", { hasText: "^last" }).click();
  await page.waitForFunction(() => document.querySelector("#title").value === "Plan");
  await page.waitForFunction(() => { const p = [...document.querySelectorAll(".note-body p")].find((n) => n.textContent === "The last point"); return p && Math.abs(p.getBoundingClientRect().top - document.querySelector("#editor").getBoundingClientRect().top) < 80; });
  await seed(page, "Broken.md", "[[Plan#Nope]] and [[Plan#^nothing]]\n");
  await page.click("#newFolder");
  await openLinked(page, "Broken.md");
  await page.locator(".note-body .wikilink").first().click();
  await page.waitForFunction(() => document.querySelector("#title").value === "Plan");
  await page.waitForSelector("#toast:not([hidden])");
  assert.match(await page.textContent("#toast"), /no heading “Nope”/);
}, ctxOpts);

await test("a page lists the pages that link to it, and clicking one opens it", async (page) => {
  await linksVault(page);
  await openLinked(page, "Plan.md");
  await page.waitForSelector(".backlinks .backlink");
  assert.deepEqual(await page.locator(".backlink-title").allTextContents(), ["Biology", "Home"]);
  assert.equal(await page.textContent(".backlinks-title .backlinks-count"), "2");
  assert.equal(await page.locator(".backlink-snippet mark").first().textContent(), "[[Plan]]");
  assert.deepEqual(await page.locator(".backlink-count").allTextContents(), ["2", "4"]);
  await page.locator(".backlink", { hasText: "Home" }).click();
  await page.waitForFunction(() => document.querySelector("#title").value === "Home");
  await page.waitForSelector(".backlinks .backlinks-note");
  assert.equal(await page.textContent(".backlinks-note"), "No other page links here.");
}, ctxOpts);

await test("when looking for links fails, the page says so calmly", async (page) => {
  await linksVault(page);
  await page.evaluate(() => { window.__failBacklinks = "io"; });
  await openLinked(page, "Plan.md");
  await page.waitForSelector(".backlinks .backlinks-note");
  assert.match(await page.textContent(".backlinks-note"), /Could not look for links/);
}, { ...ctxOpts, allow: [/./] });

await test("clicking quickly through pages asks for links only for the page that stays open", async (page) => {
  await linksVault(page);
  await openLinked(page, "Home.md");
  await page.evaluate(() => { window.__backlinkCalls = 0; });
  for (const name of ["Blank.md", "Plan.md", "Home.md", "Blank.md"]) await page.click(`.tree-button[data-path="${name}"]`);
  await page.waitForFunction(() => document.querySelector("#title").value === "Blank");
  await page.waitForTimeout(700);
  assert.equal(await page.evaluate(() => window.__backlinkCalls), 1);
}, ctxOpts);

await test("links inside bold or italic text, or a page of thousands of links, never lose text", async (page) => {
  await linksVault(page);
  const many = "[[a]] ".repeat(6000);
  await seed(page, "Styled.md", "**[[Plan]]** and *[[Plan]]* here\n\nother\n");
  await seed(page, "Many.md", `${many}\n\nend\n`);
  await page.click("#newFolder");
  await openLinked(page, "Styled.md");
  await page.locator(".note-body p").first().click({ position: { x: 600, y: 5 } }); // empty space after the text: the caret goes to the end, no link is hit
  await page.keyboard.press("End");
  await page.keyboard.type(" x");
  await waitSaved(page);
  const styled = (await files(page))["Styled.md"];
  assert.equal(styled.split("[[Plan]]").length - 1, 2, styled);
  assert.ok(styled.includes(" here x") && styled.includes("other"), JSON.stringify([styled, await page.locator(".note-body").innerHTML()]));
  const started = Date.now();
  await openLinked(page, "Many.md");
  assert.ok(Date.now() - started < 5000, "a huge page opens in reasonable time");
  assert.equal((await files(page))["Many.md"], `${many}\n\nend\n`, "and is not changed by opening it");
}, ctxOpts);

await test("the Linked from list can be hidden, stays hidden without searching, and comes back from Settings", async (page) => {
  await linksVault(page);
  await openLinked(page, "Plan.md");
  await page.waitForSelector(".backlinks .backlink");
  await page.click(".backlinks-head button");
  assert.equal(await page.isVisible(".backlinks"), false);
  assert.equal(JSON.parse(await page.evaluate(() => window.__mock.getSettings())).showBacklinks, false);
  await page.evaluate(() => { window.__backlinkCalls = 0; });
  await openLinked(page, "Home.md");
  await openLinked(page, "Plan.md");
  await page.waitForTimeout(600);
  assert.equal(await page.evaluate(() => window.__backlinkCalls), 0, "no search while it is off");
  assert.equal(await page.isVisible(".backlinks"), false);
  await page.click("#openSettings");
  await page.waitForSelector("#settings[open]");
  const box = page.locator('#settings .setting-row:has-text("Linked from") input');
  assert.equal(await box.isChecked(), false);
  await box.check();
  await page.waitForSelector(".backlinks .backlink");
  assert.equal(JSON.parse(await page.evaluate(() => window.__mock.getSettings())).showBacklinks, true);
}, ctxOpts);

await test("with the Linked from list switched off in the settings, it is not shown or searched for", async (page) => {
  await linksVault(page);
  await page.evaluate(() => { window.__backlinkCalls = 0; });
  await openLinked(page, "Plan.md");
  await page.waitForTimeout(600);
  assert.equal(await page.evaluate(() => window.__backlinkCalls), 0);
  assert.equal(await page.isVisible(".backlinks"), false);
}, { settings: existingUser({ updates: false, showBacklinks: false }) });

await test("a finger tap on a link follows it", async (page) => {
  await linksVault(page);
  await openLinked(page, "Home.md");
  await page.locator(".note-body .wikilink", { hasText: "the plan" }).tap();
  await page.waitForFunction(() => document.querySelector("#title").value === "Plan");
}, { ...ctxOpts, userAgent: ANDROID_UA, viewport: { width: 390, height: 780 }, hasTouch: true });


if (shots && !process.env.SHOTS_ONLY) {
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
if (shots && !process.env.SHOTS_ONLY) {
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
  // 0.2.5 screens: dragging in the page list, the block drag copy, the plus button and the
  // block type row of the selection bar.
  for (const scheme of ["light", "dark"]) {
    for (const [label, viewport] of [["desktop", { width: 1400, height: 800 }], ["phone", { width: 390, height: 800 }]]) {
      const context = await browser.newContext({ viewport, colorScheme: scheme });
      await context.addInitScript((text) => { window.__seedSettings = text; }, JSON.stringify({ ...baseSettings, updates: false, vaultPath: "/home/alice/Documents/ScaleNote" }));
      await context.addInitScript({ path: path.join(here, "mock-backend.js") });
      const page = await context.newPage();
      await prepare(page, {});
      const name = (n) => `${shots}/v025-${label}-${scheme}-${n}.png`;
      await page.goto(url);
      await page.waitForSelector("#newNote");
      await page.evaluate(([text]) => {
        window.__mock.folders.add("Biology"); window.__mock.folders.add("Archive");
        window.__mock.files.set("Plan.md", "plan\n");
        window.__mock.files.set("Notes.md", text);
      }, [GUT]);
      await page.click("#newFolder");
      if (label === "desktop") {
        const from = await page.locator('.tree-button[data-path="Plan.md"]').boundingBox();
        const to = await page.locator('.tree-button[data-path="Biology"]').boundingBox();
        await page.mouse.move(from.x + 30, from.y + from.height / 2);
        await page.mouse.down();
        await page.mouse.move(from.x + 40, from.y + 30, { steps: 4 });
        await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 6 });
        await page.screenshot({ path: name("1-drag-in-list") });
        await page.keyboard.press("Escape");
        await page.mouse.up();
      }
      if (label === "phone") await page.click("#sidebarToggle").catch(() => {});
      await page.click('.tree-button[data-path="Notes.md"]');
      await page.waitForSelector("#editor .note-body");
      await page.locator(".note-body p", { hasText: "First" }).click();
      await page.waitForSelector(".gutter-handle:not([hidden])");
      await page.screenshot({ path: name("2-handle-and-plus") });
      await page.keyboard.press("Home");
      await page.keyboard.down("Shift");
      await page.keyboard.press("End");
      await page.keyboard.up("Shift");
      await page.waitForSelector(".type-button:not([hidden])");
      await page.screenshot({ path: name("3-type-row") });
      await page.click(".type-button");
      await page.waitForSelector(".type-menu:not([hidden])");
      await page.screenshot({ path: name("4-type-menu") });
      await page.keyboard.press("Escape");
      await page.click("#title");
      await page.locator(".note-body p", { hasText: "First" }).click();
      await page.keyboard.press("Home");
      await page.keyboard.down("Shift");
      await page.keyboard.press("ArrowDown");
      await page.keyboard.press("End");
      await page.keyboard.up("Shift");
      await page.waitForSelector(".float-bar:not([hidden])");
      await page.locator(".gutter-handle").hover();
      const h = await page.locator(".gutter-handle").boundingBox();
      await page.mouse.down();
      await page.mouse.move(h.x + 16, h.y + 60, { steps: 4 });
      await page.mouse.move(h.x + 40, h.y + 150, { steps: 6 });
      await page.screenshot({ path: name("5-drag-blocks") });
      await page.keyboard.press("Escape");
      await page.mouse.up();
      await context.close();
    }
  }
  // 0.2.4 screens: the right-click menu on a folder, and the name field while renaming.
  for (const scheme of ["light", "dark"]) {
    for (const [label, viewport] of [["desktop", { width: 1100, height: 760 }], ["phone", { width: 390, height: 800 }]]) {
      const context = await browser.newContext({ viewport, colorScheme: scheme });
      await context.addInitScript((text) => { window.__seedSettings = text; }, JSON.stringify({ ...baseSettings, updates: false, vaultPath: "/home/alice/Documents/ScaleNote" }));
      await context.addInitScript({ path: path.join(here, "mock-backend.js") });
      const page = await context.newPage();
      await prepare(page, {});
      await page.goto(url);
      await page.waitForSelector("#newNote");
      await page.evaluate(() => { window.__mock.folders.add("Biology"); window.__mock.files.set("Biology/Cells.md", "cells\n"); window.__mock.files.set("Plan.md", "plan\n"); });
      await page.click("#newFolder");
      const row = page.locator('.tree-button[data-path="Biology"]');
      await row.click({ button: "right" });
      await page.waitForSelector(".context-menu");
      await page.screenshot({ path: `${shots}/v024-${label}-${scheme}-1-menu.png` });
      await page.click(".context-menu .menu-item");
      await page.waitForSelector(".inline-rename");
      await page.screenshot({ path: `${shots}/v024-${label}-${scheme}-2-renaming.png` });
      await context.close();
    }
  }
  // 0.2.2 screens: the folder menu, the sidebar at the smallest and largest text size, the
  // settings with five sizes, and a toggle quiet and in use.
  for (const scheme of ["light", "dark"]) {
    for (const [label, viewport] of [["desktop", { width: 1100, height: 760 }], ["phone", { width: 390, height: 800 }]]) {
      for (const fontSize of label === "desktop" ? [80, 100, 125] : [100]) {
        const context = await browser.newContext({ viewport, colorScheme: scheme });
        await context.addInitScript((text) => { window.__seedSettings = text; }, JSON.stringify({ ...baseSettings, updates: false, fontSize, vaultPath: "/home/alice/Documents/ScaleNote", recentVaults: ["/home/alice/Documents/ScaleNote", "/home/alice/Work", "/home/alice/School"] }));
        await context.addInitScript({ path: path.join(here, "mock-backend.js") });
        const page = await context.newPage();
        await prepare(page, {});
        const name = (n) => `${shots}/v022-${label}-${scheme}-${fontSize}-${n}.png`;
        await page.goto(url);
        await page.waitForSelector("#newNote");
        await page.evaluate(([text]) => window.__mock.files.set("Toggle page.md", text), [["Intro", "", "<details>", "<summary>Title of the toggle</summary>", "", "Hello", "", "flip", "", "</details>", ""].join("\n")]);
        await page.click("#newFolder");
        await page.screenshot({ path: name("1-sidebar") });
        await page.click("#vaultButton");
        await page.waitForSelector(".folder-menu");
        await page.screenshot({ path: name("2-folder-menu") });
        await page.keyboard.press("Escape");
        if (fontSize !== 100) { await context.close(); continue; }
        await page.click('.tree-button[data-path="Toggle page.md"]');
        await page.waitForSelector(".toggle");
        await page.locator(".note-body p").first().click();
        if (label === "phone") await page.evaluate(() => document.body.classList.remove("sidebar-open"));
        await page.screenshot({ path: name("3-toggle-quiet") });
        await page.click(".toggle-summary");
        await page.screenshot({ path: name("4-toggle-focused") });
        await page.click(".toggle-fold");
        await page.screenshot({ path: name("5-toggle-folded") });
        if (label === "phone") await page.click("#toggle");
        await page.click("#openSettings");
        await page.waitForSelector("#settings[open]");
        await page.screenshot({ path: name("6-settings") });
        await context.close();
      }
    }
  }
  // 0.2.7: Settings after "Check now" found a newer version (file offered, and release page only).
  for (const scheme of ["light", "dark"]) {
    for (const [label, viewport, userAgent] of [["phone", { width: 412, height: 860 }, ANDROID_UA], ["desktop-linux", { width: 1100, height: 760 }, undefined]]) {
      const context = await browser.newContext({ viewport, colorScheme: scheme, ...(userAgent ? { userAgent } : {}) });
      await context.addInitScript((text) => { window.__seedSettings = text; }, JSON.stringify({ ...baseSettings, updates: false }));
      await context.addInitScript({ path: path.join(here, "mock-backend.js") });
      const page = await context.newPage();
      await prepare(page, { releases: WITH_FILES });
      await page.goto(url);
      await page.waitForSelector("#newNote");
      await page.click("#openSettings");
      await page.click('#settings button:has-text("Check now")');
      await page.waitForSelector("#settings .setting-actions button");
      await page.screenshot({ path: `${shots}/v027-${label}-${scheme}-settings-update.png` });
      await context.close();
    }
  }
  // 0.2.6: a phone window as short as it is with the keyboard open. The keyboard itself is not
  // drawn (it belongs to Android); the window height is what the page gets to work with.
  for (const scheme of ["light", "dark"]) {
    const context = await browser.newContext({ viewport: { width: 412, height: 860 }, colorScheme: scheme });
    await context.addInitScript((text) => { window.__seedSettings = text; }, JSON.stringify({ ...baseSettings, updates: false }));
    await context.addInitScript({ path: path.join(here, "mock-backend.js") });
    const page = await context.newPage();
    await prepare(page, {});
    await page.goto(url);
    await page.waitForSelector("#newNote");
    await page.evaluate(([text]) => window.__mock.files.set("Long.md", text), [LONG]);
    await page.click("#newFolder");
    await page.click("#sidebarToggle").catch(() => {});
    await page.click('.tree-button[data-path="Long.md"]');
    await page.waitForSelector("#editor .note-body");
    await page.locator(".note-body p", { hasText: /^Line number 40 of/ }).click();
    await page.keyboard.press("End");
    await page.screenshot({ path: `${shots}/v026-phone-${scheme}-1-keyboard-closed.png` });
    await page.setViewportSize({ width: 412, height: 420 });
    await page.waitForTimeout(400);
    await page.screenshot({ path: `${shots}/v026-phone-${scheme}-2-keyboard-open.png` });
    await context.close();
  }
  // 0.2.9: styled text, the selection bar and the colour palette, desktop and phone width.
  for (const scheme of ["light", "dark"]) {
    for (const [label, viewport, userAgent] of [["desktop", { width: 1100, height: 760 }, undefined], ["phone", { width: 412, height: 860 }, ANDROID_UA]]) {
      const context = await browser.newContext({ viewport, colorScheme: scheme, ...(userAgent ? { userAgent } : {}) });
      await context.addInitScript((text) => { window.__seedSettings = text; }, JSON.stringify({ ...baseSettings, updates: false }));
      await context.addInitScript({ path: path.join(here, "mock-backend.js") });
      const page = await context.newPage();
      await prepare(page, {});
      await page.goto(url);
      await page.waitForSelector("#newNote");
      await page.evaluate(([text]) => window.__mock.files.set("Styles.md", text), [`${STYLED}\nText: ${COLOURS.map((c) => `<span class="sn-text-${c}">${c}</span>`).join(" ")}\n\nBackground: ${COLOURS.map((c) => `<span class="sn-bg-${c}">${c}</span>`).join(" ")}\n\nBoth: <span class="sn-text-red sn-bg-yellow">red on yellow</span> and ==plain highlight==\n`]);
      await page.click("#newFolder");
      if (label === "phone") await page.click("#sidebarToggle").catch(() => {});
      await page.click('.tree-button[data-path="Styles.md"]');
      await page.waitForSelector("#editor .note-body");
      await page.screenshot({ path: `${shots}/v029-${label}-${scheme}-1-styled.png` });
      await select(page, 6, 12);
      await page.screenshot({ path: `${shots}/v029-${label}-${scheme}-2-bar.png` });
      await page.click('.float-bar [aria-label="Colour"]');
      await page.waitForSelector(".colour-menu:not([hidden])");
      await page.screenshot({ path: `${shots}/v0210-${label}-${scheme}-3-colours.png` });
      // A range with both kinds of colour, and the Settings box with the Obsidian button.
      await page.click('.colour-menu [aria-label="Red text"]');
      await select(page, 6, 12);
      await page.click('.float-bar [aria-label="Colour"]');
      await page.click('.colour-menu [aria-label="Yellow background"]');
      await page.keyboard.press("ArrowRight"); // collapse the selection so the bar goes away
      await page.waitForTimeout(200);
      await page.screenshot({ path: `${shots}/v0210-${label}-${scheme}-4-both.png` });
      if (label === "phone") await page.click("#toggle");
      await page.click("#openSettings");
      await page.waitForSelector("#settings .settings-body");
      await page.screenshot({ path: `${shots}/v0210-${label}-${scheme}-5-settings.png` });
      await context.close();
    }
  }
  // 0.3.0: search and commands, the Delete entry in the menu, and the trash, desktop and phone width.
  for (const scheme of ["light", "dark"]) {
    for (const [label, viewport, userAgent] of [["desktop", { width: 1100, height: 760 }, undefined], ["phone", { width: 412, height: 860 }, ANDROID_UA]]) {
      const context = await browser.newContext({ viewport, colorScheme: scheme, ...(userAgent ? { userAgent } : {}), ...(userAgent ? { hasTouch: true } : {}) });
      await context.addInitScript((text) => { window.__seedSettings = text; }, JSON.stringify({ ...baseSettings, updates: false }));
      await context.addInitScript({ path: path.join(here, "mock-backend.js") });
      const page = await context.newPage();
      await prepare(page, {});
      await page.goto(url);
      await page.waitForSelector("#newNote");
      await page.evaluate(() => {
        const f = window.__mock.files;
        window.__mock.folders.add("School");
        window.__mock.folders.add("Garden");
        f.set("School/Biology.md", "# Biology\n\nCells and the powerhouse of the cell: the mitochondria.\n");
        f.set("School/Maths.md", "Nothing here\nThe quadratic formula solves every equation of the second degree.\n");
        f.set("Garden/Plants.md", "All about plants and how much water they need in the summer.\n");
        f.set("Garden/Plant shopping list.md", "seeds, soil, a watering can\n");
        f.set("Reading plants.md", "A book about plants.\n");
        f.set("Old plan.md", "never mind\n");
        f.set("Old folder/x.md", "x\n");
        window.__mock.folders.add("Old folder");
      });
      await page.click("#newFolder");
      // On a phone the page list slides over the page: open it with the button, close it by tapping beside it.
      const list = async (open) => {
        if ((await page.evaluate(() => document.body.classList.contains("sidebar-open"))) === open) return;
        if (open) await page.click("#toggle"); else await page.mouse.click(404, 400);
        await page.waitForTimeout(100);
      };
      await page.screenshot({ path: `${shots}/v030-${label}-${scheme}-1-sidebar.png` });
      await page.click('.tree-button[data-path="School"]'); // opens the folder
      for (const p of ["School/Biology.md", "School/Maths.md"]) {
        await list(true);
        await page.click(`.tree-button[data-path="${p}"]`);
        await page.waitForSelector("#editor .note-body");
      }
      await page.evaluate(() => document.activeElement && document.activeElement.blur());
      if (label === "phone") { await list(true); await page.tap("#openSearch"); } else await page.keyboard.press("Control+k");
      await page.waitForSelector("#palette[open] .palette-row");
      await page.screenshot({ path: `${shots}/v030-${label}-${scheme}-2-search-empty.png` });
      await page.keyboard.type("plants");
      await page.waitForSelector("#palette .palette-snippet");
      await page.keyboard.press("ArrowDown");
      await page.screenshot({ path: `${shots}/v030-${label}-${scheme}-3-search-results.png` });
      await page.keyboard.press("Escape");
      await list(true);
      await page.locator('.tree-button[data-path="Old plan.md"]').click({ button: "right" });
      await page.waitForSelector(".context-menu");
      await page.screenshot({ path: `${shots}/v030-${label}-${scheme}-4-menu.png` });
      await page.click('.context-menu .menu-item:has-text("Delete")');
      await page.waitForFunction(() => !document.querySelector('.tree-button[data-path="Old plan.md"]'));
      await list(true);
      await page.locator('.tree-button[data-path="Old folder"]').focus();
      await page.keyboard.press("Delete");
      await page.waitForFunction(() => !document.querySelector('.tree-button[data-path="Old folder"]'));
      await page.click("#openTrash");
      await page.waitForSelector("#trash .trash-row");
      await page.locator('#trash .trash-row button:has-text("Delete forever")').first().click();
      await page.screenshot({ path: `${shots}/v030-${label}-${scheme}-5-trash.png` });
      await page.click('#trash button:has-text("Cancel")');
      await page.click('#trash button:has-text("Empty trash")');
      await page.screenshot({ path: `${shots}/v030-${label}-${scheme}-6-trash-empty-ask.png` });
      await context.close();
    }
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

// ---------- 0.3.5: covers ----------

const coversOn = { settings: existingUser({ updates: false, showCovers: true }) };
async function coversVault(page) {
  await page.waitForSelector("#newNote");
  await page.evaluate((png) => {
    const f = window.__mock.files;
    window.__mock.attachments.set("attachments/leaf.png", png);
    f.set("Has cover.md", "---\nid: abc\ncover: attachments/leaf.png\ntags: [a]\n---\n\nHello\n");
    f.set("Plain.md", "Hello\n");
    f.set("Odd.md", "---\ncover:\n  - attachments/leaf.png\n---\n\nodd\n");
    f.set("Missing.md", "---\ncover: attachments/gone.png\n---\n\nm\n");
  }, PNG_B64);
  await page.click("#newFolder"); // draws the list again; also adds "New folder", which these tests ignore
  await page.waitForSelector('.tree-button[data-path="Plain.md"]');
}
const openCover = async (page, name) => {
  await page.click(`.tree-button[data-path="${name}"]`);
  await page.waitForFunction((n) => document.querySelector("#title").value === n.replace(/\.md$/, ""), name);
  await page.waitForSelector("#editor .note-body");
};
const pickCover = async (page, buttonText, file) => {
  const chooser = page.waitForEvent("filechooser");
  await page.locator(".cover-actions button", { hasText: buttonText }).click();
  await (await chooser).setFiles(file);
};

await test("covers are off by default: no picture, no Add cover button, and a switch in Settings turns them on and off", async (page) => {
  await coversVault(page);
  const before = (await files(page))["Has cover.md"];
  await openCover(page, "Has cover.md");
  assert.equal(await page.locator(".cover, .cover-image, .cover-actions").count(), 0, "no cover element exists at all");
  assert.doesNotMatch(await page.evaluate(() => document.body.innerText), /Add cover|Change cover|Remove cover/);
  await page.click("#openSettings");
  await page.waitForSelector("#settings[open]");
  const box = page.locator('#settings .setting-row:has-text("covers") input');
  assert.equal(await box.isChecked(), false);
  await box.check();
  await page.waitForSelector(".cover-image img[src]");
  assert.equal(JSON.parse(await page.evaluate(() => window.__mock.getSettings())).showCovers, true);
  await box.uncheck();
  assert.equal(await page.locator(".cover, .cover-image, .cover-actions").count(), 0);
  assert.equal(JSON.parse(await page.evaluate(() => window.__mock.getSettings())).showCovers, false);
  await page.click("#settings button.primary");
  await openCover(page, "Plain.md");
  assert.equal((await files(page))["Has cover.md"], before, "a page with a cover, opened with covers off, is not changed");
}, ctxOpts);

await test("a page with a cover shows it, and opening and closing it changes nothing", async (page) => {
  await coversVault(page);
  const before = (await files(page))["Has cover.md"];
  await openCover(page, "Has cover.md");
  await page.waitForSelector(".cover-image img[src]");
  assert.equal(await page.evaluate(() => document.querySelector(".cover-image img").naturalWidth), 1);
  assert.deepEqual(await page.locator(".cover-actions button").allTextContents(), ["Change cover", "Remove cover"]);
  await openCover(page, "Plain.md");
  assert.deepEqual(await page.locator(".cover-actions button").allTextContents(), ["Add cover"]);
  assert.equal(await page.locator(".cover-image").count(), 0);
  await page.waitForTimeout(900);
  assert.equal((await files(page))["Has cover.md"], before);
}, coversOn);

await test("a cover can be added, changed and removed, and only its line in the properties changes", async (page) => {
  await coversVault(page);
  await openCover(page, "Plain.md");
  await pickCover(page, "Add cover", { name: "My photo.png", mimeType: "image/png", buffer: PNG });
  await page.waitForSelector(".cover-image img[src]");
  await waitSaved(page);
  assert.match((await files(page))["Plain.md"], /^---\ncover: attachments\/My-photo\.png\nid: [0-9a-f-]+\n---\n\nHello\n$/);
  assert.ok(await page.evaluate(() => window.__mock.attachments.has("attachments/My-photo.png")));
  await pickCover(page, "Change cover", { name: "Second.png", mimeType: "image/png", buffer: PNG });
  await page.waitForFunction(() => window.__mock.files.get("Plain.md").includes("cover: attachments/Second.png"));
  await page.locator(".cover-actions button", { hasText: "Remove cover" }).click();
  await page.waitForFunction(() => !window.__mock.files.get("Plain.md").includes("cover:"));
  assert.match((await files(page))["Plain.md"], /^---\nid: [0-9a-f-]+\n---\n\nHello\n$/);
  assert.equal(await page.locator(".cover-image").count(), 0);
  assert.deepEqual(await page.locator(".cover-actions button").allTextContents(), ["Add cover"]);
  assert.ok(await page.evaluate(() => window.__mock.attachments.has("attachments/Second.png")), "the picture file stays in the vault");
}, coversOn);

await test("other properties, their order and the text are kept when a cover changes or the page is edited", async (page) => {
  await coversVault(page);
  await openCover(page, "Has cover.md");
  await page.locator(".note-body p").click();
  await page.keyboard.press("Control+End");
  await page.keyboard.type(" more");
  await waitSaved(page);
  assert.equal((await files(page))["Has cover.md"], "---\nid: abc\ncover: attachments/leaf.png\ntags: [a]\n---\n\nHello more\n");
  await page.locator(".cover-actions button", { hasText: "Remove cover" }).click();
  await page.waitForFunction(() => !window.__mock.files.get("Has cover.md").includes("cover:"));
  assert.equal((await files(page))["Has cover.md"], "---\nid: abc\ntags: [a]\n---\n\nHello more\n");
}, coversOn);

await test("a file that is not a picture is refused with a message and the page is not changed", async (page) => {
  await coversVault(page);
  await openCover(page, "Plain.md");
  await pickCover(page, "Add cover", { name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("hello") });
  await page.waitForSelector("#banner:not([hidden])");
  assert.equal(await page.locator(".cover-image").count(), 0);
  await page.waitForTimeout(900);
  assert.equal((await files(page))["Plain.md"], "Hello\n");
}, coversOn);

await test("a cover entry that is a list is left alone, with a message", async (page) => {
  await coversVault(page);
  await openCover(page, "Odd.md");
  await pickCover(page, "Add cover", { name: "a.png", mimeType: "image/png", buffer: PNG });
  await page.waitForSelector("#toast:not([hidden])");
  assert.match(await page.textContent("#toast"), /cannot change it safely|cannot change/);
  await page.waitForTimeout(900);
  assert.equal((await files(page))["Odd.md"], "---\ncover:\n  - attachments/leaf.png\n---\n\nodd\n");
}, coversOn);

await test("a cover whose picture is gone says so, and can be removed", async (page) => {
  await coversVault(page);
  await openCover(page, "Missing.md");
  await page.waitForSelector(".cover-note:not(:empty)");
  assert.match(await page.textContent(".cover-note"), /could not be found/);
  await page.locator(".cover-actions button", { hasText: "Remove cover" }).click();
  await page.waitForFunction(() => !window.__mock.files.get("Missing.md").includes("cover:"));
}, coversOn);

await test("the markdown text view hides the cover and shows the property line as written", async (page) => {
  await coversVault(page);
  await openCover(page, "Has cover.md");
  await page.waitForSelector(".cover-image img[src]");
  await page.click("#sourceToggle");
  await page.waitForSelector("#source:not([hidden])");
  assert.equal(await page.locator(".cover").count() === 0 || await page.isVisible(".cover") === false, true);
  assert.match(await page.inputValue("#source"), /^---\ncover: attachments\/leaf\.png\ntags: \[a\]\n---/);
  await page.click("#sourceToggle");
  await page.waitForSelector(".cover-image img[src]");
}, coversOn);

await test("on a phone the cover fits the screen and the buttons can be reached", async (page) => {
  await coversVault(page);
  await page.click("#toggle").catch(() => {});
  await openCover(page, "Has cover.md");
  await page.waitForSelector(".cover-image img[src]");
  const box = await page.locator(".cover-image").boundingBox();
  assert.ok(box.x >= 0 && box.x + box.width <= 390, JSON.stringify(box));
  assert.ok(box.height <= 150, JSON.stringify(box));
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= 390), "no sideways scrolling");
  for (const b of await page.locator(".cover-actions button").all()) assert.ok((await b.boundingBox()).height >= 32);
}, { ...coversOn, viewport: { width: 390, height: 780 } });

// ---------- 0.3.6: tags and favorites ----------

async function tagsVault(page) {
  await page.waitForSelector("#newNote");
  await page.evaluate(() => {
    const f = window.__mock.files;
    window.__mock.folders.add("School");
    f.set("Tagged.md", "Plan for #school/maths and #Plan.\n\nNumbers like #1984 stay text, `#code` too.\n\nA last #tag line\n");
    f.set("A.md", "---\nid: aaa\ntags: [plan, School/Maths]\nfavorite: true\n---\n\nOne #plan page\n");
    f.set("School/B.md", "Another page about #plan and #other\n");
    f.set("C.md", "Just #other here\n");
    f.set("Plain.md", "Hello\n");
    f.set("Odd.md", "---\nfavorite:\n  - yes\n---\n\nodd\n");
    f.set("Fenced.md", "```\n#hidden\n```\n");
  });
  await page.click("#newFolder"); // draws the list again; also adds "New folder", which these tests ignore
  await page.waitForSelector('.tree-button[data-path="Plain.md"]');
}
const openTagged = async (page, name) => {
  await page.click(`.tree-button[data-path="${name}"]`);
  await page.waitForFunction((n) => document.querySelector("#title").value === n.replace(/^.*\//, "").replace(/\.md$/, ""), name);
  await page.waitForSelector("#editor .note-body");
};
const tagMarks = (page) => page.locator(".note-body .tag").allTextContents();

await test("tags are marked, a page with tags is edited as normal text, and typing changes nothing around them", async (page) => {
  await tagsVault(page);
  const before = (await files(page))["Tagged.md"];
  await openTagged(page, "Tagged.md");
  assert.deepEqual(await tagMarks(page), ["#school/maths", "#Plan", "#tag"]);
  assert.equal(await page.locator(".raw-block").count(), 1, "only the paragraph with a number and a code span stays raw");
  await openTagged(page, "Plain.md");
  assert.equal((await files(page))["Tagged.md"], before, "opening and leaving a page does not write it");
  await openTagged(page, "Tagged.md");
  await page.locator(".note-body p").last().click({ position: { x: 600, y: 5 } });
  await page.keyboard.press("End");
  await page.keyboard.type(" more");
  await waitSaved(page);
  // Saving after an edit adds the page's id at the top, as for every page; nothing else changes.
  assert.match((await files(page))["Tagged.md"], /^---\nid: [0-9a-f-]+\n---\n\n/);
  assert.equal((await files(page))["Tagged.md"].replace(/^---\nid: [0-9a-f-]+\n---\n\n/, ""), before.replace("A last #tag line\n", "A last #tag line more\n"));
}, ctxOpts);

await test("a tag typed into a page is marked at once and saved exactly as typed, also at the start of a line", async (page) => {
  await tagsVault(page);
  await openTagged(page, "Plain.md");
  await page.locator(".note-body p").first().click();
  await page.keyboard.press("Control+End");
  await page.keyboard.press("Enter");
  await page.keyboard.type("#first thing and a #second/part tag# no#tag");
  assert.deepEqual(await tagMarks(page), ["#first", "#second/part"]);
  await waitSaved(page);
  const text = (await files(page))["Plain.md"];
  assert.match(text, /\n#first thing and a #second\/part tag# no#tag\n$/, text);
}, ctxOpts);

await test("tags inside a heading, a list and a quote are marked, and tags in code are not", async (page) => {
  await tagsVault(page);
  await seed(page, "Mixed.md", "# Title #head\n\n- item #list\n\n> quote #quote\n\nuse `#code` here\n");
  await page.click("#newFolder");
  await openTagged(page, "Mixed.md");
  assert.deepEqual(await tagMarks(page), ["#head", "#list", "#quote"]);
  assert.equal(await page.locator(".raw-block").count(), 0);
  await page.locator(".note-body p").last().click({ position: { x: 600, y: 5 } });
  await page.keyboard.press("End");
  await page.keyboard.type("!");
  await waitSaved(page);
  assert.equal((await files(page))["Mixed.md"].replace(/^---\nid: [0-9a-f-]+\n---\n\n/, ""), "# Title #head\n\n- item #list\n\n> quote #quote\n\nuse `#code` here!\n");
}, ctxOpts);

await test("clicking a tag opens the Tags box on that tag with its pages, and a page in it opens", async (page) => {
  await tagsVault(page);
  await openTagged(page, "A.md");
  await page.locator(".note-body .tag").first().click();
  await page.waitForSelector("#tags[open]");
  assert.equal(await page.locator("#tags .tag-row[aria-expanded=true] .tag-name").textContent(), "#plan");
  assert.deepEqual(await page.locator("#tags .tag-pages .tag-page").evaluateAll((n) => n.map((x) => x.innerText.replace(/\s+/g, " ").trim())), ["A", "B School", "Tagged"]);
  await page.locator("#tags .tag-page", { hasText: "B" }).click();
  await page.waitForFunction(() => document.querySelector("#title").value === "B");
  assert.equal(await page.locator("#tags[open]").count(), 0);
}, ctxOpts);

await test("the Tags box lists tags with page counts, nested tags count for their parents, and the filter narrows the list", async (page) => {
  await tagsVault(page);
  await page.click("#openTags");
  await page.waitForSelector("#tags[open]");
  const rows = async () => page.locator("#tags .tag-row").evaluateAll((nodes) => nodes.map((n) => n.innerText.replace(/\s+/g, " ").trim()));
  assert.deepEqual(await rows(), ["#other 2 pages", "#plan 3 pages", "#school 2 pages", "#School/Maths 2 pages", "#tag 1 page"]);
  await page.fill("#tags .tags-filter", "#SCH");
  assert.deepEqual(await rows(), ["#school 2 pages", "#School/Maths 2 pages"]);
  await page.fill("#tags .tags-filter", "zzz");
  assert.match(await page.textContent("#tags"), /No tag matches/);
  await page.keyboard.press("Escape");
  assert.equal(await page.locator("#tags[open]").count(), 0);
}, ctxOpts);

await test("with no tags the Tags box says so, and a failing read says so calmly", async (page) => {
  await page.waitForSelector("#newNote");
  await page.click("#openTags");
  await page.waitForSelector("#tags[open]");
  assert.match(await page.textContent("#tags"), /No tags yet/);
  await page.evaluate(() => { window.__failIndex = "io"; });
  await page.keyboard.press("Escape");
  await page.click("#openTags");
  await page.waitForSelector("#tags .tags-error");
  assert.match(await page.textContent("#tags .tags-error"), /could not be read/);
}, ctxOpts);

await test("when the page index cannot be read the page list still works and nothing is shown for favorites", async (page) => {
  await tagsVault(page);
  assert.equal(await page.locator("#favorites").isVisible(), false);
  await openTagged(page, "Plain.md");
  assert.equal(await page.locator("#favorite").isVisible(), true);
}, { ...ctxOpts, before: (page) => page.addInitScript(() => { window.__failIndex = "io"; }), allow: [/./] });

await test("the star marks the open page, shows it in the Favorites list, and unmarks it again", async (page) => {
  await tagsVault(page);
  await page.waitForSelector('#favorites .tree-button[data-path="A.md"]');
  assert.deepEqual(await page.locator("#favorites .tree-label").allTextContents(), ["A"]);
  await openTagged(page, "Plain.md");
  assert.equal(await page.getAttribute("#favorite", "aria-pressed"), "false");
  assert.equal(await page.getAttribute("#favorite", "aria-label"), "Add to favorites");
  await page.click("#favorite");
  await waitSaved(page);
  assert.match((await files(page))["Plain.md"], /^---\nfavorite: true\nid: [0-9a-f-]+\n---\n\nHello\n$/);
  assert.equal(await page.getAttribute("#favorite", "aria-pressed"), "true");
  assert.equal(await page.getAttribute("#favorite", "aria-label"), "Remove from favorites");
  assert.deepEqual(await page.locator("#favorites .tree-label").allTextContents(), ["A", "Plain"]);
  await page.click("#favorite");
  await page.waitForFunction(() => !window.__mock.files.get("Plain.md").includes("favorite"));
  assert.match((await files(page))["Plain.md"], /^---\nid: [0-9a-f-]+\n---\n\nHello\n$/);
  assert.deepEqual(await page.locator("#favorites .tree-label").allTextContents(), ["A"]);
  await page.click('#favorites .tree-button[data-path="A.md"]');
  await page.waitForFunction(() => document.querySelector("#title").value === "A");
  assert.equal(await page.getAttribute("#favorite", "aria-pressed"), "true");
  assert.equal(await page.locator('#favorites .tree-row.current').count(), 1);
}, ctxOpts);

await test("marking a page keeps its other properties and text, and a favorite entry that is a list is left alone", async (page) => {
  await tagsVault(page);
  await openTagged(page, "A.md");
  await page.click("#favorite");
  await page.waitForFunction(() => !window.__mock.files.get("A.md").includes("favorite"));
  assert.equal((await files(page))["A.md"], "---\nid: aaa\ntags: [plan, School/Maths]\n---\n\nOne #plan page\n");
  assert.equal(await page.locator("#favorites").isVisible(), false);
  const odd = (await files(page))["Odd.md"];
  await openTagged(page, "Odd.md");
  await page.click("#favorite");
  await page.waitForSelector("#toast:not([hidden])");
  assert.match(await page.textContent("#toast"), /could not be changed safely/);
  await openTagged(page, "Plain.md");
  assert.equal((await files(page))["Odd.md"], odd);
}, ctxOpts);

await test("in the markdown text view the star is switched off and the property is shown as written", async (page) => {
  await tagsVault(page);
  await openTagged(page, "A.md");
  await page.click("#sourceToggle");
  await page.waitForSelector("#source:not([hidden])");
  assert.equal(await page.isDisabled("#favorite"), true);
  assert.match(await page.inputValue("#source"), /^---\ntags: \[plan, School\/Maths\]\nfavorite: true\n---/);
  await page.click("#sourceToggle");
  assert.equal(await page.isDisabled("#favorite"), false);
}, ctxOpts);

await test("Open tags and the favorites command work from the search box", async (page) => {
  await tagsVault(page);
  await openTagged(page, "Plain.md");
  await page.keyboard.press("Control+k");
  await page.waitForSelector("#palette[open]");
  await page.fill(".palette-input", "favorites");
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => window.__mock.files.get("Plain.md").includes("favorite: true"));
  await page.keyboard.press("Control+k");
  await page.waitForSelector("#palette[open]");
  await page.fill(".palette-input", "open tags");
  await page.keyboard.press("Enter");
  await page.waitForSelector("#tags[open]");
}, ctxOpts);

await test("on a phone the Tags box, the star and the Favorites list fit the screen", async (page) => {
  await tagsVault(page);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= 390), "no sideways scrolling");
  for (const b of await page.locator(".side-foot button").all()) assert.ok((await b.boundingBox()).x + (await b.boundingBox()).width <= 390);
  await page.click("#openTags");
  await page.waitForSelector("#tags[open]");
  const box = await page.locator("#tags").boundingBox();
  assert.ok(box.x >= 0 && box.x + box.width <= 390, JSON.stringify(box));
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= 390), "no sideways scrolling");
  for (const b of await page.locator("#tags .tag-row, #tags button.primary").all()) assert.ok((await b.boundingBox()).height >= 32);
}, { ...ctxOpts, viewport: { width: 390, height: 780 } });

// Screenshots of the screens added in 0.3.3 (only when SHOTS_DIR is set), in light and dark.
if (shots && !process.env.SHOTS_ONLY) {
  for (const scheme of ["light", "dark"]) {
    for (const [label, viewport] of [["desktop", { width: 1100, height: 760 }], ["phone", { width: 390, height: 800 }]]) {
      const context = await browser.newContext({ viewport, colorScheme: scheme });
      await context.addInitScript((text) => { window.__seedSettings = text; }, JSON.stringify({ vaultPath: "/vault", disclosureAccepted: true, lastSeenVersion: VERSION, updates: false }));
      await context.addInitScript({ path: path.join(here, "mock-backend.js") });
      const page = await context.newPage();
      await page.route("https://**/*", (route) => (route.request().url() === GITHUB ? route.fulfill({ status: 200, contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: "[]" }) : route.abort()));
      const name = (n) => `${shots}/v033-${label}-${scheme}-${n}.png`;
      await page.goto(url);
      await page.waitForSelector("#newNote");
      await page.evaluate(() => {
        const f = window.__mock.files;
        window.__mock.folders.add("School");
        f.set("Plan.md", "# Study plan\n\nThe plan for this term.\n\n## Goals\n\nFinish the biology notes and the maths exercises.\n");
        f.set("Home.md", "# Home\n\nStart with the [[Plan]], then [[Plan#Goals|the goals]]. Later: [[Reading list]].\n\nA second paragraph with more text to show how a link sits in a line.\n");
        f.set("School/Biology.md", "Notes for week 2. Check the [[Plan]] before the test.\n");
        f.set("School/Maths.md", "Exercises are listed in [[Plan#Goals]] and [[Plan|the plan]] too.\n");
      });
      await page.click("#newFolder");
      await page.click('.tree-button[data-path="Home.md"]');
      await page.waitForSelector(".note-body .wikilink");
      if (label === "phone") await page.evaluate(() => document.body.classList.remove("sidebar-open"));
      await page.screenshot({ path: name("1-links") });
      await page.locator(".note-body p").last().click();
      await page.keyboard.press("Control+End");
      await page.keyboard.type(" See [[B");
      await page.waitForSelector(".slash-menu");
      await page.screenshot({ path: name("2-picker") });
      await page.keyboard.press("Escape");
      await page.evaluate(() => document.body.classList.contains("sidebar-open") || 0);
      if (label === "phone") await page.click("#toggle");
      await page.click('.tree-button[data-path="Plan.md"]');
      await page.waitForSelector(".backlinks .backlink");
      if (label === "phone") await page.evaluate(() => document.body.classList.remove("sidebar-open"));
      await page.screenshot({ path: name("3-linked-from") });
      await context.close();
    }
  }
}

// Screenshots of the screens added in 0.3.5 (only when SHOTS_DIR is set), in light and dark.
if (shots && !process.env.SHOTS_ONLY) {
  for (const scheme of ["light", "dark"]) {
    for (const [label, viewport] of [["desktop", { width: 1100, height: 760 }], ["phone", { width: 390, height: 800 }]]) {
      const context = await browser.newContext({ viewport, colorScheme: scheme });
      await context.addInitScript((text) => { window.__seedSettings = text; }, JSON.stringify({ vaultPath: "/vault", disclosureAccepted: true, lastSeenVersion: VERSION, updates: false, showCovers: true }));
      await context.addInitScript({ path: path.join(here, "mock-backend.js") });
      const page = await context.newPage();
      await page.route("https://**/*", (route) => (route.request().url() === GITHUB ? route.fulfill({ status: 200, contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: "[]" }) : route.abort()));
      const name = (n) => `${shots}/v035-${label}-${scheme}-${n}.png`;
      await page.goto(url);
      await page.waitForSelector("#newNote");
      await page.evaluate((png) => {
        window.__mock.attachments.set("attachments/leaf.png", png);
        window.__mock.files.set("Study plan.md", "---\nid: abc\ncover: attachments/leaf.png\n---\n\n# Study plan\n\nThe plan for this term, with a cover picture above it.\n");
        window.__mock.files.set("Plain page.md", "# Plain page\n\nThis page has no cover yet.\n");
      }, PNG_B64);
      await page.click("#newFolder");
      await page.click('.tree-button[data-path="Study plan.md"]');
      await page.waitForSelector(".cover-image img[src]");
      if (label === "phone") await page.evaluate(() => document.body.classList.remove("sidebar-open"));
      await page.screenshot({ path: name("1-cover") });
      if (label === "phone") await page.click("#toggle");
      await page.click('.tree-button[data-path="Plain page.md"]');
      await page.waitForSelector(".cover-actions");
      if (label === "phone") await page.evaluate(() => document.body.classList.remove("sidebar-open"));
      await page.screenshot({ path: name("2-add-cover") });
      if (label === "phone") await page.click("#toggle");
      await page.click("#openSettings");
      await page.waitForSelector("#settings[open]");
      await page.screenshot({ path: name("3-settings") });
      await context.close();
    }
  }
}

// Screenshots of the screens added in 0.3.6 (only when SHOTS_DIR is set), in light and dark.
if (shots && !process.env.SHOTS_ONLY) {
  for (const scheme of ["light", "dark"]) {
    for (const [label, viewport] of [["desktop", { width: 1100, height: 760 }], ["phone", { width: 390, height: 800 }]]) {
      const context = await browser.newContext({ viewport, colorScheme: scheme });
      await context.addInitScript((text) => { window.__seedSettings = text; }, JSON.stringify({ vaultPath: "/vault", disclosureAccepted: true, lastSeenVersion: VERSION, updates: false }));
      await context.addInitScript({ path: path.join(here, "mock-backend.js") });
      const page = await context.newPage();
      await page.route("https://**/*", (route) => (route.request().url() === GITHUB ? route.fulfill({ status: 200, contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: "[]" }) : route.abort()));
      const name = (n) => `${shots}/v036-${label}-${scheme}-${n}.png`;
      await page.goto(url);
      await page.waitForSelector("#newNote");
      await page.evaluate(() => {
        const f = window.__mock.files;
        window.__mock.folders.add("School");
        f.set("Study plan.md", "---\nid: abc\nfavorite: true\n---\n\n# Study plan\n\nThis term: #school/maths, #school/biology and the #exams. Read the [[Reading list]] first.\n");
        f.set("Reading list.md", "---\nid: def\nfavorite: true\ntags: [school]\n---\n\nBooks for #school and a #todo item.\n");
        f.set("School/Maths.md", "Exercises for the #exams, see #school/maths.\n");
        f.set("School/Biology.md", "Cells, week 2. #school/biology #todo\n");
        f.set("Ideas.md", "Plain page with no tags.\n");
      });
      await page.click("#newFolder");
      await page.waitForSelector('#favorites .tree-button[data-path="Study plan.md"]');
      await page.click('#favorites .tree-button[data-path="Study plan.md"]');
      await page.waitForSelector(".note-body .tag");
      if (label === "phone") await page.click("#toggle");
      await page.screenshot({ path: name("1-sidebar-favorites") });
      if (label === "phone") await page.evaluate(() => document.body.classList.remove("sidebar-open"));
      await page.screenshot({ path: name("2-tags-in-page") });
      await page.locator(".note-body .tag").first().click();
      await page.waitForSelector("#tags[open]");
      await page.screenshot({ path: name("3-tags-box") });
      await page.fill("#tags .tags-filter", "sch");
      await page.screenshot({ path: name("4-tags-filter") });
      await context.close();
    }
  }
}

// ---------- 0.3.7: page history ----------

const OLD_TEXT = "---\nid: hid\n---\n\nAlpha\n\nBeta old\n\nGamma\n\nDelta old\n";
const NOW_TEXT = "---\nid: hid\n---\n\nAlpha\n\nBeta new\n\nGamma\n\nDelta new\n";

async function historyVault(page) {
  await page.waitForSelector("#newNote");
  await page.evaluate(([oldText, nowText]) => {
    window.__mock.files.set("Hist.md", nowText);
    window.__mock.history.set("Hist.md", [{ id: "1700000000000", time: 1700000000, text: oldText }]);
  }, [OLD_TEXT, NOW_TEXT]);
  await page.click("#newFolder");
  await page.waitForSelector('.tree-button[data-path="Hist.md"]');
  await openTagged(page, "Hist.md");
}

await test("the history box lists older versions and shows what changed", async (page) => {
  await historyVault(page);
  await page.click("#historyButton");
  await page.waitForSelector("#historyBox[open] .history-row");
  assert.equal(await page.locator(".history-row").count(), 1);
  await page.click(".history-row");
  await page.waitForSelector(".history-change");
  assert.equal(await page.locator(".history-change").count(), 2);
  const text = await page.locator(".history-detail").innerText();
  assert.match(text, /Beta new/);
  assert.match(text, /Beta old/);
  assert.equal(await page.locator("#historyBox button", { hasText: "Put back the chosen parts" }).isDisabled(), true);
}, ctxOpts);

await test("putting back one chosen part changes only that part and keeps the id", async (page) => {
  await historyVault(page);
  await page.click("#historyButton");
  await page.click(".history-row");
  await page.waitForSelector(".history-change");
  await page.locator(".history-change input").first().check();
  await page.click("#historyBox >> text=Put back the chosen parts");
  await page.waitForFunction(() => !document.querySelector("#historyBox").open);
  assert.equal((await files(page))["Hist.md"], NOW_TEXT.replace("Beta new", "Beta old"));
  const kept = await page.evaluate(() => window.__mock.history.get("Hist.md").length);
  assert.equal(kept, 2, "the text from before the restore is kept in the history");
}, ctxOpts);

await test("putting back a whole version restores it exactly", async (page) => {
  await historyVault(page);
  await page.click("#historyButton");
  await page.click(".history-row");
  await page.waitForSelector(".history-change");
  await page.click("#historyBox >> text=Put back this whole version");
  await page.waitForFunction(() => !document.querySelector("#historyBox").open);
  assert.equal((await files(page))["Hist.md"], OLD_TEXT);
}, ctxOpts);

await test("a page with no older versions says so", async (page) => {
  await tagsVault(page);
  await openTagged(page, "Plain.md");
  await page.click("#historyButton");
  await page.waitForSelector("#historyBox[open]");
  assert.match(await page.locator("#historyBox").innerText(), /no older versions yet/);
}, ctxOpts);

await test("if the page changes while the box is open nothing is put back", async (page) => {
  await historyVault(page);
  await page.click("#historyButton");
  await page.click(".history-row");
  await page.waitForSelector(".history-change");
  await page.evaluate(() => window.__mock.files.set("Hist.md", "changed elsewhere\n"));
  await page.click("#historyBox >> text=Put back this whole version");
  await page.waitForSelector(".history-status:not(:empty)");
  assert.match(await page.locator(".history-status").innerText(), /changed while the history was open/);
  assert.equal((await files(page))["Hist.md"], "changed elsewhere\n");
}, { ...ctxOpts, allow: [/./] });

await test("deleting all history asks twice", async (page) => {
  await historyVault(page);
  await page.click("#openSettings");
  const button = page.locator("button", { hasText: "Delete all history" });
  await button.click();
  assert.equal(await page.evaluate(() => window.__mock.history.size), 1, "one click only asks");
  await page.locator("button", { hasText: "Click again to delete all history" }).click();
  await page.waitForFunction(() => window.__mock.history.size === 0);
}, ctxOpts);

await test("a lone version opens at once, the page properties are one note, and with no versions there are no put-back buttons", async (page) => {
  await historyVault(page);
  await page.click("#historyButton");
  await page.waitForSelector(".history-change");
  assert.match(await page.locator(".history-detail").innerText(), /Page properties \(3 lines\)/);
  assert.equal(await page.locator("#historyBox button", { hasText: "Put back this whole version" }).isVisible(), true);
  await page.keyboard.press("Escape");
  await tagsVault(page);
  await openTagged(page, "Plain.md");
  await page.click("#historyButton");
  await page.waitForSelector("#historyBox[open]");
  assert.equal(await page.locator("#historyBox button", { hasText: "Put back this whole version" }).isVisible(), false);
  assert.equal(await page.locator("#historyBox button", { hasText: "Put back the chosen parts" }).isVisible(), false);
}, ctxOpts);

// ---------- 0.3.7: export and print ----------

await test("the page can be exported from the command list, and a failure is shown calmly", async (page) => {
  await tagsVault(page);
  await openTagged(page, "Plain.md");
  await openPaletteBox(page);
  await page.fill(".palette-input", "Export this page");
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => (window.__pageExports || []).length === 1);
  assert.deepEqual(await page.evaluate(() => window.__pageExports), ["Plain.md"]);
  assert.match(await page.locator(".toast").innerText(), /Exported to .*exports.*1 pictures/);
  await page.evaluate(() => { window.__failExport = "io"; });
  await openPaletteBox(page);
  await page.fill(".palette-input", "Export this page");
  await page.keyboard.press("Enter");
  await page.waitForSelector(".banner:not([hidden])");
  assert.match(await page.locator("#banner").innerText(), /could not be exported/);
}, { ...ctxOpts, allow: [/./] });

await test("printing leaves out the page list and the buttons but keeps the title and the text", async (page) => {
  await tagsVault(page);
  await openTagged(page, "Tagged.md");
  await page.emulateMedia({ media: "print" });
  assert.equal(await page.locator("#sidebar").isVisible(), false);
  assert.equal(await page.locator("#favorite").isVisible(), false);
  assert.equal(await page.locator("#title").isVisible(), true);
  assert.equal(await page.locator(".note-body").isVisible(), true);
  const pdf = await page.pdf();
  assert.equal(pdf.subarray(0, 4).toString(), "%PDF");
}, ctxOpts);

// Screenshots of the screens added in 0.3.7 (only when SHOTS_DIR is set), in light and dark.
if (shots && !process.env.SHOTS_ONLY) {
  for (const scheme of ["light", "dark"]) {
    for (const [label, viewport] of [["desktop", { width: 1100, height: 760 }], ["phone", { width: 390, height: 800 }]]) {
      const context = await browser.newContext({ viewport, colorScheme: scheme });
      await context.addInitScript((text) => { window.__seedSettings = text; }, JSON.stringify({ vaultPath: "/vault", disclosureAccepted: true, lastSeenVersion: VERSION, updates: false }));
      await context.addInitScript({ path: path.join(here, "mock-backend.js") });
      const page = await context.newPage();
      await page.route("https://**/*", (route) => (route.request().url() === GITHUB ? route.fulfill({ status: 200, contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: "[]" }) : route.abort()));
      const name = (n) => `${shots}/v037-${label}-${scheme}-${n}.png`;
      await page.goto(url);
      await historyVault(page);
      if (label === "phone") await page.evaluate(() => document.body.classList.remove("sidebar-open"));
      await page.screenshot({ path: name("1-page-with-history-button") });
      await page.click("#historyButton");
      await page.waitForSelector("#historyBox[open] .history-row");
      await page.screenshot({ path: name("2-history-list") });
      await page.click(".history-row");
      await page.waitForSelector(".history-change");
      await page.locator(".history-change input").first().check();
      await page.screenshot({ path: name("3-history-changes") });
      await page.click(".history-view >> text=Whole text");
      await page.screenshot({ path: name("4-history-whole-text") });
      await page.keyboard.press("Escape");
      await page.evaluate(() => document.getElementById("openSettings").click()); // hidden with the page list on a phone
      await page.locator("h3", { hasText: "Page history" }).scrollIntoViewIfNeeded();
      await page.screenshot({ path: name("5-settings-history") });
      await context.close();
    }
  }
}

// ---------- 0.4.0: canvas with a pressure pen and an eraser ----------

async function canvasVault(page, drawing) {
  await page.waitForSelector("#newNote");
  await page.evaluate((text) => {
    window.__mock.files.set("Sketch.md", "A page to draw on\n");
    window.__mock.files.set("Other.md", "Another page\n");
    if (text) window.__mock.canvases.set("Sketch.md", text);
  }, drawing || null);
  await page.click("#newFolder");
  await page.waitForSelector('.tree-button[data-path="Sketch.md"]');
  await openTagged(page, "Sketch.md");
}
const openCanvas = async (page) => {
  await page.click("#canvasToggle");
  await page.waitForSelector("#canvasHost:not([hidden]) .canvas-surface");
};
const sheetBox = (page) => page.locator(".canvas-surface").boundingBox();
// The shapes, colours, widths and the less used switches are in small menus under their buttons.
// A menu that is already open is not opened again (pressing its button would close it).
async function menuPick(page, menu, label) {
  const panel = page.locator(`.canvas-menu[data-menu="${menu}"]`);
  if (!(await panel.isVisible())) await page.click(`.canvas-toolbar [data-menu="${menu}"]`);
  await panel.locator(`button[aria-label="${label}"], button:text-is("${label}")`).click();
}
async function chooseColour(page, name) {
  const panel = page.locator('.canvas-menu[data-menu="colour"]');
  if (!(await panel.isVisible())) await page.click('.canvas-toolbar [data-menu="colour"]');
  await panel.locator(`.canvas-colour[data-colour="${name}"]`).click();
}
// The width menu is a slider with five stops (0 = thinnest, 4 = thickest).
async function chooseWidth(page, stop) {
  const panel = page.locator('.canvas-menu[data-menu="width"]');
  if (!(await panel.isVisible())) await page.click('.canvas-toolbar [data-menu="width"]');
  await panel.locator("input[type=range]").fill(String(stop));
}
const chooseMore = (page, label) => menuPick(page, "more", label);
async function drawLine(page, from, to, steps = 8) {
  const box = await sheetBox(page);
  await page.mouse.move(box.x + from[0], box.y + from[1]);
  await page.mouse.down();
  await page.mouse.move(box.x + to[0], box.y + to[1], { steps });
  await page.mouse.up();
}
const savedDrawing = (page, path = "Sketch.md") => page.evaluate((p) => { const t = window.__mock.canvases.get(p); return t === undefined ? null : JSON.parse(t); }, path);
// A pen event with a real pressure: the test browser's mouse cannot report one.
const penStroke = (page, points) => page.evaluate((pts) => {
  const surface = document.querySelector(".canvas-surface");
  const box = surface.getBoundingClientRect();
  const fire = (type, [x, y, pressure], buttons) => surface.dispatchEvent(new PointerEvent(type, { pointerId: 7, pointerType: "pen", isPrimary: true, clientX: box.x + x, clientY: box.y + y, pressure, button: 0, buttons, bubbles: true, cancelable: true }));
  fire("pointerdown", pts[0], 1);
  for (const p of pts.slice(1)) fire("pointermove", p, 1);
  fire("pointerup", pts[pts.length - 1], 0);
}, points);
const touchEvents = (page, id, type, x, y) => page.evaluate(([i, t, px, py]) => {
  const surface = document.querySelector(".canvas-surface");
  const box = surface.getBoundingClientRect();
  surface.dispatchEvent(new PointerEvent(t, { pointerId: i, pointerType: "touch", isPrimary: i === 21, clientX: box.x + px, clientY: box.y + py, pressure: 0.5, button: 0, buttons: t === "pointerup" ? 0 : 1, bubbles: true, cancelable: true }));
}, [id, type, x, y]);

await test("a page can switch to its canvas and back, and a stroke is saved next to the page, not in it", async (page) => {
  await canvasVault(page);
  assert.equal(await page.locator("#canvasToggle").isVisible(), true);
  await openCanvas(page);
  assert.equal(await page.locator("#editor").isVisible(), false);
  await drawLine(page, [60, 80], [260, 160]);
  await waitSaved(page);
  const drawing = await savedDrawing(page);
  assert.equal(drawing.format, 1);
  assert.equal(drawing.strokes.length, 1);
  assert.equal(drawing.strokes[0].color, "ink");
  assert.equal(drawing.strokes[0].width, 4);
  assert.ok(drawing.strokes[0].points.length >= 5);
  assert.equal((await files(page))["Sketch.md"], "A page to draw on\n", "the page text is untouched");
  await page.click("#canvasToggle");
  assert.equal(await page.locator("#editor").isVisible(), true);
  assert.equal(await page.locator("#canvasHost").isVisible(), false);
  await openCanvas(page);
  assert.equal((await savedDrawing(page)).strokes.length, 1, "opening it again shows and keeps the drawing");
}, ctxOpts);

await test("a pen's pressure is kept, a light touch is thin and a firm one thick", async (page) => {
  await canvasVault(page);
  await openCanvas(page);
  await penStroke(page, [[50, 50, 0.1], [80, 60, 0.4], [120, 70, 0.9], [160, 70, 1]]);
  await waitSaved(page);
  const points = (await savedDrawing(page)).strokes[0].points;
  assert.deepEqual(points.map((p) => p[2]), [0.1, 0.4, 0.9, 1]);
}, ctxOpts);

await test("colour and line width are chosen from the toolbar and kept with the stroke", async (page) => {
  await canvasVault(page);
  await openCanvas(page);
  await chooseColour(page, "red");
  await chooseWidth(page, 3);
  await drawLine(page, [60, 80], [200, 80]);
  await waitSaved(page);
  const stroke = (await savedDrawing(page)).strokes[0];
  assert.equal(stroke.color, "red");
  assert.equal(stroke.width, 8);
  assert.equal(await page.getAttribute('.canvas-colour[data-colour="red"]', "aria-pressed"), "true");
}, ctxOpts);

await test("the eraser removes whole strokes it touches, and Undo and Redo bring them back", async (page) => {
  await canvasVault(page);
  await openCanvas(page);
  await drawLine(page, [60, 80], [260, 80]);
  await drawLine(page, [60, 200], [260, 200]);
  await waitSaved(page);
  assert.equal((await savedDrawing(page)).strokes.length, 2);
  await page.click('.canvas-toolbar button[aria-label="Eraser"]');
  await drawLine(page, [160, 60], [160, 100], 4);
  await waitSaved(page);
  let strokes = (await savedDrawing(page)).strokes;
  assert.equal(strokes.length, 1);
  assert.ok(Math.abs(strokes[0].points[0][1] - 176) < 3, "the lower stroke is the one left (the sheet starts 24 units in from the corner)");
  await page.click('.canvas-toolbar button[aria-label="Undo"]');
  await waitSaved(page);
  assert.equal((await savedDrawing(page)).strokes.length, 2);
  await page.click('.canvas-toolbar button[aria-label="Redo"]');
  await waitSaved(page);
  assert.equal((await savedDrawing(page)).strokes.length, 1);
  // The keyboard does the same.
  await page.locator(".canvas-surface").focus();
  await page.keyboard.press("Control+z");
  await waitSaved(page);
  assert.equal((await savedDrawing(page)).strokes.length, 2);
  await page.keyboard.press("Control+Shift+Z");
  await waitSaved(page);
  assert.equal((await savedDrawing(page)).strokes.length, 1);
}, ctxOpts);

await test("a finger moves the sheet and never draws, unless Finger draws is on", async (page) => {
  await canvasVault(page);
  await openCanvas(page);
  await touchEvents(page, 21, "pointerdown", 100, 100);
  await touchEvents(page, 21, "pointermove", 140, 130);
  await touchEvents(page, 21, "pointerup", 140, 130);
  await page.waitForTimeout(1200);
  assert.equal(await savedDrawing(page), null, "nothing was drawn or saved");
  await chooseMore(page, "Finger draws");
  await touchEvents(page, 21, "pointerdown", 100, 100);
  await touchEvents(page, 21, "pointermove", 140, 130);
  await touchEvents(page, 21, "pointerup", 140, 130);
  await waitSaved(page);
  assert.equal((await savedDrawing(page)).strokes.length, 1);
}, { ...ctxOpts, hasTouch: true });

await test("a pen's barrel button erases while it is held", async (page) => {
  await canvasVault(page);
  await openCanvas(page);
  await drawLine(page, [60, 80], [260, 80]);
  await waitSaved(page);
  await page.evaluate(() => {
    const surface = document.querySelector(".canvas-surface");
    const box = surface.getBoundingClientRect();
    const fire = (type, x, buttons) => surface.dispatchEvent(new PointerEvent(type, { pointerId: 9, pointerType: "pen", isPrimary: true, clientX: box.x + x, clientY: box.y + 80, pressure: 0.5, button: 0, buttons, bubbles: true, cancelable: true }));
    fire("pointerdown", 150, 3);
    fire("pointermove", 160, 3);
    fire("pointerup", 160, 0);
  });
  await waitSaved(page);
  assert.equal((await savedDrawing(page)).strokes.length, 0);
}, ctxOpts);

await test("a drawing that cannot be read is shown but never changed or saved over", async (page) => {
  await canvasVault(page, '{"format":1,"strokes":[{"tool":"pen","color":"ink","width":4,"points":[[0,0,0.5]]},{"tool":"laser"}]}');
  const before = await page.evaluate(() => window.__mock.canvases.get("Sketch.md"));
  await openCanvas(page);
  assert.match(await page.locator(".canvas-problem").innerText(), /could not be read/);
  assert.equal(await page.locator('.canvas-toolbar button[aria-label="Undo"]').isDisabled(), true);
  assert.equal(await page.locator('.canvas-toolbar button[aria-label="Pen"]').isDisabled(), true);
  await drawLine(page, [60, 80], [260, 80]);
  await page.waitForTimeout(1200);
  assert.equal(await page.evaluate(() => window.__mock.canvases.get("Sketch.md")), before);
}, ctxOpts);

await test("a drawing from a newer version is read-only with its own message", async (page) => {
  await canvasVault(page, '{"format":4,"items":[]}');
  await openCanvas(page);
  assert.match(await page.locator(".canvas-problem").innerText(), /newer version/);
}, ctxOpts);

await test("if the drawing was changed elsewhere, saving stops and the other drawing is kept", async (page) => {
  await canvasVault(page, '{"format":1,"strokes":[]}');
  await openCanvas(page);
  await page.evaluate(() => window.__mock.canvases.set("Sketch.md", '{"format":1,"strokes":[{"tool":"pen","color":"red","width":2,"points":[[1,1,0.5]]}]}'));
  await drawLine(page, [60, 80], [260, 80]);
  await page.waitForSelector(".canvas-problem:not([hidden])");
  assert.match(await page.locator(".canvas-problem").innerText(), /changed by another program/);
  assert.equal((await savedDrawing(page)).strokes[0].color, "red");
  assert.equal(await page.locator('.canvas-toolbar button[aria-label="Pen"]').isDisabled(), true);
}, { ...ctxOpts, allow: [/./] });

await test("opening another page leaves the canvas, and what was drawn is saved first", async (page) => {
  await canvasVault(page);
  await openCanvas(page);
  await drawLine(page, [60, 80], [260, 80]);
  await page.click('.tree-button[data-path="Other.md"]');
  await page.waitForFunction(() => document.querySelector("#title").value === "Other");
  assert.equal((await savedDrawing(page)).strokes.length, 1, "saved before leaving");
  assert.equal(await page.locator("#canvasHost").isVisible(), false);
  assert.equal(await page.locator("#editor").isVisible(), true);
  assert.equal(await savedDrawing(page, "Other.md"), null, "the other page has no drawing");
}, ctxOpts);

await test("the command list switches between the text and the canvas", async (page) => {
  await canvasVault(page);
  await openPaletteBox(page);
  await page.fill(".palette-input", "canvas of this page");
  await page.keyboard.press("Enter");
  await page.waitForSelector("#canvasHost:not([hidden])");
  await openPaletteBox(page);
  await page.fill(".palette-input", "canvas of this page");
  await page.keyboard.press("Enter");
  await page.waitForSelector("#canvasHost", { state: "hidden" });
  assert.equal(await page.locator("#editor").isVisible(), true);
}, ctxOpts);

await test("a long fast scribble, rapid clicks and tools pressed in any order raise no errors", async (page) => {
  await canvasVault(page);
  await openCanvas(page);
  const box = await sheetBox(page);
  await page.mouse.move(box.x + 20, box.y + 20);
  await page.mouse.down();
  for (let i = 0; i < 300; i++) await page.mouse.move(box.x + 20 + (i % 150) * 3, box.y + 20 + ((i * 7) % 250));
  await page.mouse.up();
  for (let i = 0; i < 10; i++) { await page.click('.canvas-toolbar button[aria-label="Undo"]'); await page.click('.canvas-toolbar button[aria-label="Redo"]'); await page.click('.canvas-toolbar button[aria-label="Eraser"]'); await page.click('.canvas-toolbar button[aria-label="Pen"]'); }
  await page.click('.canvas-toolbar button[aria-label="Move the sheet"]');
  await page.mouse.move(box.x + 100, box.y + 100);
  await page.mouse.down();
  await page.mouse.move(box.x + 200, box.y + 160, { steps: 5 });
  await page.mouse.up();
  await chooseMore(page, "Show all");
  await page.mouse.wheel(0, 120);
  await waitSaved(page);
  const drawing = await savedDrawing(page);
  assert.ok(drawing.strokes.length <= 1);
}, ctxOpts);

await test("on a phone the canvas toolbar fits the window and the sheet fills the rest", async (page) => {
  await canvasVault(page);
  await page.evaluate(() => document.body.classList.remove("sidebar-open"));
  await openCanvas(page);
  const window_ = page.viewportSize();
  const toolbar = await page.locator(".canvas-toolbar").boundingBox();
  assert.ok(toolbar.x >= 0 && toolbar.x + toolbar.width <= window_.width + 1);
  const buttons = await page.locator(".canvas-toolbar button").evaluateAll((nodes) => nodes.map((n) => { const b = n.getBoundingClientRect(); return b.right <= window.innerWidth + 1 && b.left >= 0; }));
  assert.ok(buttons.every(Boolean), "every tool can be reached");
  const sheet = await sheetBox(page);
  assert.ok(sheet.width >= window_.width - 2 && sheet.height > 300);
  // The top bar has the star, the history clock, Text and the save status; the title keeps room.
  assert.ok((await page.locator("#title").boundingBox()).width >= 90, "the page title is still readable");
}, { viewport: { width: 390, height: 800 }, settings: existingUser({ updates: false }) });

// ---------- 0.4.1: highlighter, shapes, sticky notes, lasso, pen button ----------

const SHAPE_LABELS = ["Line", "Arrow", "Rectangle", "Ellipse"];
const tool = (page, label) => (SHAPE_LABELS.includes(label) ? menuPick(page, "shape", label) : page.click(`.canvas-toolbar button[aria-label="${label}"]`));
// A pen-only drawing is still written in the 0.4.0 format, with its strokes under another key.
const items = async (page) => {
  const drawing = await savedDrawing(page);
  return drawing.items || drawing.strokes;
};
// A drag with the mouse across the sheet, through several corners.
async function dragPath(page, corners, steps = 6) {
  const box = await sheetBox(page);
  await page.mouse.move(box.x + corners[0][0], box.y + corners[0][1]);
  await page.mouse.down();
  for (const [x, y] of corners.slice(1)) await page.mouse.move(box.x + x, box.y + y, { steps });
  await page.mouse.up();
}
// A sticky note is drawn as a box, like a shape; its text box opens when the pointer is released.
async function dragNote(page, from, to) {
  await tool(page, "Sticky note");
  await dragPath(page, [from, to]);
  await page.waitForSelector(".canvas-note-input");
}
const barrelEvents = (page, points, buttons) => page.evaluate(([pts, b]) => {
  const surface = document.querySelector(".canvas-surface");
  const box = surface.getBoundingClientRect();
  const fire = (type, [x, y], held) => surface.dispatchEvent(new PointerEvent(type, { pointerId: 11, pointerType: "pen", isPrimary: true, clientX: box.x + x, clientY: box.y + y, pressure: 0.5, button: 0, buttons: held, bubbles: true, cancelable: true }));
  fire("pointerdown", pts[0], b);
  for (const p of pts.slice(1)) fire("pointermove", p, b);
  fire("pointerup", pts[pts.length - 1], 0);
}, [points, buttons]);

await test("the highlighter draws a wide see-through stroke that is saved in the new file format", async (page) => {
  await canvasVault(page);
  await openCanvas(page);
  await tool(page, "Highlighter");
  await drawLine(page, [60, 80], [260, 80]);
  await waitSaved(page);
  const drawing = await savedDrawing(page);
  assert.equal(drawing.format, 2);
  assert.equal(drawing.items[0].tool, "highlighter");
  assert.equal(drawing.items[0].width, 4);
  assert.ok(drawing.items[0].points.every((p) => p[2] === 0.5), "a highlighter ignores pressure");
}, ctxOpts);

await test("a drawing with only pen strokes keeps the older file format, and one from 0.4.0 opens and grows", async (page) => {
  await canvasVault(page, '{"format":1,"strokes":[{"tool":"pen","color":"red","width":2,"points":[[1,1,0.5],[9,9,0.5]]}]}');
  await openCanvas(page);
  await drawLine(page, [60, 80], [260, 80]);
  await waitSaved(page);
  let drawing = await savedDrawing(page);
  assert.equal(drawing.format, 1);
  assert.equal(drawing.strokes.length, 2);
  await tool(page, "Rectangle");
  await dragPath(page, [[60, 120], [200, 200]]);
  await waitSaved(page);
  drawing = await savedDrawing(page);
  assert.equal(drawing.format, 2, "a shape needs the new format");
  assert.equal(drawing.items.length, 3);
  assert.equal(drawing.items[0].color, "red", "the old stroke is kept as it was");
  await tool(page, "Undo");
  await waitSaved(page);
  assert.equal((await savedDrawing(page)).format, 1, "without the shape it is the older format again");
}, ctxOpts);

await test("each shape is drawn by dragging, a stray tap draws nothing, and a shape can be erased and brought back", async (page) => {
  await canvasVault(page);
  await openCanvas(page);
  await chooseColour(page, "green");
  for (const [label, from, to] of [["Line", [40, 40], [140, 60]], ["Arrow", [40, 100], [200, 100]], ["Rectangle", [40, 140], [140, 220]], ["Ellipse", [180, 140], [300, 220]]]) {
    await tool(page, label);
    await dragPath(page, [from, to]);
  }
  await tool(page, "Rectangle");
  const box = await sheetBox(page);
  await page.mouse.click(box.x + 300, box.y + 40);
  await waitSaved(page);
  const saved = await items(page);
  assert.deepEqual(saved.map((i) => i.kind), ["line", "arrow", "rect", "ellipse"]);
  assert.ok(saved.every((i) => i.tool === "shape" && i.color === "green" && i.width === 4));
  assert.deepEqual(saved[2].a.map(Math.round), [16, 116]);
  assert.deepEqual(saved[2].b.map(Math.round), [116, 196]);
  // Erase the rectangle by touching its edge, not its empty middle.
  await tool(page, "Eraser");
  await page.mouse.click(box.x + 90, box.y + 180);
  await waitSaved(page);
  assert.equal((await items(page)).length, 4, "the middle of a shape is not touched");
  await dragPath(page, [[90, 138], [92, 142]], 2);
  await waitSaved(page);
  assert.deepEqual((await items(page)).map((i) => i.kind), ["line", "arrow", "ellipse"]);
  await tool(page, "Undo");
  await waitSaved(page);
  assert.equal((await items(page)).length, 4);
}, { settings: existingUser({ updates: false, snapShapes: false }) });

await test("a sticky note is typed into a box on the sheet, saved with its text, and a stray tap leaves nothing", async (page) => {
  await canvasVault(page);
  await openCanvas(page);
  await tool(page, "Sticky note");
  const box = await sheetBox(page);
  await page.mouse.click(box.x + 300, box.y + 40);
  assert.equal(await page.locator(".canvas-note-input").count(), 0, "a tap does not choose a size for the note");
  await page.waitForSelector(".toast");
  await dragNote(page, [300, 40], [480, 100]);
  await page.keyboard.press("Escape");
  await page.waitForSelector(".canvas-note-input", { state: "detached" });
  await page.waitForTimeout(1200);
  assert.equal(await page.evaluate(() => window.__mock.canvases.get("Sketch.md")), undefined, "an empty note adds nothing, so nothing is written");
  await chooseColour(page, "orange");
  await dragNote(page, [100, 100], [280, 180]);
  await page.keyboard.type("Buy <b>milk</b> & \"eggs\"\nand a very long word that has to be wrapped inside the note");
  await page.keyboard.press("Control+Enter");
  await waitSaved(page);
  const note = (await items(page))[0];
  assert.equal(note.tool, "note");
  assert.equal(note.color, "orange");
  assert.equal(note.text, 'Buy <b>milk</b> & "eggs"\nand a very long word that has to be wrapped inside the note');
  assert.ok(note.h > 80, "a longer text than the drawn box holds makes the note taller");
  assert.equal(note.w, 180, "the width is the width that was drawn");
  const tall = note.h;
  assert.equal(await page.locator("#canvasHost b").count(), 0, "the text is never read as markup");
  // Tapping the note edits it; Undo goes back to the earlier text.
  await page.mouse.click(box.x + 124, box.y + 120);
  await page.waitForSelector(".canvas-note-input");
  await page.fill(".canvas-note-input", "Changed");
  await page.mouse.click(box.x + 400, box.y + 300);
  await waitSaved(page);
  assert.equal((await items(page))[0].text, "Changed");
  assert.equal((await items(page))[0].h, tall, "a shorter text does not shrink the note");
  await tool(page, "Undo");
  await waitSaved(page);
  assert.match((await items(page))[0].text, /^Buy/);
}, ctxOpts);

await test("a sticky note is drawn as a box and gets that size, and a note can be resized from its corner", async (page) => {
  await canvasVault(page);
  await openCanvas(page);
  await dragNote(page, [100, 100], [340, 220]);
  await page.keyboard.type("Hi");
  await page.keyboard.press("Control+Enter");
  await waitSaved(page);
  let note = (await items(page))[0];
  assert.deepEqual([note.x, note.y, note.w, note.h], [80, 80, 240, 120], "the box that was drawn, on the grid");

  // Tap the note with the select tool: it is selected and shows its handle; drag the handle.
  await tool(page, "Select with a loop");
  const box = await sheetBox(page);
  await page.mouse.click(box.x + 200, box.y + 160);
  await page.mouse.move(box.x + 344, box.y + 224); // the bottom right corner on the screen
  await page.mouse.down();
  await page.mouse.move(box.x + 420, box.y + 300, { steps: 6 });
  await page.mouse.up();
  await waitSaved(page);
  note = (await items(page))[0];
  assert.deepEqual([note.x, note.y, note.w, note.h], [80, 80, 320, 200], "the corner went to the pointer, on the grid");

  // It cannot be made too small to show its text.
  await page.mouse.move(box.x + 424, box.y + 304);
  await page.mouse.down();
  await page.mouse.move(box.x + 110, box.y + 110, { steps: 6 });
  await page.mouse.up();
  await waitSaved(page);
  note = (await items(page))[0];
  assert.ok(note.w >= 20 && note.h >= 19 + 16, "never smaller than the limits and the text: " + JSON.stringify(note));

  // One undo takes the resize back.
  await tool(page, "Undo");
  await waitSaved(page);
  note = (await items(page))[0];
  assert.deepEqual([note.w, note.h], [320, 200]);
}, ctxOpts);

await test("a note still being typed is saved when the page is left or the window is hidden", async (page) => {
  await canvasVault(page);
  await openCanvas(page);
  await dragNote(page, [100, 100], [280, 180]);
  await page.keyboard.type("Half written");
  await page.click("#canvasToggle");
  await waitSaved(page);
  assert.equal((await items(page))[0].text, "Half written");
}, ctxOpts);

await test("a loop selects what it surrounds, the selection can be moved, deleted, and brought back", async (page) => {
  await canvasVault(page);
  await openCanvas(page);
  await drawLine(page, [60, 80], [260, 80]);
  await drawLine(page, [60, 240], [260, 240]);
  await tool(page, "Select with a loop");
  assert.equal(await page.locator('[data-action="delete-selection"]').isDisabled(), true);
  await dragPath(page, [[30, 50], [290, 50], [290, 120], [30, 120], [30, 52]], 3);
  assert.equal(await page.locator('[data-action="delete-selection"]').isDisabled(), false, "one stroke is selected");
  // Drag from inside the selection: only the selected stroke moves.
  await dragPath(page, [[150, 80], [170, 110]], 4);
  await waitSaved(page);
  let saved = await items(page);
  const moved = saved[0].points[0];
  assert.ok(Math.abs(moved[0] - (36 + 20)) < 2 && Math.abs(moved[1] - (56 + 30)) < 2, `moved by the drag: ${moved}`);
  assert.ok(Math.abs(saved[1].points[0][1] - 216) < 2, "the other stroke stayed");
  await tool(page, "Undo");
  await waitSaved(page);
  assert.ok(Math.abs((await items(page))[0].points[0][1] - 56) < 2, "Undo puts it back");
  await tool(page, "Redo");
  // Delete with the button, then with the key after selecting again.
  await page.click('[data-action="delete-selection"]');
  await waitSaved(page);
  assert.equal((await items(page)).length, 1);
  await tool(page, "Undo");
  await waitSaved(page);
  assert.equal((await items(page)).length, 2);
  await page.locator(".canvas-surface").focus();
  await dragPath(page, [[30, 200], [290, 200], [290, 280], [30, 280], [30, 202]], 3);
  await page.keyboard.press("Delete");
  await waitSaved(page);
  assert.equal((await items(page)).length, 1);
  assert.ok(Math.abs((await items(page))[0].points[0][1] - 86) < 2, "the lower one is gone, the moved one is left");
}, ctxOpts);

await test("a tap away from the selection, Escape or another tool clears it, and a loop around nothing selects nothing", async (page) => {
  await canvasVault(page);
  await openCanvas(page);
  await drawLine(page, [60, 80], [260, 80]);
  await tool(page, "Select with a loop");
  const loop = [[30, 50], [290, 50], [290, 120], [30, 120], [30, 52]];
  const deleteDisabled = () => page.locator('[data-action="delete-selection"]').isDisabled();
  await dragPath(page, loop, 3);
  assert.equal(await deleteDisabled(), false);
  const box = await sheetBox(page);
  await page.mouse.click(box.x + 400, box.y + 300);
  assert.equal(await deleteDisabled(), true, "a tap elsewhere");
  await dragPath(page, loop, 3);
  await page.keyboard.press("Escape");
  assert.equal(await deleteDisabled(), true, "Escape");
  await dragPath(page, loop, 3);
  await tool(page, "Pen");
  assert.equal(await deleteDisabled(), true, "another tool");
  await tool(page, "Select with a loop");
  await dragPath(page, [[300, 200], [380, 200], [380, 260], [300, 260]], 3);
  assert.equal(await deleteDisabled(), true, "a loop around nothing");
}, ctxOpts);

await test("selecting and moving works with a pen, with a finger-free phone layout, and moves are limited to the sheet", async (page) => {
  await canvasVault(page);
  await openCanvas(page);
  await tool(page, "Rectangle");
  await dragPath(page, [[60, 80], [160, 160]]);
  await tool(page, "Select with a loop");
  await barrelEvents(page, [[30, 50], [200, 50], [200, 200], [30, 200], [30, 52]], 1);
  assert.equal(await page.locator('[data-action="delete-selection"]').isDisabled(), false, "a pen can draw the loop");
  await barrelEvents(page, [[100, 100], [140, 140], [400, 140]], 1);
  await waitSaved(page);
  const rect = (await items(page))[0];
  assert.ok(rect.a[0] > 100 && Math.abs(rect.a[1] - (56 + 40)) < 2);
}, { settings: existingUser({ updates: false, snapShapes: false }) });

await test("the pen button erases by default, can select with a loop, or can be set to do nothing", async (page) => {
  await canvasVault(page);
  await openCanvas(page);
  await drawLine(page, [60, 80], [260, 80]);
  await waitSaved(page);
  const setting = async (value) => {
    await page.click("#openSettings");
    await page.selectOption('select[aria-label="Pen button"]', value);
    await page.keyboard.press("Escape");
    await page.waitForSelector("#settings", { state: "hidden" });
  };
  await barrelEvents(page, [[100, 80], [110, 80]], 2);
  await waitSaved(page);
  assert.equal((await items(page)).length, 0, "erases by default");
  await tool(page, "Undo");
  await waitSaved(page);
  await setting("none");
  await barrelEvents(page, [[100, 200], [160, 220], [220, 200]], 2);
  await waitSaved(page);
  assert.equal((await items(page)).length, 2, "does nothing special: the pen draws");
  await setting("select");
  await barrelEvents(page, [[30, 50], [290, 50], [290, 120], [30, 120], [30, 52]], 2);
  assert.equal(await page.locator('[data-action="delete-selection"]').isDisabled(), false, "selects with a loop");
  assert.equal((await items(page)).length, 2, "and nothing is drawn or erased");
  // The eraser end always erases, whatever the setting.
  await barrelEvents(page, [[200, 80], [210, 80]], 32);
  await waitSaved(page);
  assert.equal((await items(page)).length, 1);
  await page.click("#openSettings");
  assert.equal(await page.locator('select[aria-label="Pen button"]').inputValue(), "select", "the choice is kept");
}, ctxOpts);

await test("the drawing tools can be used in any order, quickly, with huge notes, without errors", async (page) => {
  await canvasVault(page);
  await openCanvas(page);
  const box = await sheetBox(page);
  for (let round = 0; round < 3; round++) {
    for (const label of ["Select with a loop", "Pen", "Highlighter", "Eraser", "Line", "Arrow", "Rectangle", "Ellipse", "Sticky note", "Move the sheet"]) {
      await tool(page, label);
      await page.mouse.click(box.x + 80 + round * 40, box.y + 80);
      await dragPath(page, [[50, 50], [200, 120], [100, 180]], 2);
      await page.keyboard.press("Escape");
    }
  }
  await dragNote(page, [300, 250], [480, 330]);
  await page.fill(".canvas-note-input", "word ".repeat(1000));
  await page.keyboard.press("Control+Enter");
  await waitSaved(page);
  const noteItem = (await items(page)).find((i) => i.tool === "note");
  assert.ok(noteItem.text.length <= 2000, "a note is cut at its limit");
  await chooseMore(page, "Show all");
  await page.click('[data-action="delete-selection"]', { force: true }).catch(() => {});
}, ctxOpts);

await test("a drawing with every kind of item, and notes with odd text, opens without errors and is not changed by opening", async (page) => {
  const file = serializeForTest([
    { tool: "highlighter", color: "blue", width: 8, points: [[0, 0, 0.5], [90, 10, 0.5]] },
    { tool: "shape", kind: "ellipse", color: "red", width: 2, a: [10, 40], b: [90, 90] },
    { tool: "note", color: "green", x: 120, y: 20, w: 180, h: 60, text: "</textarea><script>window.__broken = true</script>\u0000 \u{1F600}" },
  ]);
  await canvasVault(page, file);
  await openCanvas(page);
  assert.equal(await page.locator(".canvas-problem").isHidden(), true);
  await page.waitForTimeout(1200);
  assert.equal(await page.evaluate(() => window.__mock.canvases.get("Sketch.md")), file, "just looking changes nothing");
  assert.equal(await page.evaluate(() => window.__broken), undefined);
}, ctxOpts);

function serializeForTest(list) {
  return `{"format":2,"items":[\n${list.map((i) => JSON.stringify(i)).join(",\n")}\n]}\n`;
}

// ---------- 0.4.2: a compact drawing toolbar with menus, and buttons at the foot of the sidebar ----------

await test("the drawing toolbar is one line on a wide window and at most two on a phone, so the sheet keeps its room", async (page) => {
  await canvasVault(page);
  await page.evaluate(() => document.body.classList.remove("sidebar-open"));
  await openCanvas(page);
  const height = (await page.locator(".canvas-toolbar").boundingBox()).height;
  assert.ok(height < 60, `one line: ${height}px`);
  assert.ok((await sheetBox(page)).height > 600);
}, { viewport: { width: 900, height: 1000 }, settings: existingUser({ updates: false }) });

await test("on a phone the drawing toolbar takes at most two lines", async (page) => {
  await canvasVault(page);
  await page.evaluate(() => document.body.classList.remove("sidebar-open"));
  await openCanvas(page);
  const height = (await page.locator(".canvas-toolbar").boundingBox()).height;
  assert.ok(height < 110, `two lines at most: ${height}px`);
}, { viewport: { width: 390, height: 800 }, settings: existingUser({ updates: false }) });

await test("shapes snap to a grid by default, so shapes drawn at different times line up, and the setting turns it off", async (page) => {
  await canvasVault(page);
  await openCanvas(page);
  await tool(page, "Rectangle");
  // Two rectangles that are meant to share an edge, drawn a few pixels apart.
  await dragPath(page, [[43, 143], [141, 221]]);
  await dragPath(page, [[139, 145], [239, 218]]);
  await waitSaved(page);
  let saved = await items(page);
  const corners = saved.flatMap((i) => [...i.a, ...i.b]);
  assert.ok(corners.every((v) => Math.abs(v / 20 - Math.round(v / 20)) < 1e-9), "every corner is on the 20 unit grid: " + corners);
  assert.equal(saved[0].b[0], saved[1].a[0], "the right edge of the first is the left edge of the second");
  assert.equal(saved[0].a[1], saved[1].a[1], "and their tops match");

  await page.click("#openSettings");
  const box = page.locator('#settings label:has-text("Snap shapes to a grid") input');
  assert.equal(await box.isChecked(), true, "on by default");
  await box.uncheck();
  await page.keyboard.press("Escape");
  await page.waitForSelector("#settings", { state: "hidden" });
  await dragPath(page, [[43, 343], [141, 421]]);
  await waitSaved(page);
  saved = await items(page);
  assert.ok(saved[2].a.some((v) => Math.abs(v / 20 - Math.round(v / 20)) > 0.01), "off: the corner is where the pointer was");
  const kept = await page.evaluate(() => JSON.parse(window.__mock.getSettings() || "{}").snapShapes);
  assert.equal(kept, false, "the choice is saved");
}, ctxOpts);

await test("moving a selection with the loop tool snaps shapes and notes to the grid, and pen lines follow by the same amount", async (page) => {
  await canvasVault(page);
  await openCanvas(page);
  await tool(page, "Rectangle");
  await dragPath(page, [[60, 80], [160, 160]]);
  await tool(page, "Pen");
  await drawLine(page, [70, 200], [150, 200]);
  await waitSaved(page);
  const before = await items(page);
  const rect0 = before[0];
  const pen0 = before[1].points[0];
  await tool(page, "Select with a loop");
  await dragPath(page, [[30, 50], [200, 50], [200, 230], [30, 230], [30, 52]], 3);
  // An awkward distance on purpose: not a multiple of the grid.
  await dragPath(page, [[100, 100], [111, 118], [137, 152]], 3);
  await waitSaved(page);
  const after = await items(page);
  const onGrid = (v) => Math.abs(v / 20 - Math.round(v / 20)) < 1e-6;
  assert.ok(onGrid(after[0].a[0]) && onGrid(after[0].a[1]), "the corner that was grabbed is on the grid: " + after[0].a);
  assert.ok(onGrid(after[0].b[0]) && onGrid(after[0].b[1]), "so is the other corner: " + after[0].b);
  const moved = [after[0].a[0] - rect0.a[0], after[0].a[1] - rect0.a[1]];
  assert.ok(moved[0] > 0 && moved[1] > 0, "it did move");
  assert.ok(Math.abs(after[0].b[0] - after[0].a[0] - (rect0.b[0] - rect0.a[0])) < 0.2, "the rectangle kept its size");
  const pen1 = after[1].points[0];
  assert.ok(Math.abs(pen1[0] - pen0[0] - moved[0]) < 0.2 && Math.abs(pen1[1] - pen0[1] - moved[1]) < 0.2, "the pen line moved the same amount");
  await tool(page, "Undo");
  await waitSaved(page);
  const undone = (await items(page))[0];
  assert.deepEqual(undone.a, rect0.a, "undo puts the rectangle back where it was");
}, ctxOpts);

// The colours down a column (or along a row) of the sheet as it is shown, to see where the paper
// lines run. `at` is in screen pixels from the corner of the sheet. Returns the pixels, the
// positions (in screen pixels) of every line that differs from the page colour, and the page colour.
async function sheetProfile(page, direction, at) {
  const profile = await page.evaluate(([dir, position]) => {
    const canvas = document.querySelector(".canvas-surface");
    const ratio = canvas.width / canvas.getBoundingClientRect().width;
    const column = dir === "column";
    const length = column ? canvas.height : canvas.width;
    const data = canvas.getContext("2d").getImageData(column ? Math.round(position * ratio) : 0, column ? 0 : Math.round(position * ratio), column ? 1 : length, column ? length : 1).data;
    const pixels = [];
    for (let i = 0; i < length; i++) pixels.push([data[i * 4], data[i * 4 + 1], data[i * 4 + 2]]);
    return { ratio, pixels };
  }, [direction, at]);
  const counts = new Map();
  for (const pixel of profile.pixels) counts.set(pixel.join(), (counts.get(pixel.join()) || 0) + 1);
  const page_ = [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0].split(",").map(Number);
  const differs = (pixel) => Math.abs(pixel[0] - page_[0]) + Math.abs(pixel[1] - page_[1]) + Math.abs(pixel[2] - page_[2]) > 12;
  const lines = [];
  let start = -1;
  profile.pixels.forEach((pixel, i) => {
    if (differs(pixel) && start === -1) start = i;
    if (!differs(pixel) && start !== -1) { lines.push((start + i - 1) / 2 / profile.ratio); start = -1; }
  });
  return { ...profile, lines, page: page_ };
}
const gaps = (lines) => lines.slice(1).map((v, i) => Math.round(v - lines[i]));
const themeBackground = (page) => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--bg").trim());
const closeTo = (a, b, tolerance = 3) => a.every((v, i) => Math.abs(v - b[i]) <= tolerance);
const rgbOf = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));

await test("the paper menu has none, four rule lines and four grids; a choice is drawn, saved with the drawing, kept on reopening and undone", async (page) => {
  await canvasVault(page);
  await openCanvas(page);
  await page.click('.canvas-toolbar [data-menu="paper"]');
  const labels = await page.locator('.canvas-menu[data-menu="paper"] button').evaluateAll((nodes) => nodes.map((n) => n.getAttribute("aria-label")));
  assert.deepEqual(labels, [
    "No lines", "Rule lines, closest together", "Rule lines, close", "Rule lines, wide", "Rule lines, widest",
    "Grid, smallest squares", "Grid, small squares", "Grid, large squares", "Grid, largest squares",
  ]);
  assert.equal(await page.locator('.canvas-menu[data-menu="paper"] button[aria-pressed="true"]').getAttribute("aria-label"), "No lines");
  assert.equal((await sheetProfile(page, "column", 300)).lines.length, 0, "a new drawing has plain paper");

  await menuPick(page, "paper", "Rule lines, wide");
  await waitSaved(page);
  const saved = await savedDrawing(page);
  assert.equal(saved.format, 3);
  assert.equal(saved.paper, "rule-3");
  assert.equal(await page.locator('.canvas-menu[data-menu="paper"]').isVisible(), false, "the menu closes after a choice");
  const column = await sheetProfile(page, "column", 300);
  assert.ok(column.lines.length > 4, "lines are drawn");
  assert.ok(gaps(column.lines).every((g) => g === 60), "60 units apart: " + gaps(column.lines));
  const margin = await sheetProfile(page, "row", 200);
  assert.equal(margin.lines.length, 1, "one margin line across a row");
  const [r, , b] = margin.pixels[Math.round(margin.lines[0] * margin.ratio)];
  assert.ok(r > b + 40, "and it is red");
  assert.equal(Math.round(margin.lines[0]), 84, "60 units from the left edge, with the sheet starting 24 in");

  await menuPick(page, "paper", "Grid, large squares");
  await waitSaved(page);
  assert.equal((await savedDrawing(page)).paper, "grid-3");
  const across = await sheetProfile(page, "row", 54);
  assert.ok(across.lines.length > 4 && gaps(across.lines).every((g) => g === 60), "vertical lines too: " + gaps(across.lines));
  assert.ok(!across.pixels.some(([red, , blue]) => red > blue + 40), "and no margin line on a grid");

  await page.click("#canvasToggle");
  await openCanvas(page);
  assert.equal(await page.locator('.canvas-menu[data-menu="paper"] button[aria-pressed="true"]').getAttribute("aria-label"), "Grid, large squares", "kept on reopening");
  await page.waitForTimeout(200); // the sheet is drawn on the next frame after reopening
  assert.ok((await sheetProfile(page, "column", 300)).lines.length > 4);

  // Reopening starts a new undo list, so the next steps are made after it.
  await menuPick(page, "paper", "Rule lines, close");
  await waitSaved(page);
  assert.equal((await savedDrawing(page)).paper, "rule-2");
  await tool(page, "Undo");
  await waitSaved(page);
  assert.equal((await savedDrawing(page)).paper, "grid-3", "undo brings back the grid");
  await tool(page, "Redo");
  await waitSaved(page);
  assert.equal((await savedDrawing(page)).paper, "rule-2");
  await menuPick(page, "paper", "No lines");
  await waitSaved(page);
  assert.equal((await savedDrawing(page)).paper, undefined, "no lines: nothing stored");
  assert.equal((await savedDrawing(page)).format, 1, "and a drawing without lines is the old format again");
}, ctxOpts);

await test("a page colour is tinted for the theme, saved with the drawing, shown on its button and undone; No colour goes back to the theme", async (page) => {
  await canvasVault(page, '{"format":2,"items":[{"tool":"pen","color":"red","width":4,"points":[[40,40,0.5],[80,60,0.5]]}]}');
  await openCanvas(page);
  const bg = await themeBackground(page);
  assert.ok(closeTo((await sheetProfile(page, "column", 400)).page, rgbOf(bg), 1), "no page colour: the theme's own");
  await page.click('.canvas-toolbar [data-menu="page"]');
  assert.equal(await page.locator('.canvas-menu[data-menu="page"] button.canvas-page').count(), 16);
  await menuPick(page, "page", "Light blue");
  await waitSaved(page);
  const saved = await savedDrawing(page);
  assert.equal(saved.format, 3);
  assert.equal(saved.page, "sky");
  assert.equal(saved.items.length, 1, "an older drawing keeps what it had");
  assert.ok(closeTo((await sheetProfile(page, "column", 400)).page, rgbOf(pageFill("sky", bg)), 1), "the sheet is that colour on this theme");
  const shown = await page.locator('.canvas-toolbar [data-menu="page"] .canvas-page-swatch').evaluate((n) => getComputedStyle(n).backgroundColor);
  assert.equal(shown, `rgb(${rgbOf(pageFill("sky", bg)).join(", ")})`, "the button shows it");
  assert.equal(await page.locator('.canvas-menu[data-menu="page"] button[aria-pressed="true"]').getAttribute("aria-label"), "Light blue");

  await menuPick(page, "page", "No colour");
  await waitSaved(page);
  assert.equal((await savedDrawing(page)).page, undefined);
  assert.equal((await savedDrawing(page)).format, 1, "a pen-only drawing with no colour is the old format again, as before 0.4.5");
  await tool(page, "Undo");
  await waitSaved(page);
  assert.equal((await savedDrawing(page)).page, "sky", "undo brings the colour back");
}, ctxOpts);

for (const [theme, dark] of [["midnight", true], ["sepia", false], ["forest", true], ["lavender", false]]) {
  await test(`the same page colour looks right on the ${theme} theme`, async (page) => {
    await canvasVault(page, '{"format":3,"items":[],"page":"mint","paper":"rule-2"}');
    await openCanvas(page);
    const bg = await themeBackground(page);
    const sheet = await sheetProfile(page, "column", 400);
    assert.ok(closeTo(sheet.page, rgbOf(pageFill("mint", bg)), 1), `${theme}: ${sheet.page} vs ${pageFill("mint", bg)}`);
    const brightness = (sheet.page[0] + sheet.page[1] + sheet.page[2]) / 3;
    assert.equal(brightness > 128, !dark, `${theme} stays ${dark ? "dark" : "light"}`);
    assert.ok(sheet.lines.length > 4, "the lines show on a tinted page");
  }, { settings: existingUser({ updates: false, theme }) });
}

await test("on a drawing that cannot be changed the paper and page colour cannot be changed either, and rapid clicking breaks nothing", async (page) => {
  await canvasVault(page, '{"format":1,"strokes":[{"tool":"laser"}]}');
  await openCanvas(page);
  assert.equal(await page.locator('.canvas-toolbar [data-menu="paper"]').isDisabled(), true);
  assert.equal(await page.locator('.canvas-toolbar [data-menu="page"]').isDisabled(), true);
  assert.equal(await page.evaluate(() => window.__mock.canvases.get("Sketch.md")), '{"format":1,"strokes":[{"tool":"laser"}]}', "the file is untouched");
}, ctxOpts);

await test("clicking the paper and page colour choices very fast, zooming far out and in, and an empty drawing all stay calm", async (page) => {
  await canvasVault(page);
  await openCanvas(page);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  for (let round = 0; round < 3; round++) {
    for (const label of ["Rule lines, closest together", "Grid, smallest squares", "Rule lines, widest", "No lines"]) await menuPick(page, "paper", label);
    for (const label of ["Light blue", "Peach", "No colour", "Mint"]) await menuPick(page, "page", label);
  }
  await menuPick(page, "paper", "Grid, smallest squares");
  const box = await sheetBox(page);
  await page.mouse.move(box.x + 300, box.y + 200);
  await page.keyboard.down("Control");
  for (let i = 0; i < 25; i++) await page.mouse.wheel(0, 400); // zoom far out: the lines would be a smear, so they are left out
  await page.waitForTimeout(100);
  assert.equal((await sheetProfile(page, "column", 300)).lines.length, 0, "no lines when they would be closer than a few pixels");
  for (let i = 0; i < 40; i++) await page.mouse.wheel(0, -400);
  await page.keyboard.up("Control");
  await page.waitForTimeout(100);
  await waitSaved(page);
  assert.equal((await savedDrawing(page)).paper, "grid-1");
  assert.equal((await savedDrawing(page)).page, "mint");
  assert.deepEqual(errors, []);
}, ctxOpts);

// Is there ink at this spot of the sheet? Read from the pixels the canvas really shows.
const inkAt = (page, x, y) => page.evaluate(([px, py]) => {
  const canvas = document.querySelector(".canvas-surface");
  const ratio = canvas.width / canvas.getBoundingClientRect().width;
  const [r, g, b, a] = canvas.getContext("2d").getImageData(Math.round(px * ratio), Math.round(py * ratio), 1, 1).data;
  return a > 0 && r + g + b < 600;
}, [x, y]);

await test("pinching zooms around the middle of the two fingers, in and out, without the drawing drifting", async (page) => {
  await canvasVault(page);
  await openCanvas(page);
  await chooseWidth(page, 4);
  // A short thick mark right under where the fingers will be.
  await drawLine(page, [236, 200], [264, 200]);
  assert.equal(await inkAt(page, 250, 200), true, "the mark is drawn");
  const pinch = async (from, to) => {
    await touchEvents(page, 21, "pointerdown", 250 - from, 200);
    await touchEvents(page, 22, "pointerdown", 250 + from, 200);
    for (let step = 1; step <= 12; step++) {
      const half = from + ((to - from) * step) / 12;
      await touchEvents(page, 21, "pointermove", 250 - half, 200);
      await touchEvents(page, 22, "pointermove", 250 + half, 200);
    }
    await touchEvents(page, 21, "pointerup", 250 - to, 200);
    await touchEvents(page, 22, "pointerup", 250 + to, 200);
  };
  await pinch(40, 120); // fingers apart: zoom in
  assert.equal(await inkAt(page, 250, 200), true, "after zooming in, the mark is still under the middle of the fingers");
  await pinch(120, 30); // fingers together: zoom out
  assert.equal(await inkAt(page, 250, 200), true, "after zooming out, too");
}, ctxOpts);

await test("the shape menu opens under its button, shows the shape used last, and closes by choosing, Escape or a press elsewhere", async (page) => {
  await canvasVault(page);
  await openCanvas(page);
  const panel = page.locator('.canvas-menu[data-menu="shape"]');
  assert.equal(await panel.isHidden(), true, "closed to begin with");
  await page.click('.canvas-toolbar [data-menu="shape"]');
  assert.equal(await panel.isVisible(), true);
  assert.equal(await page.getAttribute('.canvas-toolbar [data-menu="shape"]', "aria-expanded"), "true");
  const buttonBox = await page.locator('.canvas-toolbar [data-menu="shape"]').boundingBox();
  const panelBox = await panel.boundingBox();
  assert.ok(panelBox.y >= buttonBox.y + buttonBox.height - 1, "under the button");
  assert.deepEqual(await panel.locator("button").evaluateAll((n) => n.map((b) => b.getAttribute("aria-label"))), ["Line", "Arrow", "Rectangle", "Ellipse"]);
  await panel.locator('button[aria-label="Ellipse"]').click();
  assert.equal(await panel.isHidden(), true, "choosing closes it");
  assert.equal(await page.getAttribute('.canvas-toolbar [data-menu="shape"]', "aria-pressed"), "true", "the shape tool is on");
  await drawLine(page, [60, 80], [200, 160]);
  await waitSaved(page);
  assert.equal((await items(page))[0].kind, "ellipse");
  await page.click('.canvas-toolbar button[aria-label="Pen"]');
  assert.equal(await page.getAttribute('.canvas-toolbar [data-menu="shape"]', "aria-pressed"), "false");
  await page.click('.canvas-toolbar [data-menu="shape"]');
  assert.equal(await page.getAttribute('.canvas-menu button[data-tool="ellipse"]', "aria-pressed"), "true", "opening it switches to the shape used last");
  await page.keyboard.press("Escape");
  assert.equal(await panel.isHidden(), true, "Escape");
  await page.click('.canvas-toolbar [data-menu="shape"]');
  const box = await sheetBox(page);
  await page.mouse.click(box.x + 300, box.y + 300);
  assert.equal(await panel.isHidden(), true, "a press on the sheet");
  await page.click('.canvas-toolbar [data-menu="shape"]');
  await page.click('.canvas-toolbar [data-menu="shape"]');
  assert.equal(await panel.isHidden(), true, "the button again");
}, ctxOpts);

await test("the line width is a slider with five stops that stays open while it is moved", async (page) => {
  await canvasVault(page);
  await openCanvas(page);
  const slider = page.locator('.canvas-menu[data-menu="width"] input[type=range]');
  await page.click('.canvas-toolbar [data-menu="width"]');
  assert.deepEqual(await slider.evaluate((el) => [el.min, el.max, el.step, el.value]), ["0", "4", "1", "1"], "five stops, the medium line to start with");
  assert.equal(await slider.getAttribute("aria-label"), "Line width");
  const widths = [];
  for (let stop = 0; stop < 5; stop++) {
    if (!(await slider.isVisible())) await page.click('.canvas-toolbar [data-menu="width"]'); // drawing closes the menu
    await slider.fill(String(stop));
    assert.equal(await page.locator('.canvas-menu[data-menu="width"]').isVisible(), true, "the menu stays open while the slider moves");
    assert.equal(await page.locator('.canvas-menu[data-menu="width"] .canvas-line').getAttribute("data-size"), String(stop), "the line under the slider follows it");
    assert.equal(await page.locator('.canvas-toolbar [data-menu="width"] .canvas-line').getAttribute("data-size"), String(stop), "so does the toolbar button");
    await drawLine(page, [60, 40 + stop * 30], [260, 40 + stop * 30]);
    await waitSaved(page);
    widths.push((await items(page)).at(-1).width);
  }
  assert.deepEqual(widths, [2, 4, 6, 8, 12]);
  // The keyboard works too: an arrow key moves one stop.
  await page.click('.canvas-toolbar [data-menu="width"]');
  await slider.focus();
  await page.keyboard.press("ArrowLeft");
  assert.equal(await slider.inputValue(), "3");
  // Moving the slider with the eraser chosen goes back to the pen, as choosing a colour does.
  await page.click('.canvas-toolbar button[aria-label="Eraser"]');
  await page.click('.canvas-toolbar [data-menu="width"]');
  await slider.fill("2");
  assert.equal(await page.getAttribute('.canvas-toolbar button[aria-label="Pen"]', "aria-pressed"), "true");
  assert.equal(await page.locator('.canvas-menu[data-menu="width"]').isVisible(), true);
}, ctxOpts);

await test("a drawing made with an older width shows the nearest stop", async (page) => {
  await canvasVault(page, '{"format":1,"strokes":[{"tool":"pen","color":"ink","width":5,"points":[[1,1,0.5],[40,40,0.5]]}]}');
  await openCanvas(page);
  await page.click('.canvas-toolbar [data-menu="width"]');
  assert.equal(await page.locator('.canvas-menu[data-menu="width"] input[type=range]').inputValue(), "1", "the chosen stop starts at the medium line, and the old stroke is left alone");
  assert.equal((await items(page))[0].width, 5);
}, ctxOpts);

await test("the colour and line width menus show what is chosen and change it", async (page) => {
  await canvasVault(page);
  await openCanvas(page);
  const colour = '.canvas-toolbar [data-menu="colour"]';
  const width = '.canvas-toolbar [data-menu="width"]';
  assert.equal(await page.locator(`${colour} .canvas-swatch`).getAttribute("class"), "canvas-swatch pen-ink");
  await chooseColour(page, "purple");
  assert.equal(await page.locator(`${colour} .canvas-swatch`).getAttribute("class"), "canvas-swatch pen-purple");
  assert.equal(await page.locator(`${width} .canvas-line`).getAttribute("data-size"), "1");
  await chooseWidth(page, 0);
  assert.equal(await page.locator(`${width} .canvas-line`).getAttribute("data-size"), "0");
  await drawLine(page, [60, 80], [260, 80]);
  await waitSaved(page);
  const stroke = (await items(page))[0];
  assert.equal(stroke.color, "purple");
  assert.equal(stroke.width, 2);
  // Opening a colour menu does not change the tool; choosing a colour with the eraser goes back to the pen.
  await page.click('.canvas-toolbar button[aria-label="Eraser"]');
  await page.click(colour);
  assert.equal(await page.getAttribute('.canvas-toolbar button[aria-label="Eraser"]', "aria-pressed"), "true");
  await page.locator('.canvas-menu[data-menu="colour"] .canvas-colour[data-colour="red"]').click();
  assert.equal(await page.getAttribute('.canvas-toolbar button[aria-label="Pen"]', "aria-pressed"), "true");
}, ctxOpts);

await test("the more menu holds Finger draws, which stays open to show its state, and Show all, which closes it", async (page) => {
  await canvasVault(page);
  await openCanvas(page);
  await page.click('.canvas-toolbar [data-menu="more"]');
  const finger = page.locator('.canvas-menu[data-menu="more"] button', { hasText: "Finger draws" });
  assert.equal(await finger.getAttribute("aria-pressed"), "false");
  await finger.click();
  assert.equal(await finger.getAttribute("aria-pressed"), "true");
  assert.equal(await page.locator('.canvas-menu[data-menu="more"]').isVisible(), true, "stays open");
  await page.locator('.canvas-menu[data-menu="more"] button', { hasText: "Show all" }).click();
  assert.equal(await page.locator('.canvas-menu[data-menu="more"]').isHidden(), true);
  assert.equal(await page.locator('.canvas-toolbar [data-menu="more"]').getAttribute("aria-expanded"), "false");
}, ctxOpts);

await test("every drawing menu stays inside the window on a phone, and a drawing that cannot be read still opens the more menu", async (page) => {
  await canvasVault(page, '{"format":1,"strokes":[{"tool":"nope"}]}');
  await page.evaluate(() => document.body.classList.remove("sidebar-open"));
  await openCanvas(page);
  const window_ = page.viewportSize();
  for (const name of ["more"]) {
    await page.click(`.canvas-toolbar [data-menu="${name}"]`);
    const box = await page.locator(`.canvas-menu[data-menu="${name}"]`).boundingBox();
    assert.ok(box.x >= 0 && box.x + box.width <= window_.width, `${name} fits sideways`);
    await page.keyboard.press("Escape");
  }
  for (const name of ["shape", "colour", "width"]) assert.equal(await page.locator(`.canvas-toolbar [data-menu="${name}"]`).isDisabled(), true, `${name} is off for a drawing that is read-only`);
}, { viewport: { width: 390, height: 800 }, settings: existingUser({ updates: false }) });

await test("on a phone the shape, colour and width menus are inside the window", async (page) => {
  await canvasVault(page);
  await page.evaluate(() => document.body.classList.remove("sidebar-open"));
  await openCanvas(page);
  const window_ = page.viewportSize();
  for (const name of ["shape", "colour", "width", "more"]) {
    await page.click(`.canvas-toolbar [data-menu="${name}"]`);
    const box = await page.locator(`.canvas-menu[data-menu="${name}"]`).boundingBox();
    assert.ok(box.x >= 0 && box.x + box.width <= window_.width && box.y + box.height <= window_.height, `${name} fits`);
    await page.keyboard.press("Escape");
  }
}, { viewport: { width: 390, height: 800 }, settings: existingUser({ updates: false }) });

await test("Settings, Tags and Trash are buttons like New page and New folder: icon and label on one line, label hidden when the list is narrow", async (page) => {
  await page.waitForSelector("#openSettings");
  const names = ["openSettings", "openTags", "openTrash"];
  const boxes = [];
  for (const id of names) {
    const button = page.locator(`#${id}`);
    assert.equal(await button.locator("svg.icon").count(), 1, `${id} has an icon`);
    assert.equal(await button.locator(".btn-label").isVisible(), true, `${id} shows its label in a wide list`);
    assert.notEqual(await button.evaluate((n) => getComputedStyle(n).borderTopStyle), "none", `${id} has the same outline as New page`);
    boxes.push(await button.boundingBox());
  }
  const sidebarBox = await page.locator("#sidebar").boundingBox();
  assert.ok(boxes.every((b) => b.x >= sidebarBox.x && b.x + b.width <= sidebarBox.x + sidebarBox.width), "all three fit in the list");
  assert.ok(boxes.every((b) => Math.abs(b.y - boxes[0].y) < 2), "on one line");
  const newPage = await page.locator("#newNote").boundingBox();
  assert.ok(Math.abs(newPage.height - boxes[0].height) < 2, "the same height as New page");
  // Narrow the list: the label goes, the icon and the accessible name stay.
  const narrow = await page.evaluate(() => { const s = document.querySelector("#sidebar"); s.style.width = "15rem"; return s.getBoundingClientRect().width; });
  assert.ok(narrow < 260);
  for (const id of names) {
    // The label is clipped to a single pixel (so it stays a screen reader's name), not removed.
    assert.ok((await page.locator(`#${id} .btn-label`).boundingBox()).width <= 1, `${id} label is hidden`);
    assert.ok((await page.getAttribute(`#${id}`, "aria-label")).length > 2, `${id} keeps its name`);
    assert.equal(await page.locator(`#${id} svg.icon`).isVisible(), true);
  }
});

// ---------- 0.4.3: the page id is never shown while using the app ----------

const ID = "0b9c7e52-3f1a-4d6e-9a58-2c7d41e6b0aa";
async function idVault(page, files) {
  await page.waitForSelector("#newNote");
  await page.evaluate((list) => {
    for (const [name, text] of Object.entries(list)) window.__mock.files.set(name, text);
  }, files);
  await page.click("#newFolder");
  await page.waitForSelector(`.tree-button[data-path="Home.md"]`);
}

const idPages = (extra = "") => ({
  "Home.md": "Go to [[Plan]]\n",
  "Plan.md": `---\nid: ${ID}\n${extra}---\n\n# Plan\n\nSome [[Home]] text\n`,
});
const idOptions = { settings: existingUser({ updates: false }) };

await test("following a link never shows the page id, even for a file that starts with a byte-order mark", async (page) => {
  await idVault(page, { ...idPages(), "Marked.md": `\uFEFF---\nid: ${ID}\n---\n\n# Marked\n\nSee [[Home]]\n`, "Odd.md": `---\nid: ${ID}\n---\n\n# Odd\n\n::: weird\n\nSee [[Home]]\n` });
  for (const name of ["Plan", "Marked", "Odd"]) {
    await openLinked(page, "Home.md");
    await page.evaluate((n) => window.__mock.files.set("Home.md", `Go to [[${n}]]\n`), name);
    await openLinked(page, "Plan.md");
    await openLinked(page, "Home.md");
    await page.click(`.note-body .wikilink:text-is("${name}")`);
    await page.waitForFunction((n) => document.querySelector("#title").value === n, name);
    const shown = await page.locator("#editor").innerText();
    assert.ok(!shown.includes(ID) && !/\bid:/.test(shown), `${name}: the id is not on the page: ${shown}`);
  }
}, idOptions);

await test("the plain markdown view hides the id, keeps it when saving, and changes nothing else", async (page) => {
  await idVault(page, idPages("tags: [a]\n"));
  await openLinked(page, "Plan.md");
  await page.click("#sourceToggle");
  const box = page.locator("#source");
  const shown = await box.inputValue();
  assert.ok(!shown.includes(ID) && !/^id:/m.test(shown), "no id in the box: " + shown);
  assert.match(shown, /tags: \[a\]/, "other properties are still there");
  await box.click();
  await page.keyboard.press("Control+End");
  await page.keyboard.type("more");
  await waitSaved(page);
  const saved = await page.evaluate(() => window.__mock.files.get("Plan.md"));
  assert.equal(saved, `---\nid: ${ID}\ntags: [a]\n---\n\n# Plan\n\nSome [[Home]] text\nmore`, "the id is still in the file, in its place");
  await page.click("#sourceToggle");
  assert.ok(!(await page.locator("#editor").innerText()).includes(ID));
}, idOptions);

await test("an empty page with an id shows an empty page, not a kept-as-written block, and typing keeps the id", async (page) => {
  await idVault(page, { ...idPages(), "Empty.md": `---\nid: ${ID}\n---\n\n` });
  await openLinked(page, "Empty.md");
  assert.equal(await page.locator(".raw-block").count(), 0, "no kept-as-written block");
  assert.equal(await page.evaluate(() => window.__mock.files.get("Empty.md")), `---\nid: ${ID}\n---\n\n`, "just looking changes nothing");
  await page.click("#editor .ProseMirror");
  await page.keyboard.type("hello");
  await waitSaved(page);
  assert.equal(await page.evaluate(() => window.__mock.files.get("Empty.md")), `---\nid: ${ID}\n---\n\nhello\n`);
}, idOptions);

await test("a note that holds only an id shows an empty plain markdown view and still saves the id", async (page) => {
  await idVault(page, { ...idPages(), "Only.md": `---\nid: ${ID}\n---\n\nHello\n` });
  await openLinked(page, "Only.md");
  await page.click("#sourceToggle");
  assert.equal(await page.locator("#source").inputValue(), "Hello\n");
  await page.click("#sourceToggle");
  await page.click("#sourceToggle");
  assert.equal(await page.evaluate(() => window.__mock.files.get("Only.md")), `---\nid: ${ID}\n---\n\nHello\n`, "just looking changes nothing");
}, idOptions);

// Screenshots of the screens added in 0.4.0 (only when SHOTS_DIR is set), in light and dark.
if (shots && !process.env.SHOTS_ONLY) {
  for (const scheme of ["light", "dark"]) {
    for (const [label, viewport] of [["desktop", { width: 1100, height: 760 }], ["phone", { width: 390, height: 800 }]]) {
      const context = await browser.newContext({ viewport, colorScheme: scheme });
      await context.addInitScript((text) => { window.__seedSettings = text; }, JSON.stringify({ vaultPath: "/vault", disclosureAccepted: true, lastSeenVersion: VERSION, updates: false }));
      await context.addInitScript({ path: path.join(here, "mock-backend.js") });
      const page = await context.newPage();
      await page.route("https://**/*", (route) => (route.request().url() === GITHUB ? route.fulfill({ status: 200, contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: "[]" }) : route.abort()));
      const name = (n) => `${shots}/v040-${label}-${scheme}-${n}.png`;
      await page.goto(url);
      await canvasVault(page);
      if (label === "phone") await page.evaluate(() => document.body.classList.remove("sidebar-open"));
      await page.screenshot({ path: name("1-page-with-canvas-button") });
      await openCanvas(page);
      await page.screenshot({ path: name("2-empty-canvas") });
      const curve = (cx, cy, r, from, to) => Array.from({ length: 40 }, (_, i) => { const a = from + ((to - from) * i) / 39; return [cx + r * Math.cos(a), cy + r * Math.sin(a), 0.2 + 0.8 * Math.sin((i / 39) * Math.PI)]; });
      await penStroke(page, curve(120, 150, 70, 0, 6.2));
      await chooseColour(page, "red");
      await penStroke(page, curve(280, 150, 70, 3.4, 9));
      await chooseColour(page, "blue");
      await chooseWidth(page, 3);
      await penStroke(page, [[40, 280, 0.6], [140, 300, 0.6], [240, 270, 0.6], [330, 300, 0.6]]);
      await page.waitForTimeout(300);
      await page.screenshot({ path: name("3-canvas-with-strokes") });
      await page.click('.canvas-toolbar button[aria-label="Eraser"]');
      await page.screenshot({ path: name("4-eraser-selected") });
      await context.close();
    }
  }
}

// Screenshots of the screens added in 0.4.1 (only when SHOTS_DIR is set), in light and dark.
if (shots && !process.env.SHOTS_ONLY) {
  for (const scheme of ["light", "dark"]) {
    for (const [label, viewport] of [["desktop", { width: 1100, height: 760 }], ["phone", { width: 390, height: 800 }]]) {
      const context = await browser.newContext({ viewport, colorScheme: scheme });
      await context.addInitScript((text) => { window.__seedSettings = text; }, JSON.stringify({ vaultPath: "/vault", disclosureAccepted: true, lastSeenVersion: VERSION, updates: false }));
      await context.addInitScript({ path: path.join(here, "mock-backend.js") });
      const page = await context.newPage();
      await page.route("https://**/*", (route) => (route.request().url() === GITHUB ? route.fulfill({ status: 200, contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: "[]" }) : route.abort()));
      const name = (n) => `${shots}/v041-${label}-${scheme}-${n}.png`;
      await page.goto(url);
      await canvasVault(page);
      if (label === "phone") await page.evaluate(() => document.body.classList.remove("sidebar-open"));
      await openCanvas(page);
      await page.screenshot({ path: name("1-toolbar") });
      await penStroke(page, [[40, 60, 0.4], [120, 40, 0.8], [200, 70, 0.5], [300, 50, 0.6]]);
      await tool(page, "Highlighter");
      await chooseColour(page, "orange");
      await dragPath(page, [[30, 120], [330, 125]]);
      await tool(page, "Rectangle");
      await chooseColour(page, "blue");
      await dragPath(page, [[40, 170], [160, 250]]);
      await tool(page, "Ellipse");
      await dragPath(page, [[190, 170], [330, 250]]);
      await tool(page, "Arrow");
      await chooseColour(page, "red");
      await dragPath(page, [[100, 330], [250, 280]]);
      await chooseColour(page, "green");
      await dragNote(page, [40, 360], [300, 440]);
      await page.keyboard.type("Ask about the exam: which chapters, and is the codon table given?");
      await page.screenshot({ path: name("2-typing-a-note") });
      await page.keyboard.press("Control+Enter");
      await page.waitForTimeout(300);
      await page.screenshot({ path: name("3-all-kinds") });
      await tool(page, "Select with a loop");
      await dragPath(page, [[20, 150], [345, 150], [345, 265], [20, 265], [20, 152]], 3);
      await page.waitForTimeout(200);
      await page.screenshot({ path: name("4-selection") });
      // On a phone the settings button is in the sidebar, which was closed to give the sheet room.
      await page.evaluate(() => document.body.classList.add("sidebar-open"));
      await page.click("#openSettings");
      await page.waitForSelector('select[aria-label="Pen button"]');
      await page.screenshot({ path: name("5-settings-pen-button") });
      await context.close();
    }
  }
}

// Screenshots of the screens changed in 0.4.2 (only when SHOTS_DIR is set), in light and dark.
if (shots && !process.env.SHOTS_ONLY) {
  for (const scheme of ["light", "dark"]) {
    for (const [label, viewport] of [["desktop", { width: 1100, height: 760 }], ["tablet", { width: 810, height: 1180 }], ["phone", { width: 390, height: 800 }]]) {
      const context = await browser.newContext({ viewport, colorScheme: scheme });
      await context.addInitScript((text) => { window.__seedSettings = text; }, JSON.stringify({ vaultPath: "/vault", disclosureAccepted: true, lastSeenVersion: VERSION, updates: false }));
      await context.addInitScript({ path: path.join(here, "mock-backend.js") });
      const page = await context.newPage();
      await page.route("https://**/*", (route) => (route.request().url() === GITHUB ? route.fulfill({ status: 200, contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: "[]" }) : route.abort()));
      const name = (n) => `${shots}/v042-${label}-${scheme}-${n}.png`;
      await page.goto(url);
      await canvasVault(page);
      if (label === "phone") {
        await page.screenshot({ path: name("0-page-with-list-closed") });
        await page.evaluate(() => document.body.classList.add("sidebar-open"));
        await page.waitForTimeout(300);
        await page.screenshot({ path: name("1-sidebar-foot") });
        await page.evaluate(() => document.body.classList.remove("sidebar-open"));
      } else {
        await page.screenshot({ path: name("1-sidebar-foot") });
      }
      await openCanvas(page);
      await drawLine(page, [40, 60], [220, 100]);
      await page.screenshot({ path: name("2-toolbar") });
      await page.click('.canvas-toolbar [data-menu="shape"]');
      await page.screenshot({ path: name("3-shape-menu") });
      await page.keyboard.press("Escape");
      await page.click('.canvas-toolbar [data-menu="colour"]');
      await page.screenshot({ path: name("4-colour-menu") });
      await page.keyboard.press("Escape");
      await page.click('.canvas-toolbar [data-menu="more"]');
      await page.screenshot({ path: name("5-more-menu") });
      await context.close();
    }
  }
}

// Screenshots of the screens changed in 0.4.3 (only when SHOTS_DIR is set), in light and dark.
if (shots && (!process.env.SHOTS_ONLY || process.env.SHOTS_ONLY === "043")) {
  for (const scheme of ["light", "dark"]) {
    for (const [label, viewport] of [["desktop", { width: 1100, height: 760 }], ["phone", { width: 390, height: 800 }]]) {
      const context = await browser.newContext({ viewport, colorScheme: scheme });
      await context.addInitScript((text) => { window.__seedSettings = text; }, JSON.stringify({ vaultPath: "/vault", disclosureAccepted: true, lastSeenVersion: VERSION, updates: false }));
      await context.addInitScript({ path: path.join(here, "mock-backend.js") });
      const page = await context.newPage();
      await page.route("https://**/*", (route) => (route.request().url() === GITHUB ? route.fulfill({ status: 200, contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: "[]" }) : route.abort()));
      const name = (n) => `${shots}/v043-${label}-${scheme}-${n}.png`;
      await page.goto(url);
      await canvasVault(page);
      await openCanvas(page);
      await chooseWidth(page, 3);
      await drawLine(page, [40, 60], [220, 60]);
      await chooseWidth(page, 0);
      await drawLine(page, [40, 100], [220, 100]);
      await page.click('.canvas-toolbar [data-menu="width"]');
      await page.screenshot({ path: name("1-width-slider") });
      await page.click('.canvas-toolbar [data-menu="colour"]');
      await page.screenshot({ path: name("1b-colour-menu") });
      await context.close();
    }
  }
  // A page reached through a link, and its plain markdown view: no id in either.
  for (const scheme of ["light", "dark"]) {
    const context = await browser.newContext({ viewport: { width: 1100, height: 760 }, colorScheme: scheme });
    await context.addInitScript((text) => { window.__seedSettings = text; }, JSON.stringify({ vaultPath: "/vault", disclosureAccepted: true, lastSeenVersion: VERSION, updates: false }));
    await context.addInitScript({ path: path.join(here, "mock-backend.js") });
    const page = await context.newPage();
    await page.route("https://**/*", (route) => (route.request().url() === GITHUB ? route.fulfill({ status: 200, contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: "[]" }) : route.abort()));
    await page.goto(url);
    await idVault(page, idPages("tags: [a]\n"));
    await openLinked(page, "Home.md");
    await page.click('.note-body .wikilink:text-is("Plan")');
    await page.waitForFunction(() => document.querySelector("#title").value === "Plan");
    await page.screenshot({ path: `${shots}/v043-desktop-${scheme}-2-page-after-link.png` });
    await page.click("#sourceToggle");
    await page.screenshot({ path: `${shots}/v043-desktop-${scheme}-3-plain-markdown.png` });
    await context.close();
  }
}

// ---------- 0.4.5: folder icons ----------

const iconFile = (page) => page.evaluate(() => window.__mock.folderIcons.text);
const glyphColour = (page, p) => page.evaluate((path) => {
  const svg = document.querySelector(`.tree-button[data-path="${path}"] svg:nth-of-type(2)`);
  return { colour: getComputedStyle(svg).color, filled: svg.querySelector("path").getAttribute("fill"), d: svg.querySelector("path").getAttribute("d") };
}, p);
async function openIconMenuFor(page, p) {
  await rightClick(page, p);
  await page.click('.context-menu .menu-item:has-text("Icon")');
  await page.waitForSelector(".icon-menu");
}

await test("a folder starts with the plain folder icon, and a page has no Icon entry", async (page) => {
  await withFolderAndPage(page);
  assert.equal(await iconFile(page), null, "nothing is written until a choice is made");
  await rightClick(page, "Plan.md");
  assert.deepEqual(await page.locator(".context-menu .menu-item").allTextContents(), ["Rename", "Move to", "Delete"]);
}, ctxOpts);

await test("the Icon menu offers three styles and sixteen colours plus none, and a choice is saved to the hidden file", async (page) => {
  await withFolderAndPage(page);
  await openIconMenuFor(page, "Biology");
  assert.equal(await page.locator(".icon-menu [data-icon-style]").count(), 3);
  assert.equal(await page.locator(".icon-menu [data-icon-colour]").count(), 17);
  assert.deepEqual(await page.locator(".icon-menu .icon-menu-colour").evaluateAll((b) => b.map((x) => x.title)), [
    "Blue", "Yellow", "Green", "Red", "Purple", "Cyan", "Orange", "Magenta", "Blue Mist", "Purple Mist", "Tan", "Lemon Lime", "Apple", "Teal", "Red Chalk", "Silver",
  ]);
  const before = await glyphColour(page, "Biology");
  await page.click('.icon-menu [data-icon-style="notebook"]');
  await page.click('.icon-menu [data-icon-colour="blue"]');
  assert.deepEqual(JSON.parse(await iconFile(page)), { format: 1, icons: { Biology: { style: "notebook", colour: "blue" } } });
  const after = await glyphColour(page, "Biology");
  assert.notEqual(after.d, before.d, "the notebook is drawn instead of the folder");
  assert.equal(after.colour, "rgb(43, 124, 211)");
  assert.equal(await page.locator('.icon-menu [data-icon-style="notebook"]').getAttribute("aria-pressed"), "true");
  assert.equal(await page.locator('.icon-menu [data-icon-colour="blue"]').getAttribute("aria-pressed"), "true");
  assert.equal(await page.locator(".icon-menu").count(), 1, "the menu stays open for the next choice");
  await page.click('.icon-menu [data-icon-style="line"]');
  const bar = await glyphColour(page, "Biology");
  assert.equal(bar.filled, "currentColor", "the line is a solid bar");
  assert.equal(bar.d, "M6.25 3.25h3.5v9.5h-3.5z", "and not the line of the drawing tools");
  await page.keyboard.press("Escape");
  assert.equal(await page.locator(".icon-menu").count(), 0);
  assert.equal(await page.evaluate(() => document.activeElement.dataset.path), "Biology", "focus returns to the folder");
  // Notes are untouched.
  assert.equal((await files(page))["Biology/Cells.md"], "cells\n");
}, ctxOpts);

await test("choosing the plain folder with no colour removes the entry again", async (page) => {
  await withFolderAndPage(page);
  await openIconMenuFor(page, "Biology");
  await page.click('.icon-menu [data-icon-colour="red"]');
  assert.equal(JSON.parse(await iconFile(page)).icons.Biology.colour, "red");
  await page.click('.icon-menu [data-icon-colour="none"]');
  assert.deepEqual(JSON.parse(await iconFile(page)).icons, {});
}, ctxOpts);

await test("the icon is kept after the list is drawn again, and follows a renamed folder", async (page) => {
  await withFolderAndPage(page);
  await page.evaluate(() => { window.__mock.folderIcons.text = JSON.stringify({ format: 1, icons: { Biology: { style: "notebook", colour: "green" } } }); });
  await page.click("#newFolder"); // draws the list again
  await page.waitForSelector('.tree-button[data-path="Biology"]');
  assert.equal((await glyphColour(page, "Biology")).colour, "rgb(47, 158, 68)");
  await rightClick(page, "Biology");
  await page.click('.context-menu .menu-item:has-text("Rename")');
  await page.locator(".inline-rename").fill("Plants");
  await page.keyboard.press("Enter");
  await page.waitForSelector('.tree-button[data-path="Plants"]');
  assert.deepEqual(JSON.parse(await iconFile(page)).icons, { Plants: { style: "notebook", colour: "green" } });
  assert.equal((await glyphColour(page, "Plants")).colour, "rgb(47, 158, 68)");
}, ctxOpts);

await test("a damaged icon file shows plain folders, is left alone and says so when a change is tried", async (page) => {
  await withFolderAndPage(page);
  await page.evaluate(() => { window.__mock.folderIcons.text = "{ not json"; });
  await page.click("#newFolder");
  await page.waitForSelector('.tree-button[data-path="Biology"]');
  await openIconMenuFor(page, "Biology");
  await page.click('.icon-menu [data-icon-colour="red"]');
  assert.equal(await iconFile(page), "{ not json", "the file is not overwritten");
  assert.match(await page.textContent("#bannerText"), /folder icon file could not be read/);
}, ctxOpts);

await test("entries this version does not understand are kept when another folder changes", async (page) => {
  await withFolderAndPage(page);
  await page.evaluate(() => { window.__mock.folderIcons.text = JSON.stringify({ format: 1, icons: { Old: { style: "star", colour: "pink" } } }); });
  await page.click("#newFolder");
  await page.waitForSelector('.tree-button[data-path="Biology"]');
  await openIconMenuFor(page, "Biology");
  await page.click('.icon-menu [data-icon-colour="teal"]');
  assert.deepEqual(JSON.parse(await iconFile(page)).icons, { Old: { style: "star", colour: "pink" }, Biology: { style: "folder", colour: "teal" } });
}, ctxOpts);

await test("a folder called __proto__ can have an icon, and rapid clicking in the menu stays consistent", async (page) => {
  await page.waitForSelector("#newNote");
  await page.evaluate(() => { window.__mock.folders.add("__proto__"); });
  await page.click("#newFolder");
  await page.waitForSelector('.tree-button[data-path="__proto__"]');
  await openIconMenuFor(page, "__proto__");
  for (const name of ["red", "blue", "tan", "silver", "apple", "none", "magenta"]) await page.click(`.icon-menu [data-icon-colour="${name}"]`, { noWaitAfter: true });
  for (const style of ["line", "notebook", "folder", "line"]) await page.click(`.icon-menu [data-icon-style="${style}"]`, { noWaitAfter: true });
  await page.waitForFunction(() => JSON.parse(window.__mock.folderIcons.text).icons.__proto__?.style === "line");
  assert.deepEqual(Object.getOwnPropertyDescriptor(JSON.parse(await iconFile(page)).icons, "__proto__").value, { style: "line", colour: "magenta" });
}, ctxOpts);

await test("the icon menu fits a phone screen and the colours have names", async (page) => {
  await withFolderAndPage(page);
  await openIconMenuFor(page, "Biology");
  const box = await page.locator(".icon-menu").boundingBox();
  assert.ok(box.x >= 0 && box.x + box.width <= 412 && box.y >= 0 && box.y + box.height <= 860, "inside the window");
  for (const b of await page.locator(".icon-menu button").all()) assert.ok((await b.getAttribute("aria-label")) || (await b.textContent()).trim(), "every button has a name");
}, { ...ctxOpts, userAgent: ANDROID_UA, viewport: { width: 412, height: 860 }, hasTouch: true });

// Screenshots of the screens changed in 0.4.5 (only when SHOTS_DIR is set): the paper and page
// colour menus and some papers, in light and dark, on a desktop and a phone, and on other themes.
if (shots && (!process.env.SHOTS_ONLY || process.env.SHOTS_ONLY === "045")) {
  const looks = [
    ["desktop", { width: 1100, height: 760 }, "light", null], ["desktop", { width: 1100, height: 760 }, "dark", null],
    ["phone", { width: 390, height: 800 }, "light", null], ["phone", { width: 390, height: 800 }, "dark", null],
    ["sepia", { width: 1100, height: 760 }, "light", "sepia"], ["midnight", { width: 1100, height: 760 }, "dark", "midnight"],
    ["forest", { width: 1100, height: 760 }, "dark", "forest"], ["sage", { width: 1100, height: 760 }, "light", "sage"],
  ];
  for (const [label, viewport, scheme, theme] of looks) {
    const context = await browser.newContext({ viewport, colorScheme: scheme });
    await context.addInitScript((text) => { window.__seedSettings = text; }, JSON.stringify({ vaultPath: "/vault", disclosureAccepted: true, lastSeenVersion: VERSION, updates: false, ...(theme ? { theme } : {}) }));
    await context.addInitScript({ path: path.join(here, "mock-backend.js") });
    const page = await context.newPage();
    await page.route("https://**/*", (route) => (route.request().url() === GITHUB ? route.fulfill({ status: 200, contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: "[]" }) : route.abort()));
    const name = (n) => `${shots}/v045-${label}-${scheme}-${n}.png`;
    await page.goto(url);
    await canvasVault(page);
    // Folder icons: every colour in all three styles, then the Icon menu.
    await page.evaluate(() => {
      const names = ["blue", "yellow", "green", "red", "purple", "cyan", "orange", "magenta", "blueMist", "purpleMist", "tan", "lemonLime", "apple", "teal", "redChalk", "silver"];
      const styles = ["folder", "notebook", "line"];
      const icons = {};
      names.forEach((colour, i) => { const name = `${styles[i % 3]} ${colour}`; window.__mock.folders.add(name); icons[name] = { style: styles[i % 3], colour }; });
      names.slice(0, 6).forEach((colour, i) => { const name = `${styles[(i + 1) % 3]} ${colour} 2`; window.__mock.folders.add(name); icons[name] = { style: styles[(i + 1) % 3], colour }; });
      window.__mock.folderIcons.text = JSON.stringify({ format: 1, icons });
    });
    // On a phone the page list is a drawer that is closed after the vault is set up.
    if (!(await page.isVisible("#newFolder"))) await page.click("#toggle");
    await page.click("#newFolder");
    await page.waitForSelector('.tree-button[data-path="notebook yellow"]');
    await page.screenshot({ path: name("5-folder-icons") });
    await openIconMenuFor(page, "notebook yellow");
    await page.click('.icon-menu [data-icon-colour="teal"]');
    await page.screenshot({ path: name("6-icon-menu") });
    await page.keyboard.press("Escape");
    if (label === "phone") await page.evaluate(() => document.body.classList.remove("sidebar-open"));
    await openCanvas(page);
    await chooseWidth(page, 2);
    await drawLine(page, [110, 80], [300, 80]);
    await tool(page, "Rectangle");
    await dragPath(page, [[110, 130], [250, 200]]);
    await page.click('.canvas-toolbar [data-menu="paper"]');
    await page.screenshot({ path: name("1-paper-menu") });
    await menuPick(page, "paper", "Rule lines, wide");
    await menuPick(page, "page", "Light blue");
    await page.screenshot({ path: name("2-rule-lines-light-blue") });
    await page.click('.canvas-toolbar [data-menu="page"]');
    await page.screenshot({ path: name("3-page-colour-menu") });
    await menuPick(page, "paper", "Grid, large squares");
    await menuPick(page, "page", "Peach");
    await page.screenshot({ path: name("4-grid-peach") });
    await context.close();
  }
}

await browser.close();
server.close();
console.log(failures ? `${failures} test(s) FAILED` : "all browser tests passed");
process.exit(failures ? 1 : 0);
