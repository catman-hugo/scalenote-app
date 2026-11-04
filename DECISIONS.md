# Decisions

An append-only log of choices that are hard to undo. Add an entry when a choice is not obvious, when a new dependency is added (with its licence), or when a feature is built in a narrower form than planned.

Entry format:

```
## YYYY-MM-DD: one-line decision
Context. What forced a choice.
Decision. What was done.
Alternatives. What was not done, and why.
Cost. What this gives up, and what it would take to undo it.
```

## 2026-11-03: Start a new repository instead of continuing the two earlier attempts
Context. Two earlier attempts (a web client-server app and a local-first desktop app) stalled. One kept notes in a database with images inside, the other had a very large plan and little finished.
Decision. Start fresh. Use the earlier attempts only as reference for ideas and for what went wrong.
Alternatives. Continue the local-first attempt. Its plan was much larger than what was built, so the cost of understanding and trimming it was about the same as starting again.
Cost. Some solved problems have to be solved again.

## 2026-11-03: Notes are markdown files in a normal folder
Context. Users must be able to switch to or from other apps such as Obsidian by pointing at a folder.
Decision. The vault is a folder of markdown files. A search index is allowed only as a cache that can be rebuilt from the files.
Alternatives. A database as the main store. Rejected because notes could not leave the app.
Cost. Sync and merging need extra care, because files have no built-in history.

## 2026-11-03: Peer-to-peer is direct only, over the local network and Tailscale
Context. Peer-to-peer is the backup when the home server is down, so it must not need another server.
Decision. Direct connections only, no relay and no hole punching. One-time share codes. The network library is chosen in a short spike at the start of version 1.6.
Alternatives. A relay service. Rejected because it adds a server that can fail and see connection details.
Cost. Two devices on different networks without Tailscale need port forwarding.

## 2026-11-03: Google Calendar two-way sync is not built
Context. An app that has not passed Google's verification has login that expires every 7 days.
Decision. Two-way sync uses CalDAV (iCloud, Nextcloud). Google Calendar is read-only through its secret link.
Alternatives. Pass Google's verification. Rejected by the owner.
Cost. Google calendars cannot be edited from ScaleNote.

## 2026-11-03: Pinned versions and a bundler-free spike
Context. An earlier attempt lost days to an accidental major version jump.
Decision. Tauri CLI and crates are pinned to exact versions (CLI 2.12.4, tauri =2.12.4, tauri-build =2.7.4). Lockfiles are committed. The 0.0 spike page is plain HTML/JS/CSS with no bundler.
Alternatives. Vite and TypeScript from the start. Rejected for the spike because it adds versions to track before anything needs them.
Cost. The spike page is not the real interface. A framework is chosen when version 0.1 starts.

## 2026-11-03: Installers are built by GitHub Actions
Context. The build environment used for development cannot compile Tauri apps or Android packages.
Decision. A workflow builds Linux (deb, rpm, AppImage), Windows (msi, exe) and a debug Android APK. The Android project is generated in the workflow, not committed. Debug APKs use a throwaway key, release signing comes later.
Cost. A failed build is only seen after pushing. Nothing built here has been run on a device yet.

## 2026-11-03: Placeholder icon
Context. The real logo has not been supplied.
Decision. A plain generated square is used until it is.

## 2026-11-03: App icon is the owner's logo on a white tile
Context. The logo has a transparent background and a transparent middle, and its outline is dark, so it disappears on dark taskbars and home screens.
Decision. Desktop icons use the logo on a white rounded tile. Android uses a plain white square with extra margin so the system's icon shapes do not cut into the logo. The original is kept in assets/logo.png.
Alternatives. Transparent logo (unreadable on dark), and a light purple tile (purple on purple).
Cost. Icons are generated from a script-made tile, so changing the logo means regenerating them.

## 2026-11-03: Editor stack and how notes are kept safe (0.1)
Context. A markdown editor rewrites markdown in its own style, which would change notes the user only opened, and would damage syntax it does not know (wikilinks, callouts, tables).
Decision. The note is cut into blocks. Each block keeps its original text, and a block the user did not change is written back byte for byte. Unknown syntax becomes a raw block, shown and edited as plain text. If a note ever fails the open-and-save-unchanged check, the whole note is shown as one raw block. Tiptap 3.32.2 with its markdown extension, bundled with esbuild 0.28.2 (all pinned). Underline is off because markdown has none.
Alternatives. Let the editor rewrite everything (rejected: loses content). A source-only editor (rejected: not a block editor).
Cost. Loose lists and anything with wikilinks, tags, html or images edit as plain text for now. More block types become editable in later versions.

## 2026-11-03: Frontmatter id on first save
Context. The plan gives every note an id in its frontmatter.
Decision. The id is added the first time ScaleNote saves an edited note, not when a note is only opened. Existing frontmatter is kept as written and the id line is added before the closing line.
Cost. An Obsidian note edited in ScaleNote gains one `id:` line.

## 2026-11-03: Conflicts, vault location, no delete
Decision. If a file changed on disk while open, the disk version wins and the user's text is saved as "<name> (conflict copy).md" next to it, with a message. Android has no folder picker in Tauri, so Android uses an app-private vault for now. The default vault on desktop is Documents/ScaleNote. There is no delete or move until 0.3 (trash). The AI setting is stored as off and has no switch in 0.1.
Cost. On Android the notes are not visible to other apps until a folder choice is added.

## 2026-11-03: Testing without a device
Decision. File logic lives in a std-only Rust crate so it can be tested here. The interface is tested in Chromium against an in-memory stand-in for the Rust commands. Neither replaces trying the packaged app.
Cost. The Tauri glue is only compiled by GitHub.

## 2026-11-04: Rich blocks are read strictly, otherwise they stay raw (0.2)
Context. Callouts, toggles, tables and pictures must become editable without ever changing a note that was only opened.
Decision. Each kind has a strict reader (`web/richblocks.js`). A block that is not exactly the expected shape stays a raw block. An untouched block is written back byte for byte; the writers only run for blocks the user changed, and then write one fixed style (`> [!kind]- Title`, `<details><summary>`, pipe tables with a divider line, `![alt](attachments/name.ext)`). Callouts and toggles may only hold paragraphs, headings, lists, to-do lists, quotes, code and dividers, so what the editor shows always reads back the same. Tables have one line of text per cell. Cells with wikilinks, tags, math, html or images keep the whole table raw.
Cost. Some valid markdown (nested callouts, tables with multi-line cells) stays raw text.

## 2026-11-04: Pictures (0.2)
Decision. Pictures are copied into an `attachments/` folder at the root of the vault. The file type is decided by the first bytes (png, jpg, gif, webp); SVG is refused because it can carry scripts. Limit 10 MiB, checked on the encoded text before decoding. Names are reduced to letters, digits, `_` and `-`. The same bytes pasted twice are stored once. The folder is hidden from the note list. Bytes cross the Tauri bridge as base64 because the commands carry text. Tauri's own file-drop handling is switched off (`dragDropEnabled: false`) because on Windows it swallows browser drag-and-drop of files.
Alternatives. Folder next to each note (rejected: Obsidian's default and sync are simpler with one folder). Raw byte transfer (rejected: not needed for a 10 MiB limit).
Cost. Base64 makes transfers a third larger. Not tried in a real window; the Windows drop setting is taken from Tauri's documentation and needs a device check.

## 2026-11-04: Markdown source view and line endings (0.2)
Decision. A button switches the whole note to a text box. Saving from the box writes exactly the box content. The text box turns line endings into `\n`, so a note with Windows line endings is shown with `\n` and written back with `\r\n`. A note that mixes both kinds is shown read-only in source view, because editing it there would silently change line endings.

## 2026-11-04: Block handle, block ids and moving blocks (0.2)
Decision. The handle uses pointer events so mouse, finger and pen share one code path (touch-action none on the handle only). The menu has move up and move down as well, so moving never depends on dragging. Alt+Up and Alt+Down move the block you are in. A block link uses Obsidian's own marker: a paragraph gets ` ^id` at the end of its last line; any other block gets a separate `^id` line after it. A block and its id line move, duplicate and delete as one unit. A duplicate gets no id, and duplicate ids are dropped when saving, so ids stay unique. Blocks remember their original position, and the blank-line spacing of a note is reused only next to the same neighbour, so reordering cannot glue blocks together.
Cost. Links of the form `[[Note#^id]]` are written but not followed until 0.3. Only text blocks can be turned into other types.

## 2026-11-04: Themes (0.2)
Decision. Eight themes plus "follow the system" (the default). Values come from the first ScaleNote, with translucent borders and tints blended to solid colours. Colours that failed the contrast test were darkened or lightened (sage and lavender accents, light-theme status colours, the dark-theme red). `tests/themes.test.mjs` reads `web/themes.css` and checks every theme has every colour and that text, accent and status colours reach 4.5:1 (main text 7:1). Theme files are plain data, so community themes can be added later.
Cost. Some accents are a little darker than in the first version (for example sage's green).

## 2026-11-04: Update check on by default, no automatic install yet (0.2)
Context. The owner wants the check and automatic updating on by default, with one setting for both.
Decision. One setting (`updates`, default on) controls both. The check reads only `api.github.com/repos/catman-hugo/scalenote-app/releases`, at most every 12 hours, with no body, cookies, referrer or credentials, and a 10 second and 512 KiB limit. Only published non-pre-release plain `x.y.z` tags count. Release notes are untrusted and shown with `textContent` only. Installing by itself needs a signing key in GitHub secrets that does not exist, so the notice offers a download button that opens only the project's releases page (`tauri-plugin-opener` 2.7.2, scoped in the capability file). The first-run text and Settings both say the check exists and that GitHub sees the internet address. The "What's new" screen shows the bundled notes of the running version once after an update, never on a fresh install. The app version is built into the interface from `package.json`; a test checks all version numbers agree.
Alternatives. Showing the link as text (rejected: poor for a non-programmer). The updater plugin (rejected until a signing key exists).
Cost. Existing 0.1 users get the check without having seen the disclosure line; the What's new screen tells them. The connect policy had to be written out (`ipc:`, `http://ipc.localhost`, GitHub), so a mistake there would break the app's own commands. Needs a device check.

## 2026-11-04: Phone keyboard (0.2)
Decision. The viewport has `interactive-widget=resizes-content` and the page height uses `100dvh`, so the on-screen keyboard shrinks the page instead of pushing the top bar under the status bar. Needs a check on the POCO F7 Pro.

## 2026-11-04: Not built in 0.2
Underline, highlight, colour, subscript and superscript (stored as inline html). The list of html tags and attributes that may be kept needs the owner's decision first. The converter for old ScaleNote notes was dropped by the owner.

## 2026-11-04: A 0.2.1 polish release before 0.3
Context. The first test of 0.2 on Windows found four small interface problems (What's new box too small, Settings link hard to see, Open another folder in the wrong place, a squished sidebar when narrow). A fifth, note width seeming to do nothing, was not a bug: no note was open. The owner wants them fixed before 1.0.0 but not right now.
Decision. They go into a patch release 0.2.1 that comes before 0.3 and holds no new features. That keeps 0.3 (search, links) free of interface repairs, and lets findings from the Android phone and Linux be added to the same patch. The gear icon is an svg using the theme colour, and no emoji is used anywhere in the app. The list is in `PROGRESS.md`.
Alternatives. Waiting for the 1.0.0 hardening (rejected: the problems are visible every day). Mixing them into 0.3 (rejected: it makes 0.3 harder to test).
Cost. One more release to build and test.
