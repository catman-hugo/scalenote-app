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

## 0.2.10: built
Owner request (2026-11-05): the colour menu only had a few text colours and highlight was only yellow; the owner wants Notion's colour scheme for both, and an Obsidian convert button that drops the colours.
- Colours: Notion's palette (Gray, Brown, Orange, Yellow, Green, Blue, Purple, Pink, Red, and Default = none) for text AND background. The shades were measured from the owner's Notion screenshots (light and dark), so they are close but not guaranteed exact. Saved by name in one span, `<span class="sn-text-red sn-bg-yellow">`, with the shade chosen by the theme (pale backgrounds in light themes, dark ones in dark themes). A few text shades are slightly darker or lighter than Notion's so they stay readable on all eight themes (a test lists which). The 0.2.9 text colours (colour codes) are still read as the colour with the same name and are rewritten in the new form when the paragraph is edited.
- The plain `==highlight==` button (H) stays as it was: it is the one Obsidian understands. The owner was not asked whether it should go; it did not seem asked for.
- "Make a copy for Obsidian" in Settings (desktop only): `scalenote_core::obsidian` makes a new folder next to the notes folder ("<name> (Obsidian copy)", then "... 2" and so on, never replacing), converts every page (background colour becomes `==text==`, text colour removed, other syntax byte for byte, code untouched) and copies the other files. Hidden folders and links are skipped. A half-made copy is removed if something fails. The notes folder is never changed.
- Found while testing: the first version of the converter took 25 seconds on a note with 20 000 unclosed spans; it is now a single pass with a depth limit and runs in under 0.1 s (test included).
- Found by the Windows build: on Windows the notes folder path comes back in the long `\\?\C:\...` form, so the message would have shown that prefix. It is now dropped for display (`friendly_path`, tested), and the two copy tests compare real places instead of spellings.
- Tested here: 84 unit tests (new: palette data checked against themes.css, style.css and the Rust name list; contrast of every shade on every theme), 49 Rust tests (15 new on the real converter and a real folder copy, including links, odd files, a second copy, hostile input), the whole browser suite (new: palette menu, text and background together, mixed backgrounds, 0.2.9 colours, shades per theme including a dark theme on a light system, the Settings button and its absence on Android), screenshots in light and dark.
- NOT tested, needs real devices: the new Tauri command (`export_obsidian_copy`) is compiled only by GitHub's build; making a copy on Windows and Linux with a real notes folder; opening the copy in Obsidian; the colour menu and the selection bar with a finger on the Android phone. The button is hidden on Android because the notes live in the app's private storage there.
- Not done: Notion's "Recently used" colour row.
- Release notes: `docs/release-notes/0.2.10.md`.

## 0.3.0: built
Owner request (2026-11-05): "build 0.3.0". Scope he chose: search and command palette, and delete with trash. Wikilinks, backlinks, tags, favorites, covers, export and page history are the next 0.3.x slices (not started). Columns are still waiting for a format decision. The plan is in `docs/v0.3-plan.md`.
- Trash (`scalenote_core::trash`): Delete moves a page or folder to `<notes folder>/.trash/<id>/` with small text files for its name, where it came from and when. Restore returns it (parent gone: top level; name taken: "(restored)" added; nothing replaced). Delete forever and Empty trash remove for good, after a question in the box. The id is digits and "-" only, so it cannot point outside the trash. A damaged entry cannot be used to reach other files (tested). The vault root and `.trash` itself cannot be deleted. No automatic emptying.
- Search (`scalenote_core::search`): no index; each search reads the pages. Case-insensitive, letters of any language, every word must be in the title or the text, titles rank first (exact, then contains), the matching line comes back as pieces marked match / no match so the interface never counts letters. Limits: query 200 letters and 8 words, 50 results, 2,000 collected, 512 MiB read, notes over 8 MiB or not valid text skipped, no hidden folders (so no trash), no links followed. The command does not keep the vault locked while it searches, so saving is never blocked.
- Interface: Search box on Ctrl+K and a Search button (touch), with the ARIA combobox/listbox pattern; Enter right after typing waits for the answer; answers that arrive late for an older query are dropped. Delete in the right-click and long-press menu, Delete key on a page or folder in the list, Trash dialog. Ctrl+K still adds a link when text is selected in a page.
- Found while testing and fixed: `has_md_extension` sliced a name at a fixed byte offset and would panic on a name like "aéé" (it is used for every file in the list); pressing Enter on a button in Settings closed the box (a keyboard click has position 0,0 and looked like a click outside).
- Tested here: Rust 73 core tests (24 new: trash and search on real folders, links, damaged entries, hostile and odd queries, 3,000 pages searched in 0.37 s), 84 unit tests, the whole browser suite (new: delete from the menu and the key, folder delete, restore, name clash, already-gone item, typed-then-deleted text, confirmations and focus, Ctrl+K, ranking, snippet marks, late answers, text from pages shown as text, failed search, commands, link shortcut kept, phone with touch), screenshots in light and dark, desktop and phone width.
- NOT tested, needs real devices: the six new Tauri commands (`trash_entry`, `trash_list`, `trash_restore`, `trash_delete_forever`, `trash_empty`, `search_vault`) are compiled only by GitHub's build, and the browser tests use a stand-in backend; moving to the trash and restoring on a real Windows and Linux folder (including a folder with Obsidian files); the Search button, the box with the on-screen keyboard and the long-press Delete on the Android phone; search speed on a really big notes folder.
- Not done: jumping to the match inside the page; search in picture names; deleting pictures with their page; automatic emptying of the trash; undo button on the "moved to the trash" message.
- Release notes: `docs/release-notes/0.3.0.md`.

## 0.3.1: built
Owner report (2026-11-05): on Android the arrow at the top left does nothing, and every update means deleting the old app and going through the disclaimer and folder choice again. He wants updating as simple as possible, Android first.
- Cause found: the Android job builds a debug app, and the debug key is created fresh on every GitHub runner, so each build has a different signature and Android refuses to install it over the old one. Deleting the old app also deletes the notes, which live in the app's private storage on Android.
- Fix: the build now puts one fixed test key (kept as the GitHub secret `ANDROID_DEBUG_KEYSTORE_BASE64`, set by the owner in the repository settings) where the debug build looks for its key, and prints the SHA-256 of the key that signed the file, so two builds can be compared. Without the secret the build still works but prints a warning and cannot update an older build.
- The arrow next to the vault name is not drawn on Android (the button was already disabled there because the folder is fixed).
- ONE LAST REINSTALL is needed when going from a build before 0.3.1 to the first build signed with the fixed key. Notes in the app's private storage go with the old app.
- NOT tested here (needs the owner): the signing itself. The build runs only on GitHub. It is proven when two builds in a row show the same SHA-256 line and the second one installs over the first on the phone without deleting anything.
- Not done: an in-app install button (download inside the app and open the installer). It needs native Android code and a permission to install apps, so it is its own slice.
- Release notes: `docs/release-notes/0.3.1.md`.

## 0.3.2: built
Owner request (2026-11-05): on Android dragging is laggy, and a drag attempt is seen as a right click. He asked for a quick double tap or a longer hold as the right click, and for new pages and folders to be made at the top level when all folders are closed.
- Finger gestures in the page list (`treedrag.js`): a quick tap opens; moving at once scrolls; holding still 350 ms picks the entry up (short buzz, highlight, scrolling switched off for that touch) and moving then drags it, with the preview above the finger and edge scrolling; holding still 800 ms opens the menu; two taps within 350 ms on the same entry open the menu (matched by path, because the first tap redraws the list), and a folder is not renamed by them. The phone's own long-press menu is dropped inside the list (a finger-made, trusted contextmenu only; mouse, pen and the menu key still work). The click after a held menu or a drag is swallowed.
- Lag and robustness for mouse and pen: moves are handled once per screen refresh, the preview is placed with a transform, the whole-page selector rule was narrowed, a `pointercancel` handler was added (before, a drag the system interrupted left the list stuck), and scrolling is switched off while a pen drag is going.
- New page and folder go into the selected folder only while it and its parents are open (`creationFolder`); otherwise at the top.
- Tested here: the whole browser suite, with new tests that send real touch input through the browser's own touch protocol (pick up and drop on a folder, long hold menu, two taps, scroll first, quick tap opens), the creation rule, and a mouse drag with an interruption. 84 unit tests.
- NOT tested, needs the Android phone and tablet: how the thresholds feel (350 ms, 800 ms, 350 ms, 10 px), whether the phone's own long-press menu really no longer appears (the test browser does not make one), the buzz, edge scrolling on a long list, and how smooth dragging is. The numbers are constants at the top of `treedrag.js` and easy to change.
- Not done: a double tap on a page on a phone cannot work, because the first tap opens the page and closes the list.
- Release notes: `docs/release-notes/0.3.2.md`.

## 0.3.3: built
Owner request (2026-11-06): "Get started on v0.3.3" (wikilinks and backlinks, first slice of the 0.3 plan after the reorder in `docs/v0.3-plan.md`).
- `[[Page]]`, `[[Page|text]]`, `[[Page#Heading]]`, `[[Page#^block-id]]` and `[[#Heading]]` are links. In the page they are one clickable piece (`wikilinks.js`, an editor atom that stores and writes back the exact text), so a save cannot change them. Before, any block with `[[` was a grey "kept exactly as written" box.
- Still raw, on purpose: `![[embeds]]`, links in code, links in table cells and callout or toggle titles, an unclosed `[[`, `\[[`, and a block with more than 5,000 links. `blocks.js` takes well formed links out before its unsafe-syntax check, and `compose.js` keeps a block raw if the links in it would not come back exactly (`wikilinkSignature`).
- Which page a link means (`wikilinkrules.js` in the interface, `links.rs` in the core, same rules, one shared case file `tests/fixtures/wikilinks.txt`): no case, no `.md`, folders must match the end of the path, ties go to the same folder, then fewest folders, then alphabetical.
- Typing `[[` opens a page picker (the slash menu's list, reused). Anything typed after `#` or `|` is kept. A last row links to a page that does not exist yet. Typing a whole `[[..]]` turns it into a link. The short name is written when it is unambiguous, else the path.
- Clicking a link opens the page, makes it if it is missing (top of the vault, or the named folder if it exists), and scrolls to a heading or block id. A double click makes the page once. A missing heading or block shows a short message.
- "Linked from" list under each page (`backlinks.js`): the pages with a link to this one, the line of the first link with the link marked, and a count when there are several. New Rust command `backlinks` (`Vault::backlinks`): no index, same limits as search, no vault lock held, asked for 300 ms after a page opens.
- The list has a Hide button and a Settings switch (`showBacklinks`, on by default, saved with the other settings); off means no backend call. Changing the default is one line in `loadSettings` (`main.js`).
- Fixed on the way: the editor had no `white-space: break-spaces`, so a space typed at the end of a line or right after a link was saved as a no-break space (U+00A0) in the file. The CSS now has it (found by a new test).
- Tested here: 90 interface unit tests (the link rules against the shared cases, blocks and rich blocks), 83 Rust tests in the core (the rules, backlinks over real folders including the trash, same-name pages, hostile input, 2,000 pages in about 20 ms), and the whole browser suite with new tests: links drawn and untouched on save, picker, hand-typed links, delete and undo, following and creating pages, headings and block ids, the backlinks list and its failure message, quick page switching, bold and italic links, a page of 6,000 links, a finger tap.
- NOT tested, needs a device: the picker and link taps with the Android keyboard and a finger; the Tauri `backlinks` command (compiled only by CI); how slow "Linked from" is on a phone with a big folder.
- Not done: renaming or moving a page does not rewrite links to it (they turn dashed); links cannot be edited in place; `[[Page#` does not list headings; embeds (`![[..]]`) are still raw. Tags and favorites came later, as 0.3.6.
- Release notes: `docs/release-notes/0.3.3.md`.

## 0.3.5: built
Owner request (2026-11-06): "Get on with v0.3.5" (covers, as planned and as confirmed earlier: optional, a Settings switch, and per page his own image or none). The plan then listed tags and favorites as 0.3.4; they were not started, and the owner later moved them to 0.3.6 (see "0.3.6: built"). There is no 0.3.4 build.
- Setting `showCovers`, **off by default**. When off, no cover element, picture or "Add cover" button exists in the page (the area is created only while shown). The page's own cover line stays untouched in the file.
- A cover is one property line in the page's frontmatter, `cover: attachments/name.png`, and the picture is a normal attachment saved with the existing picture command (same type and size checks, 10 MB). `coverrules.js` reads, sets and removes that line and leaves every other byte of the block alone; it refuses (and the page says so) when the `cover` entry is a list, block or otherwise spread over lines, when the block is not closed, or when the path is not a picture inside attachments.
- Cover area (`cover.js`) above the text: picture (200 px high, 140 px on a phone, cropped to fill, solid frame, no overlay), then "Change cover" and "Remove cover", or just "Add cover" when there is none. A missing picture file shows a message and the Remove button. The markdown text view hides it and shows the line as written. Saving goes through the normal autosave (a change of the properties block is a change of the page).
- Tested here: 97 interface unit tests (the line rules including CRLF, odd and huge input), and browser tests for off by default and the switch, showing, adding, changing and removing with the real file chooser, other properties kept in order, a refused file, a list-valued entry, a missing picture, the text view, and a phone width. Design screenshots, light and dark, desktop and phone.
- NOT tested, needs a device: choosing a picture with the Android file chooser, how large pictures from a phone camera behave (10 MB limit), and how the strip looks on the real screens.
- Not done: moving or resizing the picture, stock images, deleting the picture file when a cover is removed, a cover for folders, an "Add cover" entry in the search box.
- Release notes: `docs/release-notes/0.3.5.md`.

## 0.3.6: built
Owner request (2026-11-06): "Make 0.3.4 now but label it 0.3.6 ... The existing 0.3.6 moves to 0.3.7". So this is the tags-and-favorites slice, numbered 0.3.6; export and page history are now 0.3.7; there is no 0.3.4. `docs/v0.3-plan.md` and the table below are changed to match.
- Tags: `#name` in a page (Obsidian's rules, `tagrules.js` in the interface and `tags.rs` in the core, one shared case file `tests/fixtures/tags.txt`) and `tags:` in the properties (`tags: a, b`, `[a, b]` or a list; Rust only). A tag stays plain text; `tags.js` only marks it and a click opens the Tags box. Before, any block with `#word` was a grey "kept exactly as written" box. Now a well formed tag is edited like text; `blocks.js` takes tags out before its unsafe-syntax check, and `compose.js` keeps a block raw if its tags would not come back exactly (`tagSignature`). A `#word` that is not a tag (`#1984`, `#tag<b>`) still keeps its block raw. Tags in table cells, callout titles and toggle titles stay raw as before.
- Tags box (`tagsdialog.js`, `tagindex.js`): all tags with page counts, nested tags counted under their parents, no regard to case, a filter, the pages of the chosen tag (a click opens the page). Opened from the page list ("Tags"), the search box ("Open tags") or a click on a tag in a page (the page is saved first so a tag just typed is in the list). At most 300 tags and 300 pages are drawn, with a note.
- New Rust command `page_index` (`Vault::page_index`): tags and favourite mark of every page, no stored index, same limits as search, no vault lock held. It is read after every page-list refresh (for the Favorites list) and when the Tags box opens.
- Favorites: `favorite: true` in the properties, set and removed by the star next to the title (`propertyrules.js`, which now also does the cover line: `coverrules.js` was moved onto it, its tests are unchanged and pass). A Favorites list above the page list shows them, and is not drawn while empty. The star is switched off in the markdown text view. A `favorite` entry written as a list or over several lines is never edited; the page says so. "Add or remove this page from favorites" is in the search box.
- Fixed on the way: the sidebar footer (Settings, Tags, Trash) now wraps to a second line instead of cutting a label short.
- Tested here: 115 interface unit tests (tag rules against the shared cases, hostile input, tag lists, blocks) and the Rust core tests (tag rules against the same cases, properties in all forms, the index over real folders including the trash, a binary and a huge page, 100,000 tags), and the whole browser suite (175 tests) with new tests: tags marked and saved exactly as typed (also at the start of a line, in headings, lists and quotes, none in code), the Tags box (counts, nested, filter, empty, failure, click on a tag, open a page), the star (set, remove, other properties and text kept, list-valued entry refused, text view), the Favorites list, the search-box commands, a phone width, and an index that fails. Design screenshots, light and dark, desktop and phone.
- NOT tested, needs a device: the Tags box and the star with a finger and the Android keyboard (typing `#`); the Tauri `page_index` command (compiled only by CI); how slow reading the whole folder after every list refresh is on a phone with a big folder.
- Not done: tag suggestions while typing `#`, renaming or merging tags, editing the `tags:` property from the interface (use the markdown text view), a favourite toggle for a page that is not open, a refresh of the Favorites list when another program changes a page (it follows the next page-list refresh), the folder-level or tag colours.
- Release notes: `docs/release-notes/0.3.6.md`.

## 0.3.7: built
Owner request (2026-11-06): "Build 0.3.7" (export and page history; the repo plan had no details, so this follows the v1 spec: export to markdown and PDF, older versions at sensible moments, look at one, compare with the current page, restore all or parts, thinned over time).
- Page history (Rust: `history.rs`, hooked into `Vault::write_note`): the replaced text is copied to `.history/<key>/<ms>.md` before the atomic write. Best effort: a failed copy never fails a save. Rules and caps are in `docs/v0.3-plan.md`. Commands `history_list`, `history_read`, `history_keep_now`, `history_clear`. Hidden from the page list, search, links, tags and the Obsidian copy.
- History box (`historydialog.js`, `historyrules.js`): versions with time and size; "Changes" (line comparison, unchanged lines folded, a tick per changed part) and "Whole text" views; put back chosen parts or the whole version. The page is saved first, the page on disk is the comparison base, and at restore it is read again and nothing is written if it differs. `history_keep_now` keeps the current text first so a restore can be undone; the restored text keeps the page's current `id:`. Opened by the clock button, or "Show the history of this page" in the search box. Settings: "Delete all history" (two clicks).
- Export (`export.rs`, command `export_page`): the page (converted like the Obsidian copy) and the pictures it names go to a new folder in `<notes folder> (exports)` beside the notes folder. The interface sends only the page path. Plain picture names only, real files only (no links), picture content checked, 10 MB each, 200 pictures; a half-made folder is removed; nothing is replaced; refused on Android. In the search box: "Export this page as markdown".
- Print / PDF: "Print this page or save it as PDF" calls the system print window; a print style sheet shows only title and text. Not offered on Android.
- DEVIATION from the spec: history is in `.history` inside the notes folder, not "next to the vault" (see DECISIONS.md).
- Tested here: Rust core tests (history: thinning, caps, gap, rename, hostile ids and file names, hidden from listings; export: pictures, links, hostile paths, never replaced, exports folder that is a link), 121 interface unit tests (line comparison, choosing parts, id handling), and the whole browser suite with new tests for the history box (list, changes, restore a part, restore all, empty, page changed, delete all), export (done, failure) and print (print media hides the page list and buttons, a PDF is produced). Design screenshots, light and dark, desktop and phone.
- NOT tested, needs a device: the four history commands and `export_page` as Tauri commands (compiled only by CI); the History box with a finger on an Android phone; the print window and a saved PDF on real Windows and Linux; speed of the line comparison on a very long page; history size on a big folder.
- Not done: whole-folder export, word-level comparison, a history size setting, history for pages changed by other programs.
- After the owner's first test on an Android tablet (2026-11-06; history list, changes view and restore all worked) the box was tidied (released as 0.3.8, because 0.3.7 was already published; see "0.3.8: built"): the put-back buttons are hidden until a version is chosen, a lone version opens at once, the page properties at the top are one folded note, and a failed copy of an older version is now written to the log (`Vault::take_history_problem`, read by `write_note` in the app; the save is still never failed by it; core test added). Not done: telling the person inside the History box that copies are failing.
- Release notes: `docs/release-notes/0.3.7.md`.

## 0.3.8: built
Owner request (2026-11-06): the History box tidy-up was merged after the 0.3.7 release had been built, so it ships as 0.3.8 (a version bump only; the changes are in "0.3.7: built", last bullet). Release notes: `docs/release-notes/0.3.8.md`. Not tried on a device yet; the changes were already seen working in the tidy-up's browser tests.

## 0.4.0: built
Owner request (2026-11-06): "start development of v0.4.0". The repo had no plan for 0.4, so it was cut into slices from the v1 spec (`docs/v0.4-plan.md`), and the owner chose "Canvas page: pen + eraser" as 0.4.0.
- Storage (Rust, `canvas.rs`): the drawing of `Name.md` is `Name.canvas.json`; commands `read_canvas` and `write_canvas` (atomic, 32 MiB limit, exact-version conflict check, a link is never followed, only for an existing page). The drawing follows its page through rename, move, trash and restore (`rename_with_sidecar`, the trash item's `canvas` file; a stale drawing is never replaced), and a folder carries the drawings inside it.
- Rules (`canvasrules.js`, tested alone): format 1 read strictly (any bad stroke makes the whole drawing read-only and never saved over; a newer format is told apart), one stroke per line when written, limits (20,000 strokes, 5,000 points per stroke, 1,000,000 points), eraser geometry, pressure to width, undo/redo history.
- View (`canvasview.js`): pointer events (pen and mouse draw, finger pans and pinch-zooms, "Finger draws" switch, barrel button or eraser end erases, wheel, Ctrl+wheel, space), a toolbar (pen, eraser, move, six colours from the theme's text colours, three widths, undo, redo, Finger draws, Show all), redraw once per screen refresh. The page's Canvas button, the search-box command and the leave-on-page-change rule are in `main.js`; the drawing has its own autosave.
- Tested here: Rust core tests (117, with 8 new for the drawing storage: round trip and version checks, hostile paths, too large, not text, a link, rename and move carry it, a stale drawing stops a rename, trash and restore carry it, a folder), the interface unit tests (new `canvas.test.mjs`), and the whole browser suite with new tests (switch and save beside the page, pen pressure kept, colour and width, eraser with undo and redo by button and key, finger pans and Finger draws, barrel button, unreadable and newer drawings read-only and never written, change elsewhere stops saving, leaving for another page saves first, the command, a long scribble and rapid clicks, phone width). Design screenshots, light and dark, desktop and phone.
- NOT tested, needs a device: everything with a real pen (pressure, tilt, the barrel button and eraser end, palm rejection with the pen near the screen), two-finger zoom with real fingers, how the sheet feels on the Android tablet (lag, redraw speed with thousands of strokes), the Tauri commands `read_canvas` and `write_canvas` (compiled only by CI), speed of the full redraw on a big drawing.
- Not done: highlighter, shapes, sticky notes, lasso, drawing over text, split mode, PDF import, erasing part of a stroke, the drawing in the page history, export or print of a drawing, a rebuild of the sheet when another program changes the file.
- Also fixed: on a phone the page title was squeezed to a few letters by the top bar (star, history, Canvas/Text, status); the title now keeps at least 5.5rem and the status is cut short with an ellipsis (a test checks the title width).
- Release notes: `docs/release-notes/0.4.0.md`.

## 0.4.1: built
Owner request (2026-11-06): "Continue onto v0.4.1". Slice from `docs/v0.4-plan.md`: highlighter, shapes, sticky notes, lasso (select, move, delete), pen button mapping as a setting.
- File format (`canvasrules.js`): a drawing now holds items of several kinds (pen and highlighter strokes, line, arrow, rectangle and ellipse shapes, sticky notes). A drawing with only pen strokes is still written as format 1 (key `strokes`), so a 0.4.0 app on another device can open it; any other drawing is format 2 (key `items`). Both are read strictly as before; format 3 and up is "newer". Note text is a string of at most 2,000 characters, a note is 20 to 2,000 units wide and high, and the 20,000 limit now counts every item. No Rust change: `canvas.rs` never looked inside the file.
- View (`canvasview.js`): toolbar gains select (lasso), highlighter, line, arrow, rectangle, ellipse, sticky note and a delete-selection button. A loop selects items with at least half of their points inside it; a press on the selection moves it, anywhere else starts a new loop; Delete, Escape, the toolbar button. The highlighter is one wide see-through path (4 times the pen width). Shapes are dragged out; a tap smaller than 4 pixels draws nothing. The eraser removes a shape when it touches its outline (not its empty middle) and a note when it touches the note. Undo and redo also cover moves and note text.
- Sticky notes: the note tool puts a text box over the sheet; the note is added when it has text (a stray tap leaves nothing), and ends with Escape, Ctrl+Enter, a click elsewhere, leaving the page, or hiding the window. Tapping a note with the note tool edits it. Text is only ever put in a text box and drawn with `fillText`, never as html.
- Pen button setting (Settings, "Drawing"): the side button of a pen erases (default), selects with a loop, or does nothing. The eraser end always erases.
- Tested here: unit tests for the new rules (`canvas.test.mjs`, 19), and new browser tests for the highlighter, both file formats (a 0.4.0 file opens and grows; a pen-only drawing keeps format 1), each shape, a stray tap, erasing a shape, a sticky note (markup in the text is not read as markup, edit, undo, leaving mid-typing), selecting, moving, deleting, clearing the selection, a pen drawing the loop, the pen button setting in all three states, using every tool in any order, a huge note, and opening a file with every kind of item without changing it. Design screenshots, light and dark, desktop and phone.
- NOT tested, needs a device: a real pen on the tablet with the new tools (the side button with each setting, drawing a loop with a pen), typing a note with the Android on-screen keyboard (does the box stay in view, does the page jump), highlighter and shapes feel and speed with many items.
- Not done: resizing a note or a shape, changing the colour of what is selected, copy and paste of a selection, text on a canvas outside a note, snapping, flowchart connectors, drawing over text, split mode, PDF import.
- Also: the occasionally failing search-box browser test ("typing finds pages by title and text", failed on both a Linux and a Windows runner) was a race in the test, not in the app: it pressed Escape and opened the box again before the first box had closed, so the next typing went into a box that was about to go. The test now waits for the box to be closed. If it fails again, the cause is something else.
- Release notes: `docs/release-notes/0.4.1.md`.

## 0.4.2: built
Owner request (2026-11-06), after trying 0.4.1 on the tablet: "solve the screen being too thin", "some drop downs or toggles would be nice in the drawing tools bar", and "apply the same text/icon logic from the new folder and new page, to the trash and settings and tags". The tidy-up takes the number 0.4.2, so the later slices move up by one (see `docs/v0.4-plan.md`).
- Drawing toolbar (`canvasview.js`): menus for shapes, colour, line width and "more" (Finger draws, Show all), each under its button, showing the current choice; one line on a wide window, two on a phone (was three). The menus close on choosing, Escape, a press elsewhere or the button again. Nothing drawn or saved changes.
- Sidebar foot (`index.html`, `style.css`): Settings, Tags and Trash are outlined buttons with an icon and a label on one line, like New page and New folder; the label is hidden, leaving the icon and the accessible name, below 17 rem (the same rule as New page and New folder).
- Tested here: the existing canvas browser tests, changed only to open the menus first, and new ones for the toolbar height, the shape menu (open, choose, Escape, outside press, button again, shape used last), the colour and width menus, the more menu, menus inside the window on a phone and off for a drawing that cannot be read, and the sidebar foot buttons (icon, label, outline, same height as New page, one line, label hidden when narrow). Design screenshots, light and dark, desktop, tablet-sized and phone.
- NOT tested, needs a device: how the menus feel with a real pen and finger on the tablet (size of the touch targets, opening and closing), and whether the drawing area is now tall enough on the real tablet. The sidebar width on the tablet is the owner's setting; with the list open the sheet is narrower, and hiding the list (the menu button) gives it the full width.
- Release notes: `docs/release-notes/0.4.2.md`.

## 0.4.3: built
Owner request (2026-11-06): "make the pen thickness a 5-stop slider ... just like onenote has", and "when i click a wikilink, i see the id of the page ... i also see the page id in the plain markdown ... as long as you are using the app, you never see the page id". The tidy-up takes the number 0.4.3, so the later slices move up by one again (see `docs/v0.4-plan.md`).
- Line width (`canvasrules.js`, `canvasview.js`): `PEN_WIDTHS` is now 2, 4, 6, 8, 12 (the old thin, medium and thick stay as stops 0, 1 and 3). The width menu holds a range slider with five stops and a line that shows the width; it stays open while the slider moves. A width in a file that is not a stop is kept and shown at the nearest stop (`nearestWidthStop`). The file format did not change.
- Page id hidden (`blocks.js`, `compose.js`, `main.js`, `historydialog.js`, `search.rs`): `hideNoteId` / `restoreNoteId` take the `id:` line out of the plain markdown view and put it back on save (untouched text gives the same bytes; a frontmatter that held only the id is removed whole and restored whole). The same function hides it in the history "Text" view. The search skips the id line (`without_page_id`, same length so snippet positions stay right).
- Cause found for the link click: I could not reproduce it for a normal page (the rendered page never showed the id). It did show for a file that starts with a byte-order mark: the properties block was not recognised and was shown as a kept-as-written block. `splitFrontmatter` now accepts the mark (kept in the properties, saved back unchanged). Also the safety net that shows a whole page as one kept-as-written block now keeps the properties out of that block.
- Tested here: new unit tests (byte-order mark, hide/restore byte for byte for LF, CRLF, mark, extra properties, an id-only page, an edit while hidden, the fallback), a new Rust test for the search, and browser tests for following a link to a normal, a marked and an odd page, the plain markdown view (hidden, other properties shown, typed text saved with the id back in place), a page holding only an id, the slider (five widths drawn, menu stays open, keyboard, eraser goes back to pen, older width shown at the nearest stop). Existing width tests changed only to use the slider.
- NOT tested, needs a device: the slider with a real pen and finger; the owner's real page where the id showed after a link click. If it still shows there, send a screenshot and the first lines of that file in a text editor, because the cause may be a shape I did not find.
- Not changed: the page id still exists in the file (history folders are named by it). Editing the raw file outside the app shows it.
- Release notes: `docs/release-notes/0.4.3.md`.

## 0.4.4: built
Owner requests after trying 0.4.3 on the tablet (2026-11-07). 0.4.3 had already been merged and tagged with the slider and the hidden page id, so this work ships as 0.4.4. The empty-page fix below belongs to the page id work of 0.4.3.
- Second cause, found from a tablet screenshot: a page with an id and no text did not open as an empty page (the blank line after the properties made the open-and-save check fail), so it was shown as an empty kept-as-written block. `loadNote` now treats a body of only blank space as an empty page and keeps those blank bytes in `parts` so saving untouched gives the same bytes. Tested with a unit test and a browser test.
- Shape grid (owner request from the tablet): `snapShapes` setting (on by default, Settings > Drawing). Shape corners are put on a 20 unit grid in drawing space (`snapToGrid`, `SHAPE_GRID` in `canvasrules.js`; `shapePoint` in `canvasview.js`) while drawing, so the same grid applies at every zoom. Only new shapes are affected; the file format is unchanged (corners are just numbers). Tested: unit test, and a browser test with two shapes drawn a few pixels apart that share an edge, the setting turning it off, and the choice being saved. The old exact-corner shape test now runs with snapping off. Not tested on a device. Also: the width preview bar has rounded ends.
- Pen colours (owner request, a OneNote screenshot): `PEN_COLOURS` is now the 16 OneNote pen colours in picker order (6 + 6 + 4), shown as a six-column grid. Fixed colours live in `--pen-*` in `style.css`; ink still follows the theme. The old names (ink, red, blue, green, orange, purple) stay valid and keep their meaning, so no file is refused; they only draw in the brighter colour. A file with a new colour name (yellow, pink, ...) is refused as a whole by 0.4.2 and older (opens read-only there). Tested: unit tests (an unknown colour is now "teal"), the existing colour tests, screenshots light and dark on desktop and phone. Not tested on a device.
- Pinch zoom (owner report, tablet screenshots): the drawing drifted while zooming with two fingers. Cause: the point of the drawing under the fingers was looked up again on every move, in a view that had already changed. It is now found once when the pinch starts (`beginTouchMove`). Tested with a browser test that fails on the old code (a mark under the fingers stays there when zooming in and out). Not tried on a device.
- Sticky notes drawn as boxes (owner request): the note tool now works like a shape (drag a box, corners on the grid when snapping is on); a tap shows "Drag to draw the size of the note." and tapping an existing note still edits it. The stored size is what was drawn and only grows if the text needs more room (`noteTextHeight`; the old `noteHeight` is gone). A tap on a note with the loop tool selects it, and a handle on its bottom right corner resizes it (`resize` gesture, one undo step through the existing `edit` history entry). File format unchanged (`w` and `h` were already stored). Tested: unit test for `noteTextHeight`, browser tests for drawing the box, the grid, resizing, the minimum size, undo, and the old note tests redone with boxes. Not tried on a device (a finger cannot draw by default; use a pen or turn on finger drawing).
- Also: the width preview bar has rounded ends.
- Release notes: `docs/release-notes/0.4.4.md`.

## 0.4.5: built
Owner requests after trying 0.4.4 (2026-11-07). Three parts, one branch (`feature/v0.4.5-paper-and-icons`).
- Lasso moves snap (`moveAnchor`, `snappedShift` in `canvasrules.js`, `moveGesture` in `canvasview.js`): the first shape or note corner in the selection is put on the 20 unit grid and everything selected moves by the same amount, pen lines included. Follows the "Snap shapes to a grid" setting. Tested: unit tests and a browser test that fails when the snapping is removed.
- Paper and page colour (`canvasrules.js`, `canvasview.js`, `icons.js`, `strings.js`, `style.css`): two toolbar menus like OneNote's View tab. Paper: none, four rule line spacings with a red margin line, four grid sizes (spacings 20, 40, 60, 80 drawing units, multiples of the snap grid). Page colour: sixteen colours and "No colour", stored by name and tinted for the theme (multiply on a light theme, a 75 percent mix on a dark one), so all eight themes work from one list. New drawings are plain. Saved as drawing file format 3 only when paper or page is set; ScaleNote 0.4.4 and older open such a drawing read-only (nothing is lost). Changes go through undo and redo. Tested: unit tests (format round trip, unknown values refused, spacings, tints, undo), browser tests (menus, drawn lines measured from pixels, save and reopen, four themes, read-only drawing, rapid clicking and far zoom), screenshots in light, dark, sepia, midnight, forest and sage on desktop and phone.
- Folder icons (`foldericons.js`, `iconmenu.js`, `sidebar.js`, `foldericons.rs`): right-click or long-press a folder, "Icon": style (folder, notebook, line) and one of OneNote's sixteen section colours, or none. Stored in one small hidden file, `.scalenote/folder-icons.json`, so it syncs with the vault and no note is touched. Written atomically with a version check (one retry on a conflict) and a 256 KiB limit; a link in place of the file or folder is not followed. The file is untrusted: values are checked against lists, a damaged or newer file is left alone and shows plain folders, entries this version does not understand are kept when another folder changes, a folder named `__proto__` works. A renamed or moved folder keeps its icon and so do the folders inside it. A deleted folder's entry is left in the file (harmless, and a restore keeps the icon). Tested: 6 Rust tests (version check, size, link, hidden from the page list), 11 unit tests, 8 browser tests, screenshots light, dark, sepia, midnight, forest and sage on desktop and phone. The Tauri side (`read_folder_icons`, `write_folder_icons` in `src-tauri/src/lib.rs`) could not be compiled in this environment (no GTK libraries); it is a copy of the drawing commands and is built by the GitHub release build.
- NOT tested, needs a device: the lasso snapping with a pen on the tablet; paper and page colours on the real screen; the Icon menu with a long press on Android; the hidden file on a real Windows/Android vault; the packaged app (built by the release workflow).
- Not done: "Zoom to 100%" (owner said no). Handwriting to text was asked about (an in-app version of Gboard "Write in text fields"); it needs its own recogniser and is not scheduled.
- Release notes: `docs/release-notes/0.4.5.md`.

## 0.4.6: built
Owner request after 0.4.5 on the tablet (2026-11-07), bundled with split mode, which was chosen from the plan because it needs no file format decision.
- Highlights are drawn behind everything (`paintItems` in `canvasview.js`): layers back to front are sticky note boxes, highlights (also over a note), shapes and pen lines, then the text of notes. The file keeps the order things were drawn in; only the picture changed, so older versions and older drawings are not affected. A highlight in progress is drawn in the same layer.
- Tidy highlights (`highlightFigure`, `figureOf` in `canvasrules.js`): when a highlighter stroke covers a rectangle, ellipse or sticky note (at least 60 percent of it inside) and its farthest point is not more than half its drawn width plus 12 units outside, it is cut at the figure's edge when drawn. A stroke that goes further out, or lies mostly outside, is left as drawn. The smallest fitting figure wins. The stroke in the file is not changed. Judged from at most 64 sample points so long strokes stay fast.
- Split mode (`main.js`, `index.html`, `style.css`): a "Split" button next to Canvas shows the text on the left and the drawing on the right (text above the drawing below 700 px wide). The drawing is the same one as in the Canvas view: switching between Split, Canvas and Text keeps it loaded and saved, and both are saved by their own autosave. The cursor stays in the text when Split opens. The markdown view is not offered beside a drawing. A command "Show the text and the drawing of this page side by side" is in the search box. New setting Drawing > "Open pages in" (Text, Canvas, Split; Text by default, anything else read as Text): a page opens in that view. No file format change.
- Tested here: 5 new unit tests, 3 browser tests for highlights (pixel checks; they fail when the behaviour is removed, checked by hand) and 6 for split mode and the setting (layout measured on desktop and phone, drawing and typing in both halves, switching, the setting saved and a damaged value), screenshots light and dark on desktop and phone.
- NOT tested, needs a device: the feel with a real pen and tablet; whether 12 units of slack is the right amount; Split with a pen and the on-screen keyboard (the half that holds the text may be small on a phone with the keyboard open); the Open pages in setting on the tablet. Overlapping sticky notes: the text of a lower note can show through a note above it (text is one layer above all boxes).

## 0.4.7: built
Owner request after 0.4.6 on the tablet (2026-11-07): do the same for the pen as for the highlight; removing the square must not reveal the overshoot; one long stroke that strays at the end must not become fully visible.
- The cut is saved in the stroke (`clip` on pen and highlighter strokes: `{kind: rect|ellipse, x, y, w, h}`) by `tidyStroke` in `canvasrules.js` when the stroke is finished. Painting uses the saved clip only (`paintClipped` in `canvasview.js`), nothing is computed from the figure at paint time any more, so removing or moving the figure changes nothing. A stroke in progress is shown as it will look after lifting the pen.
- Stray parts: points more than half the drawn width plus 12 units outside the figure are a stray. A stray runs from where the line leaves the figure to where it comes back and becomes a plain stroke of its own (no clip); the rest becomes one or more clipped strokes that share the end points, so the line stays joined. Several strokes from one gesture go in as one undo step (`add` in `DrawingHistory` may be a list; `edit` may be a list).
- A pen stroke only gets a clip when one of its points is really outside the figure; a highlighter stroke always gets one (the wide line would otherwise overflow the edge). So most pen lines in a note are stored as before.
- Format 4 is written only when a stroke has a clip (otherwise 3, 2 or 1 as before); a clip in a file older than 4, or a bad clip, makes the drawing read-only; 0.4.6 and older open format 4 read-only. `moveItem` moves the clip with its stroke.
- Extra feature (my choice): recolour the selection. With the loop tool and something selected, the colour menu recolours the selection (one undo step, no format change).
- Tested here: 179 unit tests (`npm test`), 4 new browser tests (remove the square, long stray stroke with undo/redo, pen cut, recolour with undo), mutation-checked by hand (they fail without the behaviour), screenshots light and dark.
- NOT tested, needs a device: the feel with a real pen on the tablet; whether 12 units of slack is right for stray detection; strokes drawn before 0.4.7 are not cut (by design).
- Found the cause of the flaky search test: the search box reuses one dialog element and the close event of an earlier closing could arrive after a new opening and cancel that box's search. `palette.js` now ignores a close event while the box is open; a test sends such an event and fails without the fix.
- Release notes: `docs/release-notes/0.4.7.md`.

## Top bar View menu (after 0.4.7, not a version of its own)
Owner request (2026-11-08): the Text/Canvas/Split buttons and the Markdown button crowded the top bar, especially on a phone.
- One View button replaces the Canvas and Split buttons. Its menu lists Text, Canvas and Split, named by where you go, and ticks the one you are in (the Markdown view counts as Text).
- The Markdown button stays and shows only with text (not beside a drawing); it has an icon, and on screens up to 560 px wide the icon alone, so the top bar stays on one row on a phone. The title may shrink to about five characters before buttons wrap.
- Tested here: browser tests for the menu (contents in each view, keyboard open and Escape), the old tests changed to use the menu, screenshots light and dark on desktop and phone. Needs the tablet and phone: touch feel of the menu, and the single row on a real phone.
- No release notes yet: they go into the next version's notes.

## 0.4.10: draw over text built
Release notes: `docs/release-notes/0.4.10.md`. Built and tested in a browser here; NOT tried on a device (pen pressure, finger scrolling, Android and Windows touch screens are untested). Columns and the Android in-app installer are not built yet.
- A pen button on the top bar (`#inkButton`) and the command "Draw on the text of this page" start drawing; a pen bar (`.ink-bar`) sits above the text: pen, highlighter, eraser, the sixteen colours, five widths, Undo, Redo, Finger draws, Done. Design notes and the reasons for the placement are in `docs/v0.4-plan.md`.
- Ink is stored in `Name.canvas.json` format 5 as a separate `ink` list; each stroke has `anchor: { block, tag }` and points as fractions of that block (`web/textink.js`, `web/canvasrules.js`). Older versions open it read-only. A page with ink shows it over the text when opened (one small read of the drawing file per page; a page without ink loads nothing).
- Screen code: `web/inklayer.js` (sticky zero-height layer in the scroll box, a viewport-sized canvas redrawn on scroll and resize); wiring in `web/main.js` (`loadInk`, `startInk`, `stopInk`, `leaveInk`; the canvas view object holds the drawing for both).
- Tests: 223 unit tests (11 new in `tests/textink.test.mjs` and the format tests in `tests/canvas.test.mjs`) and the browser tests (10 new: save with anchor, narrower window, finger scroll and Finger draws, eraser/undo/redo, colour and width, shown on open, orphaned ink kept, canvas keeps ink, newer file read-only, odd input). Screenshots checked in light, dark and phone width.
- Not done / known: ink is not in print or export; a stroke is not split when it crosses blocks (it belongs to the block it starts in); the bar wraps to two lines on a phone; the theme change does not repaint the ink until the next scroll or stroke.

## 0.4.9: built
Release notes: `docs/release-notes/0.4.9.md`. The owner deleted the earlier 0.4.9 and 0.4.10 releases, so everything since 0.4.8 is one release, 0.4.9. Built and tested in a browser here; not tried on a device.
- Linux text turning bold on long pages: the 0.4.8 change did not work. The owner found that `WEBKIT_DISABLE_DMABUF_RENDERER=1` and `WEBKIT_DISABLE_COMPOSITING_MODE=1` each fix it. The app now sets the first at startup on Linux unless it is already set (`apply_webview_defaults` in `src-tauri/src/lib.rs`). NOT tried on a device. The Rust tests run in the GitHub checks (this workspace has no GTK libraries).
- Lists of different kinds written one after another (bulleted, numbered, to-do) opened as one raw block. `listKind` and `readList` in `web/blocks.js` now start a new list when the kind changes after a blank line.
- A toggle holding a callout opened as one raw "Kept exactly as written" block. `web/richblocks.js` now reads every block inside a callout or toggle with the reader for its kind (`parseInner`, `readInnerBlock`) and writes nested callouts, toggles, tables and images (`serializeInner`); `web/richnodes.js` allows them; nesting over 8 levels stays raw.
- Raw text has no frame or label any more (`web/editor.js` raw block view, `web/style.css`): plain page text that wraps and grows to its text.
- Tests: 212 unit tests and 269 browser tests pass, including the owner's three lists, and his "Skin" toggle with an edit inside its second callout. Screenshots checked in light and dark.
- Not done: loose lists are still raw; other causes of raw text will be fixed as they are found. Two-finger zoom on Linux and finger drawing on the canvas moving the screen are known and not fixed.

## 0.4.8: built
Owner requests (2026-11-11). Release notes: `docs/release-notes/0.4.8.md`. Built and tested in a browser here; nothing tried on a device.
- Bold text on Linux once a page scrolls: scrolling boxes get a solid background. NOT reproducible here (no Linux web engine in the build environment); the owner must confirm on Linux.
- Empty lines are kept as extra blank lines (`compose.js`, "empty lines"); top level of a page only.
- Toggles: outline always visible; folded on first open after the app starts, as left after that (`togglefold.js`, `app.folds` in `main.js`).
- Tags box: a main tag shows or hides its subtags (`tagRows`, `clickTag` in `tagindex.js`); main tags start folded.
- History: from the normal text, versions are shown as the page looks and compared block by block (`pagetext.js`, `splitPageBlocks`); from the Markdown view, markdown as before.
- Renaming a page updates links to it (`renamelinks.js`, `planLinkUpdates` and `applyLinkUpdates` in `main.js`). Not covered: folder renames and moves.
- The View menu (built after 0.4.7) is described in the release notes.
- NOT tested, needs a device: all of the above on a real device; the bold fix on Linux in particular.
- Known and not fixed: two-finger zoom on Linux zooms the whole window instead of the drawing (seen in an owner recording; the cause was not looked into).
- Design check done on screenshots (toggles, History as the page looks, Tags folded; light and dark; phone and desktop; block "048" in `tests/editor.spec.mjs`, run with `SHOTS_DIR`). Nothing new that is a gradient, glow or custom colour.
- Security check: History pages and renamed-link text are built as text nodes, never run as code; the link rewrite touches only pages of the open vault and reports pages it could not write. No new network access, no secrets.
- Tests here: 205 unit tests and 267 browser tests pass (packaged build checked in the browser build, not as an installed app).
- Moved to 0.4.9: draw over text, columns, the Android in-app installer. Handwriting to text is wanted and to be discussed.

## Done in 0.4.8 (was planned)
- Toggle block outline always visible (owner, 2026-11-09, from screenshots of a folded and an unfolded toggle). Today the box around a toggle is only drawn while the cursor is in it (0.2.2 item 6), so a toggle you are not working in looks like loose text and it is unclear where it ends. Build: draw the outline in the same quiet border colour whether the toggle is folded, unfolded, focused or not, in every theme, light and dark, with a screenshot check of a folded and an unfolded toggle in each; the editing highlight, if any, may still be stronger than the resting outline. Check the markdown file is unchanged (this is only style) and that folding still works.

## 0.3 wrap-up
0.3 is complete with 0.3.8 (0.3.4 was never used). Carried over, not started: columns (waits for a format decision, see "Block layout"), renaming a page does not rewrite links to it, the Android in-app installer, a fix for the occasionally flaky search test, a Windows-runner browser-test flake (`ERR_NO_BUFFER_SPACE` once, passed on re-run). Still to be tried on a real device: export and print/PDF (Windows, Linux), everything marked "NOT tested" in the 0.3.x sections. Next version: 0.4, canvas and pressure-sensitive ink.

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
| 0.2.10 | Notion colour palette for text and background, and a copy for Obsidian in Settings (see "0.2.10: built") | built, not tried on a device |
| 0.3.0 | Search, command palette, delete and trash (see "0.3.0: built") | built, not tried on a device |
| 0.3.1 | Android builds are signed with a fixed key so they update over each other (see "0.3.1: built") | built, not tried on a device |
| 0.3.2 | Finger drag and menu gestures in the page list, new entries at the top when nothing is open (see "0.3.2: built") | built, not tried on a device |
| 0.3.3 | Wikilinks and backlinks (see "0.3.3: built") | built, not tried on a device |
| 0.3.4 | (number not used; tags and favorites were moved to 0.3.6) | no build |
| 0.3.5 | Covers, optional and off by default (see "0.3.5: built") | built, not tried on a device |
| 0.3.6 | Tags and favorites (see "0.3.6: built") | built, not tried on a device |
| 0.3.7 | Export and page history (see "0.3.7: built") | built; history list, changes and restore tried by the owner on an Android tablet (2026-11-06); export and print not tried on a device |
| 0.3.8 | History box tidy-up and logging of failed history copies (see "0.3.8: built") | built, not tried on a device |
| 0.4.0 | Canvas page with a pressure pen and an eraser (see "0.4.0: built" and `docs/v0.4-plan.md`) | built, not tried on a device |
| 0.4.1 | Highlighter, shapes, sticky notes, lasso, pen button setting (see "0.4.1: built") | built, not tried on a device |
| 0.4.2 | Compact drawing toolbar with menus; Settings, Tags and Trash as buttons like New page (see "0.4.2: built") | built, not tried on a device |
| 0.4.3 | Pen width as a five-stop slider; the page id is never shown in the app (see "0.4.3: built") | merged and tagged, not tried on a device |
| 0.4.4 | Sticky notes drawn as boxes and resizable, shapes snap to a grid, the OneNote pen colours, pinch zoom fix (see "0.4.4: built") | built, not tried on a device |
| 0.4.5 | Paper and page colour for drawings, loop moves snap to the grid, folder icons (see "0.4.5: built") | built, not tried on a device |
| 0.4.6 | Highlights behind ink and tidied against figures, split mode and the "Open pages in" setting (see "0.4.6: built") | built, not tried on a device |
| 0.4.7 | Cuts saved in strokes, pen cut too, only stray parts left uncut, recolour the selection (owner request, see "0.4.7: built") | built, not tried on a device |
| 0.4.8 | Bold-text fix, empty lines kept, toggles folded with an always-visible outline, foldable subtags, History as the page looks, links updated on rename, View menu (see "0.4.8: built") | built, not tried on a device |
| 0.4.9 | Linux text-weight fix, lists of different kinds in a row, callouts and toggles inside toggles and callouts, raw text without a frame (see "0.4.9: built") | built, not tried on a device |
| 0.4.10 | Draw over text: ink anchored to blocks (see "0.4.10: draw over text built"); columns and the Android in-app installer are still to come in this version | draw over text built, not tried on a device; columns and installer not started |
| 0.4.11 | One big release (owner request, 2026-11-11): the `/canvas` block, image controls (eight resize handles as in v1, size saved as `![alt\|300x200](path)`, see DECISIONS.md) and PDF import as page images to draw on. Evaluation of v1's `/canvas` is in `docs/v0.4-plan.md`; the markdown storage must be decided with the owner first | not started |
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
