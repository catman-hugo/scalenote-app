# Progress

Status key: not started, in progress, built (tried only where the builder can run it), tested (tried by the owner on a real device), reviewed (a human has read the code).

Last updated: 2026-11-04, end of the 0.2 build session.

## 0.2 state (branch feature/v0.2-editor, pull request #9)

Built and tried only where the builder can run it (a test browser with a pretend backend, and Rust tests). Nothing has been run in the real window on any device.

- 0.2.1 Text formatting: selection bar (bold, italic, strike, code, link), Ctrl/Cmd+K. Callouts, toggles and tables are editable blocks. Untouched notes are written back byte for byte (property tests with random notes).
- 0.2.2 Pictures: slash menu, paste and drop. Copied into `attachments/` by the Rust side (type from the first bytes, 10 MiB, atomic, SVG refused).
- 0.2.3 Block handle: menu (move up and down, duplicate, delete, turn into, copy block link), drag with mouse, touch and pen events, Alt+Up and Alt+Down. Block ids use ` ^id`. Touch and pen dragging were tested with synthetic touch and pen events from the test browser only.
- 0.2.4 Markdown source view for the whole note.
- 0.2.5 Eight themes plus "follow the system"; Settings for theme, text size, note width and list width. Contrast is tested.
- 0.2.6 Update check (on by default, one setting), notice with download button, What's new once after an update, first-run text mentions it, `connect-src` added to the page policy. Phone keyboard layout fix (`100dvh`, `interactive-widget`). The note list was already open at the start; a test now covers it on a phone-sized window.

Tests: `npm test` (JS, 53 tests), `cargo test -p scalenote-core --locked` (33 unit, 1 crash test, 14 vault tests), `node tests/editor.spec.mjs` (browser tests, they also fail on any page error or policy violation). The browser tests never reach the real GitHub.

Not done:
- Underline, highlight, colour, subscript and superscript: waiting for the owner's decision on which inline html is allowed.
- Automatic installing of updates: needs a signing key in GitHub secrets. Until then the notice opens the download page.
- Following block links (`[[Note#^id]]`): 0.3.
- Only text blocks can be turned into other block types. Callouts, toggles and tables cannot be dragged into each other.

Needs a try on a real device (Windows 11 .msi, POCO F7 Pro Android, Linux):
- The real window with the new page policy (`connect-src ipc: http://ipc.localhost https://api.github.com`): if notes will not open, this is the first suspect.
- Dropping a file into the note on Windows (`dragDropEnabled: false`), choosing and pasting pictures on Android.
- Dragging blocks by finger and by pen; the handle next to the on-screen keyboard.
- The phone keyboard no longer pushing the top bar under the status bar.
- The download button in the update notice (opener plugin and its address scope).
- All eight themes on the real screens, sage and lavender first.

Checks written: `docs/security-checklist-0.2.md`, `docs/release-notes/0.2.0.md`. Design check: screenshots of every new screen in light and dark, desktop and phone width, plus one per theme (made with `SHOTS_DIR=... node tests/editor.spec.mjs`).

## 0.1 state (branch feature/v0.1-vault-editor)

Built and tried only where the builder can run it (no device was used):
- Vault: open a folder or use the default one (Documents/ScaleNote on desktop, app-private storage on Android). `scalenote-core` crate: atomic writes, conflict check by content hash, path and symlink escape checks, unique names, size limits, log with rotation. 36 Rust tests pass (Linux), including a test that kills a saving program 40 times at different moments.
- Editor: sidebar tree (collapsible, slides over the note on narrow screens), Tiptap block editor, slash menu (text, headings 1 to 4, bulleted, numbered, to-do, quote, code, divider), autosave 600 ms after typing and on blur or close, rename through the title, conflict copies. Notes opened and left untouched are never rewritten. Syntax the editor does not know (tables, html, wikilinks, callouts, math, images) is shown as a "kept exactly as written" block. 10 splitter tests (including 3000 random documents) and 11 browser tests with a pretend backend pass. The browser tests also check that the content security policy is not violated.
- First-run disclosure, folder choice, logo in the app, pen test page reachable from the sidebar. The assistant is stored as off and has no switch or any element in the interface.
- Design check done on screenshots in light and dark, at desktop and phone width.

Automatic checks on PR #7 (all green on the latest commit): Rust and interface tests on Linux and Windows, and builds of the Linux packages, the Windows installers plus a portable zip, and the Android debug APK. So the Rust glue compiles on all three.

Not done or not tested:
- Nothing has been run inside the real Tauri window, on any device.
- Not tried on a device: Windows folder picker, Android default folder, window-close saving, the .msi and .deb installers, keyboard behaviour on Android (slash menu).
- Not checked here: a note on a network drive or a sync tool changing files while open.
- Known limits: lists with blank lines inside (loose lists), numbered lists using ")" and any block with wikilinks, tags, html or images are kept as raw blocks and edited as plain text. No delete, no move, no search (0.3). Underline is off because markdown has no underline. Release notes are in `docs/release-notes/0.1.0.md` and the security checklist in `docs/security-checklist-0.1.md` (builder-checked, not an outside review). The 0.2 plan is in `docs/v0.2-plan.md`.

## Versions

| Version | What it adds | Status |
|---|---|---|
| 0.0 | Spikes: Tauri on Windows 11 and Linux Mint including pen pressure, an Android hello-world, an editor saving a markdown file | in progress. Builds for Windows, Linux and Android are made by GitHub and published as a release. Tested by hand: Linux Mint (opens, mouse works) and Windows 11 (mouse, touchpad, finger, pen pressure and eraser button work). Android (POCO F7 Pro, Android 16): installs, runs and finger drawing works; the top bar was hidden under the status bar (fixed, not yet re-tested). Not tested: Android pen, Fedora, pen barrel button (does not work on the test pen in other apps either), tilt (not reported on the test pen), an editor saving a markdown file |
| 0.1 | Vault, sidebar tree, block editor and slash menu, autosave, logging, the AI off-switch, first-run disclosure, logo | built, not tested on a device (see above) |
| 0.2 | Editor completion, markdown source view, block gutter, themes, settings, update notice (converter dropped) | built, not tested on a device (see above); inline html styles waiting for a decision |
| 0.3 | Search, command palette, wikilinks, backlinks, tags, favorites, covers, export, trash and page history | not started |
| 0.4 | Canvas and pressure-sensitive ink | not started |
| 0.5 | Home server, sync, browser client | not started |
| 0.6 | Android, offline choices per item, share target and quick capture | not started |
| 1.0.0 | Hardening, accessibility, tests on every device | not started |
| 1.1 | Planning and calendar, templates, daily notes | not started |
| 1.2 | AI assistant and the model Cookbook | not started |
| 1.3 | Memory | not started |
| 1.4 | Study tools: flashcards, quizzes, spaced repetition | not started |
| 1.5 | Importers: Notion, Evernote, Rnote, Word, CSV, PDF text | not started |
| 1.6 | Peer-to-peer sharing | not started |
| 1.7 | Server accounts and shared notebooks | not started |
| 1.8 | Comments and suggestions | not started |
| 1.9 | Calendar sync with iCloud and Nextcloud | not started |
| 1.10 | Rich blocks, link paste, saving whole web pages | not started |
| 1.11 | Database views | not started |
| 1.12 | Graph view, canvas polish, handwriting search | not started |
| 1.13 | 3DS drawing clients | not started |
| 1.14 | OneNote import | not started |
| 1.15 | Dutch translation | not started |
| 2.0.0 | Public release: security gates, outside review, signed builds | not started |
| 2.1 | Community themes and extensions | not started |

Not planned: voice calls, and Apple hardware.

## Human review

Nothing has been reviewed by a human yet.
