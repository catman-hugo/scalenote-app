# Security checklist, version 0.2

Checked by the builder by reading and by automatic tests. Not an outside review. Items marked "device" still need a try on a real device.

| Item | Result |
|---|---|
| Pictures: the type is decided by the file's first bytes, never by name or the browser's claim. Only png, jpg, gif and webp. SVG, html and everything else are refused | Rust tests in `core/src/attachments.rs`; browser test drops an svg and a text file |
| Pictures: 10 MiB limit, checked on the encoded text before decoding and again on the bytes | Rust tests; the interface checks the same limit first (`tests/images.test.mjs`) |
| Picture names are reduced to letters, digits, `_` and `-`. A path cannot leave the vault, and a symlinked `attachments` folder pointing outside is refused | Rust tests |
| Picture writes are atomic (temporary file, then rename). The same picture is stored once | Rust tests |
| Picture links in notes are only read as pictures when they are `attachments/<name>.png/jpg/jpeg/gif/webp` with no `..`; anything else stays a raw block | `tests/richblocks.test.mjs`, browser tests |
| Pictures are shown from `data:` addresses made by the Rust side. The page policy allows `img-src 'self' data:` only | Checked; the browser tests apply the same policy |
| Links made with the toolbar: only `http`, `https` and `mailto`. `javascript:`, `data:` and `file:` are refused | `tests/links.test.mjs` |
| Notes, callout titles, toggle titles and table cells are never put on the page as html | Checked in code (text and DOM nodes only). Browser test with `<img onerror>` and `<script>` in notes |
| Raw syntax the editor cannot hold is kept byte for byte | Property tests with random notes and random block shuffles |
| Update check: one GET to `api.github.com/repos/<project>/releases`, no body, no cookies, no referrer, no credentials, 10 second limit, 512 KiB limit, answer must be a JSON list | `tests/updates.test.mjs` and a browser test that records the request |
| Update check: release notes are untrusted. They are cut to 8000 characters and shown with `textContent` only | Unit test and a browser test with html in the notes |
| Update check: the download button can only open `https://github.com/<project>/releases...`. The opener permission is scoped to the same address | Unit test for the address check; scope in `capabilities/default.json`. Device: the real opener is not run here |
| Page policy now has `connect-src ipc: http://ipc.localhost https://api.github.com` and nothing else | Browser test reads the policy from `tauri.conf.json` |
| No automatic installing exists yet, so no update code is downloaded or run | By design. It needs a signing key first |
| The update check reads no vault data and can be switched off with one setting (on by default, by decision of the owner). The first-run text names it | Browser tests |
| Settings read from the settings file are validated (themes, sizes, widths, flags) and unknown values become defaults | `tests/themes.test.mjs`, `tests/updates.test.mjs` |
| No `unwrap()` or `expect()` in new Rust code after startup | Checked with a search |
| Secrets: none exist yet. A signing key will go into GitHub secrets, never the repository | n/a |
| The assistant is still off and absent from the interface | Browser test |
| New dependency: `tauri-plugin-opener` 2.7.2 and `@tauri-apps/plugin-opener` 2.7.2, pinned. It also adds the `zbus` family on Linux | Cargo.lock only gained packages, no existing version changed |
| Open risk | The Tauri window with the real policy, opener and file drops has not been run here (device). Pictures pasted from other programs are trusted only as far as their first bytes |

## Addendum for 0.2.1

No new input, network request, permission, dependency or Rust code. Changes are layout, icons (drawn from fixed paths in `web/icons.js`, no outside files) and test additions. Page policy, update check and opener scope are unchanged. Checked by the browser tests, which fail on any page error, console error or policy violation.

## Addendum for 0.2.2
- Recent folders are paths stored only in settings.json. They are validated on load (strings, length limit, no control characters, duplicates removed, at most 8). They are never sent anywhere.
- No new network calls, no new Rust code, no new permissions. The content security policy is unchanged. Builder-checked, not an outside review.
