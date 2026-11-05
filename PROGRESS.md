# Progress

Status key: not started, in progress, built (tried only where the builder can run it), tested (tried by the owner on a real device), reviewed (a human has read the code).

Last updated: 2026-11-04, 0.2.1 released and first tried on Linux; 0.2.2 planned.

## 0.2.2 plan (built, see "0.2.2: built"; from the owner's test of 0.2.1 on Linux, 2026-11-04)

Tried on Linux and found good: the gear icon, "Open another folder" at the top, the sidebar layout, the handle position (also on the divider), hiding the grabbed handle, and the default folder text. Not yet seen: the What's new box.

1. Switching folders. Clicking the folder name at the top left of the sidebar opens a small menu with the recently used folders (the current one marked), "Open another folder" and "Use the default folder". This lets the owner keep a separate folder for each area of life. Open another folder goes straight to the folder picker. It must no longer show the first-run Welcome screen, which today looks like a fresh install. Recent folders are stored in the settings file only (a short list, validated, a folder that no longer exists gives a calm message). To confirm with the owner: whether the separate "Open another folder" button at the top of the sidebar goes away once the name opens this menu.
2. The first-run Welcome screen can only be closed by choosing, and that stays so on the very first start. Any other time it must be possible to close it (a Close button, the Escape key, and clicking outside). The folder menu in item 1 should make this case rare, but the rule applies to every dialog that is not the first-run disclosure.
3. Text size: add a smaller option, so there are five: Smallest (80 percent), Small, Normal, Large, Largest. The icons in the sidebar buttons (New page, New folder, Open another folder) scale with the text size, which means sizing every icon in text units instead of fixed pixels. If the Open another folder button stays, its text is centred like the other two buttons.
4. Rename "New note" to "New page" in the sidebar and in the sentences that name it. To confirm with the owner: whether "note" becomes "page" everywhere in the interface or only on this button.
5. Toggle block: folding does not work. Clicking the arrow does nothing. Found in the test browser: it is a bug since 0.2.0 (the old text arrow did not fold either), not caused by the new icons. The cause is that the editor sees the fold class change on the block as an edit and puts it back. It needs a test for folding, which did not exist.
6. Toggle look: the box around the toggle title and the outline of the block are only visible while the owner is working in the toggle. Otherwise only the arrow and the title are shown.

## Release table note

0.2.2 is now the release for the list above. The block editing polish that was planned as 0.2.2 (drag preview, selecting several blocks, plus button, block type row in the selection bar) moves to 0.2.3.

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

## 0.2.2: built
From the owner's test of 0.2.1 on Linux (2026-11-04).
- Folder switcher: the folder name at the top left opens a menu with recent folders (current one marked), Open another folder (straight to the picker) and Use the default folder. Recent folders are kept in settings.json, at most 8, cleaned on load. A folder that cannot be opened is removed from the list with a calm message. The folder name is disabled on the Android phone, which has no picker.
- Settings and What's new close with the close button, Escape or a click outside. The Welcome and disclosure screens stay unclosable at first run.
- Text sizes: Smallest (80 percent), Small (90), Normal (100), Large (112), Largest (125). Icons are sized in rem so they scale.
- "Note" became "page" in the interface (the callout kind "Note" is unchanged).
- Toggle: the fold bug was a class change on the node view being treated as an edit and undone; fixed and covered by a test that fails without the fix. A toggle shows only arrow and title until focus is inside it.
- Tested here: 57 unit tests, the browser tests (including new ones for each item above) and screenshots in light and dark, desktop and phone width, at text sizes 80, 100 and 125. No Rust changes, so the Rust tests are unchanged.
- Not tried on a device: everything above. Needs a real test on Linux, Windows and the Android phone (folder menu on the phone is disabled by design; check that it looks right).
- Moved to 0.2.5: drag preview, multi-select, plus button, block type row in the selection bar.
- Release notes: `docs/release-notes/0.2.2.md`.

## 0.2.3: built
Found on a device (2026-11-04): the update check ignored releases labelled Pre-release, and every release so far has that label, so 0.2.1 said "latest version" while 0.2.2 was out. Setting 0.2.2 to None made it appear, which proved the cause. `newestRelease` in `web/updates.js` now skips only drafts. Tags that are not a plain x.y.z are still ignored. Unit test covers pre-release only lists, drafts and the current version. Block editing polish moved to 0.2.5.
- Not tried on a device. Builds older than 0.2.3 cannot see pre-releases, so 0.2.2 and older need one manual install. Release notes: `docs/release-notes/0.2.3.md`.

## 0.2.4: built
Owner request (2026-11-04): a right-click menu in the page list, like the old server-only ScaleNote, starting with renaming folders. Renaming a folder already worked, but only by double-click, which nobody can discover and which does not work with a finger.
- New `web/contextmenu.js`: a small menu opened by the `contextmenu` event (right-click, long press on a touch screen, menu key). It holds one entry, Rename, for folders and pages. Delete, Duplicate and Share are not offered because they do not exist yet (trash is planned for 0.3).
- Renaming happens in the list. The field replaces the button instead of sitting inside it, because a text field inside a button loses focus when clicked in Chromium. F2 on a focused entry renames it too. An open page is saved before its file is renamed, and the title follows the new name. The Rust `rename` is unchanged.
- Tested here: 57 unit tests, the browser tests (7 new: menu on a folder and a page, Escape and outside click, F2 and clicks inside the field, a taken or empty name, menu kept inside the window) and screenshots in light and dark, desktop and phone width. Rust tests unchanged (no Rust changes).
- Not tried on a device: the long press on the Android phone (it relies on the web view sending the contextmenu event on a long press), the menu key on Linux and Windows, and everything else above.
- Release notes: `docs/release-notes/0.2.4.md`. Block editing polish moved to 0.2.5.

## 0.2.5: built
Owner request (2026-11-04): move pages and folders into other folders by dragging them in the sidebar, together with the planned block editing polish.
- Moving: new `Vault::move_entry` in the Rust core (3 new vault tests: moves of a note and a folder with contents, refusals for a folder into itself or below itself, name clashes, missing or non-folder targets, odd paths, and the no-op case) and a `move_entry` command in `src-tauri/src/lib.rs`, which mirrors `rename_entry`. The command is only proven by GitHub's build, as before. In the app, `web/treedrag.js` drives the drag with pointer events (mouse and pen). A flat label follows the pointer, the receiving folder is outlined, the empty space below the list means the top level, Escape cancels. Touch does not start a drag (it would fight with scrolling); the right-click menu has Move to, which lists only valid folders. An open page is saved before its file moves.
- Block polish: a see-through copy of the block follows the pointer (kept at the grab distance, no ids or editable parts), several blocks selected by text selection move together by drag, by the menu and by Alt+Up/Down and stay selected, one Undo reverts a move, a plus button left of the grip (only when the margin has room, else "Add block below" in the menu), and a block type button at the start of the selection bar (hidden when the selection spans blocks).
- Found and fixed while testing: pressing Undo right after opening a page emptied the editor, because loading a page was an undoable step, and autosave then could save the empty page. Loading now uses `addToHistory: false`. A browser test checks that Undo on an untouched page changes nothing and nothing is written. This bug existed in all versions since 0.1.
- Tested here: 57 unit tests, Rust tests (33 + 1 + 17), the browser tests (7 new for moving, 7 new for blocks, 1 for the Undo fix) and screenshots in light and dark, desktop and phone width.
- Not tried on a device: everything above. In particular the drag in the list with a real mouse and pen, Move to on the Android phone, and the long press that opens the menu.
- Known limits: no auto-opening of a folder while dragging over it (open it first), no dragging with a finger in the list, and the plus button needs a wider window than the smallest ones.
- Release notes: `docs/release-notes/0.2.5.md`.

## 0.2.6: built
Owner request (2026-11-05): on the Android phone, typing in a page slid the whole screen up and out of view. The keyboard should cover the bottom of the page instead, the page should scroll only as far as needed to show what is being typed, and the page title must always stay visible.
- Cause: the Android project that `tauri android init` generates draws edge to edge and sets no keyboard behaviour, so Android pans the whole window. I read this from the Tauri 2.12.4 template embedded in the pinned CLI, not from memory.
- Fix on Android: `scripts/patch-android.mjs` runs in CI right after the init step. It adds `windowSoftInputMode="adjustResize"` to the manifest and replaces the tiny `MainActivity.kt` with one that, on Android 11 and newer, pads the bottom of the content by the keyboard height (the framework does not resize edge to edge windows on its own). The page then ends where the keyboard begins. The script refuses to run, and so fails the build, if the generated files do not look as expected. 7 unit tests call the real patch functions on text shaped like the generated files.
- Fix in the page: when the window gets shorter and the editor has focus, `keepCaretVisible` in `web/main.js` scrolls the cursor into view only if it is outside the visible note area. The top bar is outside the scrolling area, so it stays. 2 browser tests (a phone window shrunk from 860 to 420 pixels): the cursor on the last of 40 lines ends up visible with the top bar on screen, and a cursor that is already visible does not move the note.
- Found while testing: asking ProseMirror to scroll blindly nudged the note by 57 pixels even when the cursor was visible, so the handler checks first.
- Tested here: 64 unit tests, the browser tests, screenshots in light and dark of the shortened phone window (`v026-phone-*`).
- NOT tested, needs the Android phone: the Kotlin file is only compiled by GitHub's Android build, and whether the real keyboard now shortens the window (and where the page ends relative to the navigation bar) is unknown until it runs on the phone. The browser tests only prove what the page does once the window is shorter.
- Release notes: `docs/release-notes/0.2.6.md`.

## 0.2.7: built
Owner request (2026-11-05): after Check now found a newer version there was no way to get it. Wanted: download it directly; if that is not possible a link to the file; if not, a link to the release on GitHub.
- Decided with reasons: the app cannot install by itself yet (updates need signed installers, and an Android install needs a new permission), and it cannot download inside the app (the Rust core has no network code, by design). So the Download button hands the file address to the system browser, which downloads it; the person opens the file to install. Fallbacks, in order: the file for this system, then the release page, then a calm message naming the releases page.
- The file comes from the `assets` list in the one release list the app already reads, so there is no new network request. `pickDownload` chooses by system (from the browser's own description): Android `.apk`, Windows `.msi` then `-setup.exe`, Linux none (a program cannot tell .deb from .rpm, so Linux gets the release page). A file address is accepted only if it is a file under this project's releases (same rule as the release page), and a file still uploading is skipped.
- Settings now shows Download and Open the release page after Check now (the banner is hidden behind that box). The banner button says "Open release page" when there is no file. The settings label "Look for new versions and install them automatically" was untrue and is now "Look for new versions".
- Capability: one added opener address pattern for `releases/download/*/*`, the same project only.
- Tested here: 69 unit tests (12 new on the real functions, including bad addresses), the browser tests (8 new: Android, Windows, Linux, fallback to the page, nothing openable, a file from another site, the Settings buttons), screenshots in light and dark.
- NOT tested, needs devices: that the Android web view really hands the address to the browser and the apk downloads and installs (Android may ask to allow installing from the browser), that the Windows .msi opens, and that the new opener address pattern is accepted by Tauri's permission check (only GitHub's build and a device show that).
- Release notes: `docs/release-notes/0.2.7.md`.

## 0.2.8: built
Owner request (2026-11-05): the Android app showed the default Tauri logo (seen in the list of open apps); it should have the ScaleNote logo like Windows and Linux.
- Cause: `tauri android init` writes Tauri's own launcher icon files into the generated project and does not use `src-tauri/icons/android`, where the ScaleNote icons (logo on a white tile, adaptive foreground inside the safe area) were already committed. I read this from the CLI's embedded template.
- Fix: the Android patch step (`scripts/patch-android.mjs`, run in CI right after init) now copies `src-tauri/icons/android` over the generated `res` folder and checks the adaptive icon file was replaced. It stops the build if the icons are missing. 3 new unit tests on the real function, including that the icon set in the repository is complete.
- Tested here: 72 unit tests, the Rust tests, the whole patch script run on a fake generated project that holds default icon files (the foreground and adaptive icon end up byte for byte ours). A preview of the round, squircle and adaptive-circle shapes was looked at.
- NOT tested, needs the Android phone: how the icon looks on the home screen and in the recents list, and whether Android shows the old icon until the launcher restarts.
- Release notes: `docs/release-notes/0.2.8.md`.

## 0.2.9: built
Owner request (2026-11-05): build inline styles, and make the selection bar appear on Android too.
- Styles: highlight `==text==`, underline `<u>`, subscript `<sub>`, superscript `<sup>`, and colour `<span style="color: #hex">` from a fixed palette of eight real colour codes (each at least 3.4 to 1 contrast on every theme; a unit test checks that against themes.css). Buttons on the selection bar (a colour menu opens from the A button), and shortcuts for underline, highlight, subscript and superscript. Code: `web/inlinestyles.js` (rules, no editor code), `web/inlinemarks.js` (Tiptap marks), changes in `blocks.js`, `compose.js`, `editor.js`, `toolbar.js`, `strings.js`, CSS.
- Safety: the markdown reader silently drops html it does not know (checked in a browser test harness), so a paragraph with style markers is only editable when the markers read back identical after a parse and re-save (`styleSignature`); otherwise it stays raw, byte for byte. Colours outside the palette stay raw. Untouched notes are never rewritten.
- Colour is drawn with CSS classes, not inline styles, because the page policy forbids inline styles.
- Android selection bar: on a finger selection the page never gets a pointer-up (the system takes over), so the bar stayed hidden. Touch no longer waits for it, a cancelled pointer counts as finished, and for touch the bar sits 36 px lower to clear the native selection handles.
- Tested here: 80 unit tests, the whole browser suite (new tests: styles open as styles and stay byte for byte, editing keeps them, unsafe markers stay raw, every button and shortcut, sub/sup exclusive, styles inside callouts, toggles and tables, a simulated touch selection that fails without the fix, phone width), the Rust tests, and screenshots in light and dark, desktop and phone width.
- Obsidian: the docs confirm `==highlight==`. They do not name `<u>`, `<sub>`, `<sup>` or `<span style>`, so that those render is NOT confirmed by documentation and has not been opened in Obsidian. They state Obsidian does not render markdown inside html tags.
- NOT tested, needs the Android phone: the bar on a real finger selection and where it lands relative to the native Cut/Copy menu (the native menu cannot be controlled from the page, so it may overlap in some positions), and the 0.2.6 keyboard change, which has not been installed yet. Also not tested: opening a styled note in Obsidian.
- Release notes: `docs/release-notes/0.2.9.md`.

## Versions

| Version | What it adds | Status |
|---|---|---|
| 0.0 | Spikes: Tauri on Windows and Linux including pen pressure, an Android hello-world, an editor saving a markdown file | in progress. Builds for Windows, Linux and Android are made by GitHub and published as a release. Tested by hand: Linux (opens, mouse works) and Windows (mouse, touchpad, finger, pen pressure and eraser button work). Android phone: installs, runs and finger drawing works; the top bar was hidden under the status bar (fixed, not yet re-tested). Not tested: Android pen, Fedora, pen barrel button (does not work on the test pen in other apps either), tilt (not reported on the test pen), an editor saving a markdown file |
| 0.1 | Vault, sidebar tree, block editor and slash menu, autosave, logging, the AI off-switch, first-run disclosure, logo | built, not tested on a device (see above) |
| 0.2 | Editor completion, markdown source view, block gutter, themes, settings, update notice (converter dropped) | built, not tested on a device (see above); inline styles decided, not built |
| 0.2.1 | Polish from the first device test of 0.2 (see "0.2.1: built"). No new features | built, not tried on a device; comes before 0.3 |
| 0.2.2 | Folder switcher, five text sizes with scaling icons, "page" wording, toggle fix (see "0.2.2: built") | built, not tried on a device |
| 0.2.3 | Update check also finds pre-releases (see "0.2.3: built") | built, not tried on a device |
| 0.2.4 | Right-click menu with Rename on folders and pages (see "0.2.4: built") | built, not tried on a device |
| 0.2.5 | Move pages and folders by dragging (and Move to), block editing polish (drag copy, several blocks together, plus button, block type row), and an Undo-after-open data-loss fix (see "0.2.5: built") | built, not tried on a device |
| 0.2.6 | Phone keyboard covers the bottom of the page instead of sliding the whole screen away (see "0.2.6: built") | built, not tried on a device |
| 0.2.7 | Download button after Check now: the file for the system in the browser, else the release page (see "0.2.7: built") | built, not tried on a device |
| 0.2.8 | ScaleNote logo as the Android app icon (see "0.2.8: built") | built, not tried on a device |
| 0.2.9 | Inline styles (highlight, underline, sub, superscript, colour) and the selection bar on Android (see "0.2.9: built") | built, not tried on a device |
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
Owner request (2026-11-04): drag a block next to another one to make columns. Markdown has no columns, and the notes must stay plain markdown that Obsidian can open. A format has to be chosen first, for example an Obsidian-style callout block holding the columns, or a small html table. The choice affects what other programs show, so it needs the owner's decision before anything is built. Proposed home: after 0.3, as its own slice, once 0.2.3 has the drag preview and multi-select in place.

The owner's Notion screenshots (drop on the left or right edge of a block makes columns, vertical and horizontal drop lines, a half see-through drag preview) are written up in `docs/notion-reference-notes.md`. The format has to hold two or more columns of several blocks each.
