# Security checklist, version 0.4.13

Checked by the builder by reading, searches and automatic tests. Not an outside review. Items marked "device" still need a try on a real device.

| Item | Result |
|---|---|
| Page colours live in the existing `.scalenote/folder-icons.json`, format 1. The file is still untrusted: size limit, entry limit, key length limit, and colour and style are checked against fixed lists. A page path is only a key; it is never opened or run | `tests/foldericons.test.mjs`, browser tests |
| A damaged or newer icon file is left as it is and shows plain icons; a colour change is refused with a calm message. A page called `__proto__` cannot reach object prototypes | Existing browser tests, kept passing |
| A region name is a plain text label, cut to 80 characters, written through the existing canvas file path (atomic write). It is drawn with `fillText` and shown with `textContent`, never as markup. A file with a longer or non-text label is refused by the existing format check | Browser tests, `web/canvasrules.js` |
| The What's new setting and the download bar show text only (`textContent`). The download address is still checked to be an installable address before use | `tests/apkinstall.test.mjs` |
| No new network calls, no new permissions, no new Rust commands, no change to the page policy | Reading of the diff against v0.4.12 |
| No `unwrap()` or `expect()` in Rust after startup: no Rust code changed in this version | Reading of the diff |
| Secrets: none exist | n/a |
| The assistant is still off and absent from the interface | Browser test |
| Dependencies: none added or changed. `npm audit --omit=dev` reports 0 vulnerabilities | `package.json` unchanged except the version |
| Open risk | Device: the Kotlin change for the download bar is only compiled by CI and only a phone shows the real bar; the new launcher icon was only checked in renders |
