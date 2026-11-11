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

## Addendum for 0.2.4
- No new network calls, no new Rust code, no new permissions. Renaming uses the existing `rename_entry` command, which sanitises the new name, refuses names that exist and never replaces anything.
- Names typed in the list are set as text (never as html), and are limited to 100 characters in the field.

## Addendum for 0.2.5
- New Rust command `move_entry`. Both paths go through `resolve`, which refuses empty parts, `.` and `..`, hidden names, absolute paths and backslashes, and checks that nothing leaves the vault through a symlink. It never replaces an existing entry, refuses a folder into itself or below itself, and a note must end in .md. Covered by vault tests, including odd paths. Compiled and run only by GitHub's build.
- No new network calls and no new permissions. The drag copy of a block is a clone of the page's own content with ids and editable parts removed; it never leaves the page.
- Names shown in the drag label are set as text, never as html.

## Addendum for 0.2.6
- No new network calls, no new permissions, no new dependencies and no change to the content security policy. The Android change is a build-time patch to two generated files (the manifest keyboard setting and a small activity that pads the content by the keyboard height); it reads nothing from outside and stores nothing.
- The patch script only edits files under `src-tauri/gen/android` and stops if they do not look as expected. Compiled and run only by GitHub's Android build, and then on the phone.

## Addendum for 0.2.7
- No new network request: the file addresses come from the release list that was already fetched. Everything in it stays untrusted: a file address is used only if it starts with this project's releases download address, has no spaces, quotes, angle brackets or backslashes, is under 400 characters, belongs to a file whose upload is finished and whose name ends as expected. Anything else falls back to the release page address, which has the same check.
- Permissions: one new opener address pattern, `https://github.com/catman-hugo/scalenote-app/releases/download/*/*`, the same project only. The app opens the address in the system browser and reads nothing back; it never runs or installs the file itself.
- No new Rust code and no new dependencies. A downloaded installer is not signed or checked by the app yet (known, already listed as open before 2.0.0).

## Addendum for 0.2.8
- No new network calls, permissions, dependencies or Rust code. The build step copies picture and xml files from the repository into the generated Android project and reads nothing from outside.

## Addendum for 0.2.9
- No new network calls, permissions, dependencies or Rust code. The style markers are read from notes, which are untrusted: only exact shapes are recognised (fixed colour list, no free css, no nested spans), everything else stays raw and is written back unchanged. Nothing from a note is ever set as html or as an inline style; colour is a class chosen from the fixed list, and the page policy (no inline styles) is unchanged and was checked in the browser tests (no policy errors).
- Huge or odd input: the marker rules were run on 150 to 580 thousand characters of repeated, unclosed and badly paired markers (`==a ` x 50000, `<u>` x 50000, 20000 colour spans, a long `==a=a=...` with no end); each finished in under 20 ms. The browser tests cover unbalanced and nested markers and styles inside callouts, toggles and tables.

## Addendum for 0.2.10
- New Rust command `export_obsidian_copy`, the first thing in the app that writes outside the notes folder. It takes no argument from the interface: the place is always the parent folder of the open notes folder, and the name is fixed ("<notes folder name> (Obsidian copy)"). The folder is reserved with one create call, so an existing folder is never reused or replaced; the next free numbered name is used. Every file is written through the atomic writer. Hidden entries (including `.obsidian` and `.git`) and symbolic links are not followed or copied, so nothing outside the notes folder can be pulled into the copy. Depth, entry count, note size and file size are limited. If the copy fails, only the folder this call created is removed. It is refused on Android.
- Notes are untrusted text: the converter only recognises exact forms (a fixed list of colour names, at most one text and one background class), leaves everything else as it was, never runs or evaluates anything, and has a nesting limit. A hostile note (20 000 unclosed or nested spans, 100 000 backticks, backtick runs of every length) is handled in well under a second (test). The first version of the converter was quadratic on such input; it was found by that test and fixed.
- Colours in the editor are drawn from classes chosen from a fixed list; nothing from a note is set as a style attribute or as html. The page policy (no inline styles) is unchanged and was checked by the browser tests (no policy errors).
- The log gets only counts and error codes, never paths. The Settings message shows the path of the copy to the person.
- No new network calls, permissions or dependencies.

## Addendum for 0.3.0
- Six new Rust commands: `trash_entry`, `trash_list`, `trash_restore`, `trash_delete_forever`, `trash_empty` and `search_vault`. They only work inside the open notes folder. A path for Delete goes through the same check as every other path (no `..`, no hidden parts, no backslashes, nothing that leaves the folder through a link), so `.trash` itself and the folder top cannot be deleted. Trash ids come from the interface, so they are checked to be digits and "-" only (tested with `..`, slashes and letters). The name and place read back from a trash entry are checked again before use: a damaged entry with `../escape.md` is refused and one with a bad place restores at the top (tested).
- Nothing is removed except by Delete forever or Empty trash, and removing an item removes the item's own folder without following links (tested with a link to a folder outside the notes folder: its content stays). Moves use rename inside the same folder, so they cannot leave a half-copied page.
- Search reads untrusted page text: only plain text comparison (no patterns, so no pattern-attack), limits on query (200 letters, 8 words), results (50), pages collected (2,000), text read (512 MiB), page size (8 MiB); invalid text and links skipped. The query is never written to the log (only "search failed" and an error code). The result text is put in the page with text nodes, never as html; a test with a page containing `<img onerror>` shows it as text and runs nothing.
- Search runs without holding the vault lock, so a slow search cannot block saving.
- A page name ending in an accented letter could panic the page list (byte slicing); fixed and tested. No new network calls, permissions or dependencies.

## Addendum for 0.3.1
- The test signing key is a GitHub secret, never in the repository, logs or release files. The build only prints the public SHA-256 fingerprint of the certificate. If the secret is missing the build falls back to a throwaway key and says so. Only code in this repository's own branches can read the secret (pull requests from forks cannot). The key signs test builds only. No new permissions, network calls or app code besides hiding one icon on Android.

## Addendum for 0.3.2
- Interface only: no new Rust code, commands, permissions, network calls or dependencies. The menu is asked for with a script-made `contextmenu` event on an entry; the code that handles it is unchanged. A finger-made contextmenu is dropped only inside the page list. Entry paths and names still come from the vault listing and are shown as text.

## Addendum for 0.3.3
- One new Rust command, `backlinks`. Its only argument is a page path, which goes through the same path check as every other command (no `..`, no hidden parts, nothing leaving the folder). Like search it runs without holding the vault lock, skips hidden folders (so the trash), links to folders and invalid text, and reads at most 2,000 pages, 8 MiB per page and 512 MiB in total; at most 200 pages are returned. Nothing is written.
- Link text comes from notes and is untrusted. It is only ever parsed by fixed scanning code (no patterns built from it, no evaluation), a link is at most 300 long and at most 5,000 links are read from a page; code is skipped. Tested with 100,000 links, 100,000 backticks and brackets, unclosed and escaped brackets and multi-byte text: each finishes in well under a second in both the Rust and the interface versions. A link's text is shown with text nodes, never as html, and is stored in a data attribute only as text; it is never used as a path without going through the vault (opening a page uses the page list the vault gave, creating one uses the normal name checks).
- A link to a missing page creates a page on click. The name goes through the same checks as New page (no slashes, no reserved names, length), a failure shows a calm message, and a double click makes only one page.
- The page policy (no inline styles) is unchanged; the browser tests report no policy violations. No new network calls, permissions or dependencies.

## Addendum for 0.3.5
- No new Rust code, commands, permissions, network calls or dependencies. The picture goes through the existing picture command, which checks the real file content, the type (no SVG) and the size (10 MB) again in Rust.
- The cover path is read from a note's properties, which are untrusted. It is only used if it is a picture path inside `attachments/` (no `..`, no spaces, no `//`, no scheme, no brackets or quotes, a picture extension), and then only to read that file through the existing attachment reader, which applies the vault's own path checks. The picture is shown as a `data:` picture in an image element with fixed text, never as html. A hostile properties block (50,000 lines, 200,000 characters on one line, repeated keys, an unclosed block) is read in well under a second (test).
- Writing: only the one `cover:` line is added, replaced or removed; the rest of the block is kept byte for byte, an unclosed block or a multi-line `cover` entry is refused, and the page is saved through the normal atomic save.
- The page policy (no inline styles) is unchanged and no policy errors were reported by the browser tests.

## Addendum for 0.3.6
- One new Rust command, `page_index`. It takes no argument. Like search it runs without holding the vault lock, skips hidden folders (so the trash), the attachments folder, links to folders and invalid text, and reads within the page list's own limits, at most 8 MiB per page and 512 MiB in total. Nothing is written.
- Tags and the properties block are untrusted text. They are read by fixed scanning code (no patterns built from the text, no evaluation); a tag is at most 100 letters and at most 5,000 are read from a page; code and link headings are skipped. Tested with 100,000 tags, 100,000 backticks and hashes, a million-letter tag, escapes and multi-byte text: each finishes in well under a second in both the Rust and the interface versions. Tag names are shown with text nodes and stored in a data attribute only as text; they are never used as paths or html.
- Writing: only the one `favorite:` line is added, replaced or removed (same code as covers); an unclosed block or a multi-line `favorite` entry is refused, and the page is saved through the normal atomic save.
- The page policy (no inline styles) is unchanged and no policy errors were reported by the browser tests. No new network calls, permissions or dependencies.

## Addendum for 0.3.7
- Five new Rust commands: `history_list`, `history_read`, `history_keep_now`, `history_clear`, `export_page`. Each takes a page path (history_read also a copy id) and goes through the vault's own path checks. A copy id is digits only, at most 20 characters, so it cannot name another file. A history key is built from the page's `id:` only if it is letters, digits, `_` and `-` (at most 64); otherwise a hash of the path is used. Tested with hostile ids and copy names.
- `.history` is a hidden folder: not listed, searched, linked, indexed or copied to the Obsidian copy. Size is bounded: 100 copies and 32 MiB per page, 256 MiB in all, listing at most 500. A failed copy never fails or delays a save. The history holds deleted text, so Settings has "Delete all history".
- Export takes no destination from the interface. The folder is `<notes folder> (exports)` beside the notes folder; if that name is a link or a file it is refused; nothing is replaced; a half-made folder is removed; writes are atomic. Only plain names under `attachments/` are copied, only real files (not links) whose content is a picture and at most 10 MB, at most 200. Tested with `..`, folders, links and a text file named `.png`.
- Page text compared in the History box is untrusted: it is shown with text nodes only, at most 400 lines per part and 200 parts are drawn, and the comparison falls back to one change above 4 million cells. Tested with hostile and very long input.
- Restore writes through the normal atomic save with the version check; if the page changed since the box read it, nothing is written.
- The page policy (no inline styles) is unchanged. No new network calls, permissions or dependencies.

## Addendum for 0.4.0
- Two new Rust commands, `read_canvas` and `write_canvas`. Each takes a page path and goes through the vault's own path checks (the page must exist and be a `.md`); the file written is always that page's `.canvas.json` beside it, so the interface cannot name another file. Atomic write, 32 MiB limit, exact-version check, a link in place of the file is never followed. Tested with paths out of the vault, a link, a binary file and an oversized text.
- Trash, restore, rename and move now carry a page's `.canvas.json`. Nothing is replaced: a stale drawing under the new name stops a rename, and on restore it is never overwritten (the trashed drawing stays in the trash folder in that case). Tested.
- A drawing file is untrusted text. It is read by `JSON.parse` and one strict check (`parseCanvas`): known keys only are kept, colours from a fixed list, numbers finite and in range, at most 20,000 strokes, 5,000 points per stroke and 1,000,000 points. Anything wrong makes the drawing read-only and it is never saved over. Nothing from it is run, shown as html or used as a path. Tested with broken, hostile and oversized input, including `__proto__` keys.
- Input from the screen (pen, touch and mouse events) is only used for coordinates and pressure, clamped by the same limits when written. No new network calls, permissions or dependencies. The page policy (no inline styles) is unchanged: the canvas is drawn with the 2D canvas API and the toolbar uses classes.

## Addendum for 0.4.1
- No new Rust commands, permissions, network calls or dependencies. The drawing file is still read by `JSON.parse` and one strict check; the new kinds (highlighter, shape, note) are checked field by field: kinds and colours from fixed lists, numbers finite and in range, note text a string of at most 2,000 characters, note size 20 to 2,000, at most 20,000 items in all. Anything wrong makes the whole drawing read-only and it is never saved over. The read builds clean copies with the known fields only, so unknown keys and `__proto__` are not carried into the program. Tested, including hostile text.
- Note text from a file is never shown as html: it is drawn with `fillText` on the canvas and put in a text box with `.value`. A test opens a note containing a closing text-box tag and a script tag and checks that nothing runs and the file is unchanged by opening.
- The text box over the sheet is positioned with `element.style` (the CSSOM), not with a `style` attribute or inline `<style>`, so the page policy against inline styles is unchanged.
- Limits on what the interface produces: a note is cut at 2,000 characters, a loop at 5,000 points, a stroke at 5,000 points, and an item cannot be moved outside the coordinate limit.


## Addendum for 0.4.10
- Columns and ink over text: no new Rust commands, permissions or dependencies. Ink is read by the same strict check as the drawing file (new `ink` list: anchor tag from a fixed list, block number bounded, fractions finite, same point limits). Columns are plain text in the page and go through the same exact-text reader as callouts; a page that does not match the column shape is kept byte for byte.
- Android installer (NOT run on a device). New permission `REQUEST_INSTALL_PACKAGES`, a new FileProvider (`<applicationId>.apkprovider`, not exported, sharing only the cache `updates/` folder), and a JavaScript bridge `ScaleNoteInstaller` with one method. The address is checked in the page and again in Kotlin (fixed prefix of this project's releases, `.apk`, no `..`, no query, no spaces or quotes), the download uses https only with timeouts and a 200 MB limit, goes to a temporary name and must start with `PK`, and Android's own installer asks the person to confirm. The status sent back to the page is one of four fixed words. The bridge is exposed only to the app's own page, which loads no remote content. Residual risk: the file comes from GitHub over https without a signature check of our own; Android itself refuses an update signed with a different key.
