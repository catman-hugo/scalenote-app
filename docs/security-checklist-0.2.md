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

