# Progress

Status key: not started, in progress, built (tried only where the builder can run it), tested (tried by the owner on a real device), reviewed (a human has read the code).

Last updated: 2026-11-04, 0.2.1 built (branch feature/v0.2.1-polish).

## 0.2.1: built, not tried on a device (from the owner's first test of 0.2 on the Windows portable build, 2026-11-04)

Items 1 to 4, 6 and 7 below are built and tried in the test browser only (desktop and phone width, light and dark). Also built: the first-run screen shows the default folder's location (new Rust command `default_vault_path`, not compiled here, GitHub Actions compiles it). Item 8 (a block type row in the selection bar) was not part of this release. Needs a try on a real device: the gear and icons in the real window, the sidebar when narrow (Settings, note list width 200), the What's new box, the default folder path on the first-run screen (Windows, Linux, and Android where the folder is private to the app), the handle position on every block type, and dragging with the handle hidden. Release notes: `docs/release-notes/0.2.1.md`.

A small fix release between 0.2 and 0.3, so these are done well before 1.0.0 and more findings from the other devices can be added to it first. No new features. Each item needs a screenshot check in light and dark at desktop and phone width.

1. The "What's new" box is too small for its text and scrolls inside a small area. Make the box taller and wider (it can use most of the window), and keep the release notes short.
2. The Settings link at the bottom left is hard to see. Replace it with a gear icon drawn as an svg that takes its colour from the theme, with the text label kept as its accessible name. No emoji anywhere in the app. The same pass moves any remaining typed symbols (the block handle dots and the toggle arrow) into the svg icon set, so there is one icon set.
3. Move "Open another folder" to the top of the sidebar.
4. The sidebar items get squished when the list is dragged narrow (the New note and New folder buttons wrap, the bottom links stack). Find a layout that holds up: for example icon-only buttons below a width, a sensible minimum list width, and bottom links that do not wrap.

The note width setting works (checked by the owner with a note open); it only looked unchanged because no note was open. Possible small improvement: say so in the settings or show a preview.

6. Block handle position: it sits at the top edge of its block, so it looks off-centre next to headings, code and lists, and badly placed next to the divider (a 2 pixel line). Centre it on the first line of the block, and give the divider a proper spot.
7. While dragging, the handle that was grabbed stays visible. Hide it (or turn it into the drag preview) during the drag.

8. Selection bar: Notion also shows a block type row there. Notes and a proposed split are in `docs/notion-reference-notes.md`.

Also still open for 0.2.1 or later: the inline styles (decided 2026-11-04, see DECISIONS.md: highlight as `==text==`, colour, underline, sub and superscript as inline html from a fixed palette; not built yet, to be placed in a release), and anything found on the Android phone and Linux.

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
- Underline, highlight, colour, subscript and superscript: decided 2026-11-04: highlight as `==text==`, the others as inline html from a fixed palette. Not built yet.
- Automatic installing of updates: needs a signing key in GitHub secrets. Until then the notice opens the download page.
- Following block links (`[[Note#^id]]`): 0.3.
- Only text blocks can be turned into other block types. Callouts, toggles and tables cannot be dragged into each other.

Needs a try on a real device (Windows .msi, Android phone, Linux):
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
| 0.0 | Spikes: Tauri on Windows and Linux including pen pressure, an Android hello-world, an editor saving a markdown file | in progress. Builds for Windows, Linux and Android are made by GitHub and published as a release. Tested by hand: Linux (opens, mouse works) and Windows (mouse, touchpad, finger, pen pressure and eraser button work). Android phone: installs, runs and finger drawing works; the top bar was hidden under the status bar (fixed, not yet re-tested). Not tested: Android pen, Fedora, pen barrel button (does not work on the test pen in other apps either), tilt (not reported on the test pen), an editor saving a markdown file |
| 0.1 | Vault, sidebar tree, block editor and slash menu, autosave, logging, the AI off-switch, first-run disclosure, logo | built, not tested on a device (see above) |
| 0.2 | Editor completion, markdown source view, block gutter, themes, settings, update notice (converter dropped) | built, not tested on a device (see above); inline styles decided, not built |
| 0.2.1 | Polish from the first device test of 0.2 (see "0.2.1: built"). No new features | built, not tried on a device; comes before 0.3 |
| 0.2.2 | Block editing polish: a preview of the block being dragged, selecting several blocks and moving them together | planned, after 0.2.1 |
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

## Block layout: columns (waiting for a decision)
Owner request (2026-11-04): drag a block next to another one to make columns. Markdown has no columns, and the notes must stay plain markdown that Obsidian can open. A format has to be chosen first, for example an Obsidian-style callout block holding the columns, or a small html table. The choice affects what other programs show, so it needs the owner's decision before anything is built. Proposed home: after 0.3, as its own slice, once 0.2.2 has the drag preview and multi-select in place.

The owner's Notion screenshots (drop on the left or right edge of a block makes columns, vertical and horizontal drop lines, a half see-through drag preview) are written up in `docs/notion-reference-notes.md`. The format has to hold two or more columns of several blocks each.
