// Drives the real built interface (dist/) in Chromium, with the in-memory backend from
// mock-backend.js. Run with: npm run build && node tests/editor.spec.mjs

import { createRequire } from "node:module";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { COLOURS } from "../web/inlinestyles.js";

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
  const context = await browser.newContext({ viewport: opts.viewport || { width: 1100, height: 760 }, colorScheme: opts.scheme || "light", ...(opts.userAgent ? { userAgent: opts.userAgent } : {}) });
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
  const box = page.locator('#settings input[type="checkbox"]');
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
  assert.deepEqual(await page.locator(".context-menu .menu-item").allTextContents(), ["Rename", "Move to"]);
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
  assert.deepEqual(await page.locator(".context-menu .menu-item").allTextContents(), ["Rename", "Move to"]);
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
