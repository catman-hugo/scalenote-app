# Security checklist, version 0.4.12

Checked by the builder by reading, searches and automatic tests. Not an outside review. Items marked "device" still need a try on a real device.

| Item | Result |
|---|---|
| A PDF is untrusted. Its type is decided by the first bytes (`%PDF-`), never by name or the browser's claim. A file named `.pdf` that is not a PDF is refused, and one already in the vault is not served | Rust tests in `core/src/attachments.rs` (fake `.pdf` with a script inside); browser test |
| PDF size limit 25 MB, checked on the encoded text before decoding, on the bytes, and on the file size before reading. Pictures keep 10 MB. The interface checks first and gives a calm message | Rust tests (`MAX_PDF_BYTES`), `tests/pdf.test.mjs` |
| Page limit: "Pages as images" refuses more than 100 pages and stores nothing. A page picture is at most 4 million pixels; the scroll view at most 8 million pixels in total | Browser test (more than 100 pages), `tests/pdf.test.mjs` |
| pdf.js 6.5.438, exact pin, Apache-2.0, loaded only when a PDF is opened. `npm audit --omit=dev` reports 0 vulnerabilities. Used only to draw pages: no scripting, no forms, no XFA (`enableXfa: false`) | Search of `web/pdfdoc.js`; `npm audit` run on 2026-11-13 |
| No code is run from a PDF. No `eval`, `new Function`, `unsafe-eval` or `wasm-unsafe-eval` anywhere in the new code or the page policy. Image decoders are shipped as plain script files (`useWasm: false`) | Search; the page policy is checked in a browser test |
| Page policy: the only change is `'self'` added to `connect-src` (pdf.js loads its own worker and fonts from the app). It is now `connect-src 'self' ipc: http://ipc.localhost https://api.github.com`. Nothing outside the app is added | Browser test reads the policy from `tauri.conf.json` |
| The PDF worker, fonts and decoders are shipped with the app. A PDF cannot make the app fetch anything from the network | By design; no network address appears in the new code |
| The PDF is stored as `attachments/<clean name>.pdf` through the existing safe-name and atomic-write path. The name cannot leave the vault, and a symlinked `attachments` folder pointing outside is refused | Rust tests |
| PDF links in notes are only read as a PDF block when they are `attachments/<name>.pdf` with no `..`; anything else stays raw text, byte for byte | `tests/pdf.test.mjs`, `tests/richblocks.test.mjs`, browser test (reopen, byte for byte) |
| Picture sizes in `![alt\|300x200](path)` are numbers with limits; anything else after `\|` stays in the description | `tests/richblocks.test.mjs` |
| Canvas file format 6 (regions): at most 200 regions, sides 40 to 4000, unique ids. Older versions open a drawing that has regions read-only. Opening a drawing writes nothing | Unit tests (`tests/canvas.test.mjs`), browser tests |
| The canvas block text is only read when it is exactly the three-line fence; anything else stays an ordinary code block. A missing or unreadable region shows a calm message | Unit tests, browser tests |
| No new network calls, no new permissions, no new Rust commands. The update check and opener scope are unchanged | Reading of the diff |
| No `unwrap()` or `expect()` in new Rust code after startup (the ones found are inside `#[cfg(test)]`) | Checked with a search |
| Secrets: none exist | n/a |
| The assistant is still off and absent from the interface | Browser test |
| New dependency: `pdfjs-dist` 6.5.438, pinned exactly. No other package changed | `package-lock.json` |
| Open risk | Not run on a device: the packaged Android and Windows apps opening a real PDF (worker loading in the webview), and a very large or very complex PDF on a phone (memory and time). The limits above bound the input but do not prove a phone copes |
