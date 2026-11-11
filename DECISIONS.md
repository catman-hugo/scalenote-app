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
Decision. The viewport has `interactive-widget=resizes-content` and the page height uses `100dvh`, so the on-screen keyboard shrinks the page instead of pushing the top bar under the status bar. Needs a check on an Android phone.

## 2026-11-04: Not built in 0.2
Underline, highlight, colour, subscript and superscript (stored as inline html). The list of html tags and attributes that may be kept needs the owner's decision first. The converter for old ScaleNote notes was dropped by the owner.

## 2026-11-04: A 0.2.1 polish release before 0.3
Context. The first test of 0.2 on Windows found four small interface problems (What's new box too small, Settings link hard to see, Open another folder in the wrong place, a squished sidebar when narrow). A fifth, note width seeming to do nothing, was not a bug: no note was open. The owner wants them fixed before 1.0.0 but not right now.
Decision. They go into a patch release 0.2.1 that comes before 0.3 and holds no new features. That keeps 0.3 (search, links) free of interface repairs, and lets findings from the Android phone and Linux be added to the same patch. The gear icon is an svg using the theme colour, and no emoji is used anywhere in the app. The list is in `PROGRESS.md`.
Alternatives. Waiting for the 1.0.0 hardening (rejected: the problems are visible every day). Mixing them into 0.3 (rejected: it makes 0.3 harder to test).
Cost. One more release to build and test.

## 2026-11-04: Keep formatting inside the markdown file, no sidecar file
Context. Markdown cannot store text colour, underline, sub and superscript. The owner asked whether a separate file next to each note could hold them, with a button to convert to and from Obsidian, so the raw text stays free of syntax.
Decision. Formatting stays inside the note. Highlight is written as `==text==` (Obsidian reads it natively). Colour, underline, subscript and superscript are written as small inline html tags, using a fixed palette that follows the theme. Only text the user actually styled gets tags. The editor shows the result, so the raw syntax is only seen in the markdown view. The exact tags are checked against Obsidian's documentation before building.
Alternatives. A sidecar file per note. Not chosen: formatting tied to text positions drifts or vanishes when the note is edited in another program or moved without its partner file, two files per note add sync and backup risk, colours would not show in Obsidian without a conversion, and it needs a lossy two-way converter, which 0.2 dropped on purpose.
Cost. Notes with colour contain html that other markdown programs may show as raw tags. Undoing this later means writing a converter.

## 2026-11-04: Sidebar buttons shrink to icons with a container query
Context. The note list can be made narrow in Settings (200 to 420 pixels). At the narrow end the New note and New folder buttons wrapped and the bottom links stacked.
Decision. Every sidebar button is an icon plus a label that never wraps. Below a width the labels are hidden with a container query (the label stays as tooltip and accessible name), and the Pen test link is hidden below a smaller width.
Alternatives. Raising the minimum list width to hide the problem (still breaks with larger text), or media queries on the window (the list width is a setting, not the window width).
Cost. Container queries need a reasonably recent web view. Current WebView2 (Windows) and Android System WebView are Chromium based and should have them, and recent WebKitGTK (Linux) should too, but I have not checked the exact versions. On an older view the labels would stay visible and be cut with an ellipsis instead of hidden, which is still readable. Not yet tried on a real device.

## 2026-11-04: Folder switcher with a recent list
Context. The owner wants separate folders for separate subjects and found that "Open another folder" showed the first-run Welcome screen, which could not be closed.
Decision. The folder name at the top left opens a menu: recent folders, Open another folder (straight to the picker) and Use the default folder. The Welcome screen is only for first run or a missing saved folder. The recent list holds paths only, lives only in settings.json, keeps at most 8, and is validated on load (strings only, length limit, no control characters, no duplicates). A folder that fails to open is dropped from the list.
Alternatives. Keeping a separate button (rejected by the owner). Storing the list in the vault (rejected: it would put machine paths into notes that may be synced or shared).
Cost. Paths of recent folders sit in settings.json on the device. No new network or Rust code, so the security checklist is unchanged apart from this.

## 2026-11-04: "Page" instead of "note" in the interface
Context. The owner wants the app to be for notes but also usable for quick writing in daily life, and asked for "page" instead of "list"/"note".
Decision. The interface says "page" everywhere it said "note" (New page, Pages, Page width). The callout kind "Note" stays, since it is a different thing. Files stay plain markdown notes; only the wording changed. All text is in `web/strings.js`, so it can be changed in one place.
Alternatives. Keeping "note" (rejected by the owner).
Cost. Older docs and release notes still say "note"; they describe past versions and are left as they were.

## 2026-11-04: The update check counts pre-releases
Context. The check skipped releases labelled Pre-release. All releases are labelled that way until 1.0, so a device on 0.2.1 never saw 0.2.2. The owner confirmed that switching the label to None made it show.
Decision. Only drafts are skipped. Tags must still be a plain x.y.z number. Releases stay labelled Pre-release until 1.0, and the check works with either label. Once 1.0 exists, a rule to hold back test builds (for example, ignoring pre-releases for people on stable) can be added.
Alternatives. Publishing every release as None (works, but relies on remembering it, and loses the label as a warning). A setting for "include test builds" (not needed while everything is a test build).
Cost. A version published by mistake as Pre-release is offered to everyone. Builds older than 0.2.3 still cannot see pre-releases.

## 2026-11-04: A right-click menu in the page list, starting with Rename
Context. The owner liked the right-click menu of the old server-only ScaleNote and wants folders to be renamed from it. Folders could already be renamed by double-click, which is hidden and does not work on touch.
Decision. Right-click, long press and the menu key open a small menu at the entry. It only holds actions that exist: Rename, for folders and pages. More entries are added when their features exist (delete with the trash in 0.3). No emoji or icons are in the menu text; it uses the same flat menu style as the block menu. The rename field replaces the entry's button instead of sitting inside it. F2 renames the focused entry.
Alternatives. Showing Delete, Duplicate and Share greyed out (rejected: dead entries). A rename button on every row (rejected: clutter, and no room on the phone).
Cost. Long press relies on the Android web view sending the contextmenu event; this is not tried on the phone yet. If it does not, a second way (a button in the row) will be needed there.

## 2026-11-04: Moving pages and folders is a Rust command, and the drag uses pointer events
Context. The owner wants to drag pages and folders onto other folders in the list. Renaming already goes through the Rust core, which owns every change to the vault.
Decision. A new `Vault::move_entry` moves a note or a folder into another folder with `fs::rename`, keeps the name, never replaces anything, refuses a folder inside itself, and sanity-checks paths like the other functions. The web side only asks. The drag uses pointer events rather than the browser's own drag and drop, because that does not work with a finger on the Android web view and cannot be styled. A finger scrolls the list, so touch gets Move to in the right-click menu instead.
Alternatives. A copy-then-delete move (rejected: not atomic, and a crash could duplicate or lose notes). Letting the web side rename the path (rejected: all vault changes stay in Rust).
Cost. `fs::rename` fails across file systems (for example a symlinked subfolder on another disk); that shows as a calm error and nothing is lost. Links between pages are not rewritten when a page moves, because links by path do not exist yet (0.3 decides how links follow moves).

## 2026-11-04: Undo must never go back past opening a page
Context. Testing the block move found that Undo right after opening a page emptied the editor, since loading counted as an edit. Autosave could then have written the empty page over the real one.
Decision. Loading a page into the editor (and switching from the source view) is not part of the undo history.
Alternatives. Disabling autosave for empty documents (rejected: it hides the symptom and breaks legitimate emptying).
Cost. None known: Undo now stops at the state the page was opened in.

## 2026-11-05: The keyboard shortens the window, and the generated Android project is patched in CI
Context. The generated Android app is edge to edge with no keyboard setting, so the keyboard made Android slide the whole window up and hide the title bar. The Android project is not stored in the repository.
Decision. A small script patches the generated manifest and activity right after `tauri android init`: the keyboard makes the window shorter (the title bar stays, the page ends above the keyboard), and the page scrolls the cursor into view only when it is hidden. The script fails the build if the generated files change shape.
Alternatives. Storing the whole generated Android project in the repository (rejected: it would drift from the Tauri version and is a lot of generated files). Doing it only in the page with `interactive-widget` or the visual viewport (rejected: the web view does not report the keyboard while the window pans). Panning the window as Android does by default (rejected: it hides the title bar).
Cost. Kotlin code that this workspace cannot compile or run; only GitHub's build and the phone prove it. A Tauri update could change the template, in which case the build stops with a clear message until the script is updated.

## 2026-11-05: Updates are downloaded by the browser, not by the app
Context. Check now found a new version but offered nothing usable. The owner wants the update downloaded, or else a link to the file, or else the release page.
Decision. The Download button gives the address of the matching release file to the system browser (Android .apk, Windows .msi); where no single file fits (Linux) or the file cannot be opened it falls back to the release page. The file addresses come from the release list the app already reads.
Alternatives. Downloading inside the app (rejected: it needs network code and file writing in Rust and a new dependency for secure connections, and it would still end with the person opening the file). Installing by itself (rejected for now: needs signed installers, and an Android install needs a new permission). Guessing the Linux package type (rejected: a wrong guess installs the wrong thing).
Cost. The person still opens the downloaded file, and Android may ask to allow installs from the browser. Linux takes one more tap.

## 2026-11-05: The Android icons are copied in by the build
Context. The generated Android project carries Tauri's default icons and ignores `src-tauri/icons/android`.
Decision. The Android patch step copies the committed ScaleNote icons over the generated ones after init, and fails the build if they are missing.
Alternatives. Running `tauri icon` in the build (rejected: needs the source tile image, which is not in the repository, and would regenerate what is already committed). Storing the whole generated Android project (rejected earlier, see the keyboard decision).
Cost. Changing the logo still means regenerating `src-tauri/icons/android` by hand.

## 2026-11-05: Inline styles are stored as markdown and html, and a paragraph is edited only when they survive
Context. The owner wants highlight, underline, sub and superscript and colour (DECISIONS 2026-11-04: formatting stays inside the note file, readable by Obsidian). The markdown reader we use silently drops html it does not understand, so a paragraph could lose text on save.
Decision. Highlight is `==text==`; underline, subscript and superscript are `<u>`, `<sub>`, `<sup>`; colour is `<span style="color: #hex">` for eight fixed colours. A paragraph with these markers opens as editable text only if the markers read back identical after a parse and re-save; otherwise it stays raw and is written byte for byte. Colours outside the palette stay raw.
Alternatives. A custom syntax or a sidecar file (rejected: other programs would show nothing, and the file would not be self-contained). Free colour choice (rejected: unreadable on some themes, and each colour needs a class because the page forbids inline styles).
Cost. Obsidian's docs name only `==` for highlight; the html tags are not confirmed there, and Obsidian does not render bold or italic inside html tags. Reading is stricter than writing, so a few odd hand-written lines stay raw.

## 2026-11-05: On touch, the selection bar does not wait for the finger to lift
Context. On Android the system takes over a finger selection, so the page may never get a pointer-up, and the bar waited for it.
Decision. Touch input never blocks the bar, a cancelled pointer counts as finished, and for touch the bar sits 36 px lower than on desktop to clear the native selection handles.
Alternatives. Hiding Android's own Cut/Copy menu (rejected: the page cannot control it).
Cost. The bar and the native menu may overlap in some positions; only a phone shows how often.

## 2026-11-05: Colours are saved by name, and Obsidian gets a converted copy
Context. The owner wants Notion's colour scheme for text and background, and wants to be able to leave ScaleNote for Obsidian without odd markup, while ScaleNote itself stays feature rich. Notion's background shades differ between light and dark.
Decision. A colour is saved by name in a class, `<span class="sn-text-red sn-bg-yellow">` (one span for text and background together), and the theme decides the shade. This replaces the 0.2.9 text colour codes, which are still read. Leaving for Obsidian is a button in Settings that writes a converted copy into a new folder next to the notes folder: background colours become `==text==`, text colours are removed, everything else is kept byte for byte. The owner's own pages are never changed.
Alternatives. A colour code per colour in the note (rejected: one code cannot be right for both light and dark themes). Converting in place (rejected by the owner: one-way and risky). Keeping colour codes so Obsidian shows text colours (rejected by the owner: he wants no odd colours in Obsidian).
Cost. Other programs show no colour from ScaleNote pages unless the copy is made. A second way of saving (the copy) has to stay in step with the editor: a test compares the colour names in the Rust converter with the interface. The copy is not available on Android yet.

## 2026-11-05: The Obsidian copy is made in Rust, away from the main thread, and never replaces anything
Context. The copy reads and writes every file in the notes folder.
Decision. It lives in `scalenote-core` (tested with real folders), runs as an `async` Tauri command so a big folder does not freeze the window, reserves its folder name with a single create call so nothing can be replaced, writes every file atomically, skips hidden entries and links, and removes the half-made folder if it fails.
Alternatives. Doing it in the interface by reading and writing note by note (rejected: thousands of calls, no way to copy pictures, and the rules would not be testable in Rust).
Cost. The copy is written outside the notes folder, which is new for the app (only the parent of the notes folder, and only a brand new folder).

## 2026-11-05: Delete moves to a hidden `.trash` folder in the notes folder, and nothing is emptied by itself
Context. Delete was left out of the menu until it could be undone. The owner wants it in 0.3.0.
Decision. Delete moves the page or folder into `<notes folder>/.trash/<id>/item`, with small plain-text files for the name, the folder it came from and the time. The menu and the Delete key ask nothing, because it is reversible; Delete forever and Empty trash ask in the box. Restore puts it back (top level if its folder is gone, "(restored)" in the name if the name is taken, never replacing). No automatic emptying.
Alternatives. The system recycle bin (rejected: different on Windows, Linux and Android, not possible in Android's private storage, not testable here). A trash folder outside the notes folder (rejected: a different disk may not allow a quick move, and it would be lost if the folder is moved). A confirmation on every Delete (rejected: slows normal use and the trash already protects).
Cost. The trash takes disk space until emptied. The hidden folder is inside the notes folder, so a backup of it includes the trash. Pictures of a deleted page stay behind. Obsidian also uses `.trash` for its own deletions, so the two share a folder name; ours holds numbered folders, which Obsidian ignores.

## 2026-11-05: Search has no index and reads the pages on every search
Context. DECISIONS 2026-11 allows an index only as a cache that can be rebuilt from the files. Other programs (Obsidian, sync) change the notes folder at any time.
Decision. 0.3.0 has no index: each search reads the pages, with limits on query size, results, pages collected and text read. It does not hold the vault lock while it works.
Alternatives. A saved index (rejected for now: needs updating and repair rules, and nothing shows yet that it is needed). 
Cost. Slower in a very large notes folder (3,000 pages take about 0.4 s here, on a fast disk; a phone may be several times slower). If that turns out to be too slow, a rebuildable cache is the next step. The search also needs to run again on every typed pause.

## 2026-11-05: Ctrl+K is the search box, except in a page with text selected
Context. Ctrl+K already adds a link to selected text in the editor.
Decision. Ctrl+K opens the search from anywhere, but with text selected in a page it keeps adding a link. The Search button is always there, and is the only way on a touch screen.
Cost. Two meanings for one key, split by whether text is selected.

## 2026-11-05: Android test builds are signed with one fixed test key kept in a GitHub secret
Context. A debug key made fresh on every build means Android never accepts a build as an update, which deletes the notes and settings on every test.
Decision. The Android job installs one fixed test key from the secret `ANDROID_DEBUG_KEYSTORE_BASE64` where the debug build looks for it. It is a test key only; the release key and signing (2.0.0) are separate and not decided here.
Alternatives. Committing the key to the repository (rejected: the repository is public and keys never go in it). Making the notes folder outside the app's private storage (rejected: Android 11 and newer restrict it, and it does not fix the signature). Uninstalling each time (rejected by the owner).
Cost. The owner has to add the secret once, and the key must be backed up: if it is lost, one more reinstall is needed. Anyone who got the key could sign an app that installs as an update to a test build.

## 2026-11-05: Touch gestures in the page list are told apart by time and movement
Context. One finger on an entry can mean scroll, tap, drag or menu. The phone's long press made the menu appear when a drag was wanted, and a finger could not drag at all.
Decision. Quick tap opens; movement before 350 ms scrolls; holding still 350 ms picks up (then a drag); holding still 800 ms opens the menu; two quick taps open the menu. The system's own long-press menu is dropped inside the list. The owner asked for double tap or a longer hold as the right click.
Alternatives. A drag handle on each row (rejected: clutter, and the owner wanted to drag the entry itself).
Cost. The timings are guesses until the owner tries them on the phone and tablet. A double tap cannot work on a page on a phone, where the first tap closes the list.

## 2026-11-05: New entries go into the selected folder only while it can be seen
Context. A folder stayed "selected" after it was folded shut, so new pages and folders landed in a folder the owner could not see.
Decision. The target is the selected folder only if it and all folders around it are open; otherwise the top level.
Cost. Someone who wants a page in a folder has to open the folder first, which matches what is on screen.


## 2026-11-06: A [[link]] is an editor atom that remembers its exact text
Context. Any block with `[[` was kept raw (shown as a grey box, edited as plain text) because the editor cannot round-trip syntax it does not know. That made pages with links awkward, and links could not be followed.
Decision. A well formed link becomes one inline atom (`wikilinks.js`) that stores the exact source (`[[Plan|the plan]]`) and writes that string back, so it cannot change on a save. `blocks.js` takes well formed links out before the unsafe-syntax check; `compose.js` compares the list of links in a block before and after the editor rewrote it (`wikilinkSignature`) and keeps the block raw if they differ, as it already does for text styles. Embeds (`![[..]]`), links in code, links in table cells and in callout or toggle titles, an unclosed `[[`, and a block with more than 5,000 links stay raw.
Alternatives. Keeping the text as plain text with a decoration over it (rejected: following and picking would still need the same parsing, and a decoration cannot be deleted as one piece). Rewriting links into one canonical spelling (rejected: it changes the file).
Cost. A link cannot be edited in place; it is deleted and written again.

## 2026-11-06: The link rules exist twice, in Rust and in JavaScript, and share one test file
Context. The editor must colour a link without a call to the backend; backlinks are found by reading the files, which the backend does.
Decision. `links.rs` and `wikilinkrules.js` implement the same reading and resolving rules. `tests/fixtures/wikilinks.txt` holds the shared cases and both test suites read it.
Cost. Two copies to keep in step; the shared file is what keeps them honest. The longest link (300) is counted in bytes in Rust and in letters in JavaScript, which only differs for names near that length.

## 2026-11-06: Which page a link means follows Obsidian
Decision. Names match without regard to case and without `.md`; a name with folders must match the end of the path; when several pages fit, the one in the same folder as the page holding the link wins, then the one with the fewest folders, then alphabetical order. A link to a page that does not exist creates it at the top of the vault (or in the named folder when that folder exists) on click.
Cost. Two pages with the same name in different folders make `[[Name]]` depend on where it is written. The picker writes the full path when the short name would mean another page.

## 2026-11-06: Backlinks have no index and wait 300 ms after a page opens
Context. Same trade as search (2026-11-05): other programs change the files at any time.
Decision. `Vault::backlinks` reads the pages on each call with the same limits as search, runs away from the main thread without holding the vault lock, and is asked for only after a page has stayed open 300 ms.
Cost. In a very large folder the list appears late, and every page open reads the folder. A rebuildable cache is the next step if that proves too slow.

## 2026-11-06: Renaming a page does not rewrite links to it yet
Context. Obsidian rewrites the links in other pages when a page is renamed or moved. Doing that here means writing to many pages from one action.
Decision. Not in 0.3.3. The links turn dashed. A safe version (preview the pages that will change, atomic writes, one undo) is its own slice.
Cost. Renaming a linked page breaks its links until they are fixed by hand.

## 2026-11-06: Covers are optional, per page and as a whole
Context. The owner asked for covers to be optional.
Decision. The owner confirmed both: a "Show covers" toggle, and per page his own custom image or none. No page has a cover by default; adding and removing one is the page's own choice. A setting turns covers off completely, and then nothing about them is shown. The file format is decided when covers are built.
Cost. One more setting to build and test.


## 2026-11-06: A cover is one property line plus a normal attachment, and covers are off by default
Context. The owner wants covers optional: a switch for the whole feature, and per page his own picture or none. Notes must stay plain markdown that Obsidian opens, and writing to a page must never lose content.
Decision. The cover is `cover: attachments/name.png` in the page's frontmatter; the picture is saved as an ordinary attachment with the existing checked picture command. Only that line is read, changed or removed, the rest of the block is kept byte for byte, and a `cover` entry that is not a plain one-line value is never edited. The switch `showCovers` is off by default, and when it is off the cover area is not created at all. Removing a cover removes the line only, not the picture file.
Alternatives. A custom hidden file or a sidecar (rejected: not plain markdown, breaks on move). A markdown image at the top of the body (rejected: it would show as an ordinary block and cannot be told from a picture the person put there). Frontmatter key `banner` or `image` (rejected for now: `cover` is the name most Obsidian setups use).
Cost. Obsidian shows the line as a property but does not draw the picture unless a plugin is installed. Removed covers leave their files behind. Covers were built before tags and favorites, which is why the numbers were later rearranged (next entry).

## 2026-11-06: Version numbers follow the order the slices come out; tags and favorites are 0.3.6
Context. Covers (planned 0.3.5) came out before tags and favorites (planned 0.3.4), so 0.3.4 would have been released after 0.3.5.
Decision. The owner asked for tags and favorites to be labelled 0.3.6 and for export and page history to move from 0.3.6 to 0.3.7. There is no 0.3.4. The plan, PROGRESS.md and the release notes use the new numbers.
Cost. Anything that mentions the old numbers (older chat summaries, the earlier 0.3.5 notes in PROGRESS.md) is explained in a sentence rather than rewritten.

## 2026-11-06: A tag stays plain text; the editor only marks it
Context. Wikilinks became editor pieces (atoms) that store their exact text. A tag could do the same.
Decision. A tag is not a piece of its own: it is ordinary text that gets a coloured mark, found by the same rules the Rust code uses. So typing, copying, undo and saving behave as for any word, and the file contains exactly what was typed (tested, including at the start of a line where an editor often adds a backslash). A block is still kept raw if its tags would not come back exactly.
Alternatives. An atom per tag with an input rule (rejected: more code, the caret and Backspace behave oddly, and the text can no longer be edited letter by letter).
Cost. A tag cannot be clicked and selected as one unit, and there is no tag picker while typing `#` yet.

## 2026-11-06: Obsidian's tag rules, matched without regard to case, nested tags count for their parents
Context. The notes folder must open in Obsidian with the same tags.
Decision. A tag is `#` at the start of a line or after a space, then letters, digits, `_`, `-` and `/`, with at least one character that is not a digit, at most 100 letters. Code, link headings (`[[Page#Heading]]`) and escaped `#` are not tags. `#Plan` and `#plan` are one tag; the spelling used most often is shown. `#school/maths` is also listed under `#school`. Tags in the properties (`tags:`) count the same. The Rust and interface versions are tested against one file of cases.
Cost. A `#word` that is not a tag by these rules (a number, an emoji) is not marked, and its block stays raw as before.

## 2026-11-06: A favourite page is `favorite: true` in its properties; the list is read, not stored
Context. Favorites should survive moving the folder to another program or computer, and must not need a hidden file.
Decision. The star writes `favorite: true` into the page's properties (removing it removes the line); Obsidian shows it as a checkbox property and otherwise ignores it. The Favorites list and the Tags box are read from the pages (`page_index`), like search, with the same limits, and nothing is stored. The same one-line property code now serves covers and favorites. A `favorite` entry that is not a plain one-line value is never edited.
Alternatives. A list of favourite paths in the settings file (rejected: breaks when a page is renamed or the folder is opened on another device). A `tags: [favorite]` entry (rejected: mixes two ideas and would need list editing).
Cost. Reading the whole folder after every page-list refresh; a list kept by another program shows after the next refresh.

## 2026-11-06: Page history lives in `.history` inside the notes folder, keyed by the page's id
Context. The v1 spec says history is kept in a cache folder next to the vault. On Android the notes are in the app's private storage, where a folder beside them is not possible, and the trash already uses a hidden folder inside the notes folder.
Decision. Older versions are written to `.history/<key>/<time>.md` in the notes folder. The key is `i-<id>` from the page's `id:` property (only letters, digits, `_`, `-`, at most 64), else a hash of the path. This way a rename or move keeps the history. A copy is made by `write_note` just before the atomic write, at most every 5 minutes per page, never for identical text, and never fails the save. Thinning: all for 24 hours, one a day for 30 days, one per 30 days for a year, then none; at most 100 and 32 MiB per page, 256 MiB in all. Hidden folders are already skipped by the page list, search, links, tags and the Obsidian copy, and Obsidian ignores them.
Alternatives. A folder beside the notes folder (rejected: not possible on Android, and breaks when the folder is moved). One database file (rejected: not plain files, harder to repair by hand).
Cost. The history goes with the notes folder if it is synced or shared, and holds text deleted from a page. Hence "Delete all history" in Settings and a sentence in the release notes.

## 2026-11-06: A restore keeps the page's current id, keeps the text it replaces, and refuses if the page changed
Decision. The comparison is made against the page as read from disk. At restore the page is read again; if it differs, nothing is written. The current text is copied into the history first (`history_keep_now`), and the restored text keeps the page's current `id:` so the history stays under one key. Parts are whole lines and are taken from the older version or kept as they are, so no byte outside a chosen part changes.

## 2026-11-06: Export is one page, to a fixed folder beside the notes folder
Decision. "Export this page as markdown" writes the page and the pictures it names to a new folder inside `<notes folder> (exports)`, like the Obsidian copy: the interface sends only the page, nothing is replaced, a half-made folder is removed, Android is refused. The text is converted like the Obsidian copy (colour spans to `==highlight==`). PDF goes through the system print window and a print style sheet, because it needs no new library and works on Windows and Linux; it is hidden on Android.
Cost. No whole-folder export yet; the PDF layout is whatever the system print window gives.

## 2026-11-06: 0.4 is built in slices; 0.4.0 is the canvas page with a pen and an eraser
Context. The spec's 0.4 (canvas and ink) holds modes, a pressure pen, highlighter, eraser, shapes, sticky notes, lasso, drawing over text and PDF import. The owner chose the drawing sheet itself as the first slice.
Decision. 0.4.0 is a Canvas mode for a page with a pressure pen, an eraser, colours, widths, undo and redo, pan and zoom. The slices after it are in `docs/v0.4-plan.md`.
Cost. Nothing is drawn over text yet, so the sheet and the text are two separate views of a page.

## 2026-11-06: A drawing is `Name.canvas.json` next to the page and follows it
Context. The spec says ink and drawings go in sidecar files next to the note, ignored by Obsidian, so the markdown stays clean.
Decision. The drawing of `Plan.md` is `Plan.canvas.json` in the same folder. The page list shows only `.md`, so it never appears as a page. Renaming, moving, deleting to the trash and restoring a page carry its drawing along (restoring gives it the name the page has after restore, and a stale drawing with that name is never replaced). A folder carries the drawings inside it. Reading and writing are atomic, size limited (32 MiB) and version checked like a page; a link in the place of the file is never followed.
Format 1: `{"format":1,"strokes":[{"tool":"pen","color":"ink","width":4,"points":[[x,y,pressure],...]}, ...]}`, one stroke per line. Coordinates are canvas units on an unbounded sheet (not pixels), rounded to 0.1, pressure to 0.01. Colours are names, not codes, so the theme chooses the shade.
The interface reads the file strictly: if any stroke is not understood the whole drawing is read-only and never saved over (dropping the bad strokes and saving would destroy them). A file with a newer `format` is told apart from a broken one.
Alternatives. Drawings inside the markdown (rejected: breaks the clean-markdown rule). A hidden folder keyed by page id like the history (rejected: the spec asks for next to the page; renames are handled by carrying the file).
Cost. Renaming or moving a page by another program leaves its drawing behind under the old name. The drawing is not yet part of the page history, the Obsidian-format export of one page, or search.

## 2026-11-06: A finger moves the sheet, a pen draws, and the eraser removes whole strokes
Decision. A pen or mouse draws; a finger pans (one) or zooms (two), so a resting hand never leaves a mark, with "Finger draws" for a device without a pen. The pen's barrel button or eraser end erases while held. The eraser removes whole strokes (not parts), which keeps undo exact and the stored strokes unchanged.
Cost. Erasing part of a stroke is not possible yet.

## 2026-11-06: Canvas file format 2 holds every kind of item; a pen-only drawing stays format 1
Context. 0.4.1 adds highlighter strokes, shapes and sticky notes to a drawing, which the 0.4.0 file format cannot hold, and 0.4.0 reads any unknown kind as a broken file (read-only).
Decision. Format 2 is `{"format":2,"items":[...]}`, one item per line. An item is a stroke (`tool` pen or highlighter, colour, width, points), a shape (`tool` "shape", `kind` line, arrow, rect or ellipse, colour, width, corners `a` and `b`), or a note (`tool` "note", colour, `x`, `y`, `w`, `h`, `text`). A drawing with only pen strokes is still written as format 1, so a 0.4.0 app (for example the Android one, if the other device is not updated yet) keeps opening it; one with anything else is format 2, which 0.4.0 shows read-only as "from a newer version" and never changes. The reader accepts both, is strict as before, rejects new kinds inside a format 1 file, and builds clean copies with the known fields only.
Alternatives. Always format 2 (rejected: breaks 0.4.0 for drawings that need nothing new). Keeping `strokes` and adding `shapes` and `notes` lists (rejected: the order of items on the sheet matters, one list keeps it, and undo needs places in one list).
Cost. The file format changes when the last non-pen item is deleted; this is intended. Moving a stroke rewrites its points.

## 2026-11-06: Selecting is a loop, and half of an item's points must be inside it
Decision. The select tool is a hand-drawn loop (the lasso). An item is chosen when at least half of its sample points are inside the loop (a long stroke is sampled at about 100 points; a note or rectangle by its corners and centre). A press on the selection moves it, a press elsewhere starts a new loop. Items cannot be moved past the coordinate limit of the file.
Alternatives. All points inside (rejected: a loop drawn by hand rarely encloses the last point of a line, and selecting would feel broken). A rectangle drag (rejected: the spec says lasso, and a pen draws loops easily).
Cost. A long stroke half inside the loop is selected whole; there is no way to select part of a stroke.

## 2026-11-06: The side button of a pen is a setting; the eraser end always erases
Decision. Settings has "Pen button": erases (default, as in 0.4.0), selects with a loop, or does nothing. The eraser end of a pen always erases.
Cost. A pen whose button is reported differently by the system may not work; this can only be known on the device.

## 2026-11-06: The `/canvas` block is planned as 0.4.3, after drawing over text
Context. The owner asked whether v1's `/canvas` was planned. The spec's slash menu lists "Canvas (embeds a region of the page's canvas)", but the 0.4 plan had no slice for it.
Decision. It becomes 0.4.3, so split mode moves to 0.4.4 and PDF import to 0.4.5. It comes after drawing over text (0.4.2) because both need blocks that know about the drawing, and after the 0.4.1 tools it will use. A block is a window onto a region of the page's one canvas, not a separate drawing. How it is stored in the markdown is decided with the owner at the start of 0.4.3.
Alternatives. Before 0.4.2 (rejected: the text-to-drawing link is built there first). A separate drawing per block (rejected for now: a second file per page, and nothing in the spec asks for it).
Cost. Until 0.4.3 there is no way to put a drawing inside the text; the Canvas mode is a whole page.

## 2026-11-06: Drawing options go in menus under their buttons; 0.4.2 is a tidy-up, later slices move up by one
Context. On the tablet the drawing toolbar took three lines and left a thin sheet. The owner asked for drop-downs or toggles, and for Settings, Tags and Trash to look like New page and New folder.
Decision. Shapes, colour, line width and the less used switches are menus that open under their button, and the button shows the current choice (a menu button also selects the shape used last, so one press starts drawing and offers the others). Only the main tools stay in view. Settings, Tags and Trash use the same outlined icon-and-label button as New page and New folder, with the label hidden below 17 rem. The tidy-up ships as 0.4.2, so drawing over text becomes 0.4.3, the `/canvas` block 0.4.4, split mode 0.4.5 and PDF import 0.4.6.
Alternatives. A collapsible toolbar (rejected: hides tools behind one more press, with no gain over menus for the rarely changed things). Smaller buttons (rejected: touch targets on a tablet and phone need the size).
Cost. Choosing a colour or width takes two presses instead of one. A menu is one more thing on screen that must be closed.


## 2026-11-06: The page id is hidden in the app and only visible in the raw file; pen width is a five-stop slider; slices move up by one again

Decision. The `id:` line in a page's properties stays in the file (history folders are named by it) but is never shown while using the app: the plain markdown view and the history "Text" view leave it out and put it back on save, search never matches it, and the fallback view of a page keeps all properties out of the shown block. The properties block is also recognised after a byte-order mark. Pen width is a slider with five stops (2, 4, 6, 8, 12) instead of three buttons; the file format is unchanged. This tidy-up ships as 0.4.3, so drawing over text becomes 0.4.4, the `/canvas` block 0.4.5, split mode 0.4.6 and PDF import 0.4.7.
Alternatives. Moving the id out of the file into a separate index (rejected: the page would lose its history if the index is lost, and Obsidian users copying a folder would lose it). Showing other properties too (not asked for, they are the user's own).
Cost. In the plain markdown view the first lines differ from the file on disk; the id is put back in the same place, and unchanged text is saved byte for byte. A user who deletes the whole properties block in that view still keeps the id (it is added back).

## 2026-11-07: Shapes snap to a grid by default, with a setting to turn it off

Decision. New shape corners snap to a 20 unit grid in drawing space. The setting "Snap shapes to a grid" is on by default and can be turned off in Settings. The grid is not drawn on the sheet.
Alternatives. Snapping to other shapes' edges (smarter, but much more code and surprising on a pen); snapping only while a key is held (no key on a tablet); drawing a visible grid (not asked for, adds clutter).
Cost. A shape cannot be placed finer than the grid while the setting is on, and a very short drag may snap to nothing and be ignored as a stray tap. Turning the setting off gives the old free placement.

## 2026-11-07: The pen palette is OneNote's sixteen colours, as fixed colours

Decision. The colour picker offers sixteen colours in the order and grid of OneNote's pen palette. They are fixed colours, the same on light and dark, except ink (black on light, white on dark). The six names from 0.4.0 keep their meaning, so old drawings open; ten new names are added. The file format number does not change.
Alternatives. Free colour picker with any hex value (needs a new file format and an unlimited set of values to check); keeping the muted text colours of the page (they were chosen for text, not for ink).
Cost. A drawing that uses a new colour opens read-only in 0.4.2 and older. Dark grey is hard to see on the dark theme, as in OneNote.

## 2026-11-07: Sticky notes are drawn as a box and can be resized

Decision. As in ScaleNote v1, a new sticky note is made by dragging a box with the note tool, and the note gets that size. A tap does nothing but show a hint. A note can be resized by selecting it (tap with the loop tool) and dragging the handle in its bottom right corner. A note is never shorter than its text needs, but it does not shrink when text is deleted.
Alternatives. Keep the tap with a default size next to the drag (the owner asked for the size not to be chosen for them); resize with edge handles or a pinch (more code, more ways to miss on a tablet).
Cost. Creating a note takes a drag instead of a tap, and a note that grew for a long text stays tall after the text is cut.

## 2026-11-07: Work done after 0.4.3 was merged ships as 0.4.4

Decision. 0.4.3 was merged and tagged with the pen width slider and the hidden page id. The sticky note boxes, the shape grid, the pen colours, the pinch zoom fix and the empty-page fix were made after that on the same branch and are a new release, 0.4.4, with its own branch and pull request. Drawing over text moves to 0.4.5, the `/canvas` block to 0.4.6, split mode to 0.4.7 and PDF import to 0.4.8. From now on work is not pushed to a branch whose pull request may already be merged: a new branch is made for each new request.
Cost. The plan numbers moved again.

## 2026-11-07: Paper and page colour are stored in drawing format 3

Decision. A drawing gets optional `paper` and `page` values, written only when one is set, as file format 3. A drawing without them is still written as before (format 1 or 2), so only drawings that use the new options need the new version. Page colours are stored by name and tinted per theme when drawn (multiply on a light background, a 75 percent mix with a darker tint on a dark one, found from the theme's background), so the same sixteen names work on all eight themes and any new theme. Paper spacings are multiples of the snap grid. New drawings are plain white with no lines.
Alternatives. Store real colour values (would look wrong on the other themes); store the settings per device (would not travel with the drawing); a screen blend for dark themes (tried, too bright and muddy).
Cost. ScaleNote 0.4.4 and older open a drawing with paper or page colour read-only, so every device must be updated.

## 2026-11-07: Loop moves snap by one anchor corner

Decision. When a selection is moved with the loop and snapping is on, the first shape or note in it has its first corner put on the grid and everything selected moves by the same amount. Pen lines follow without being snapped.
Alternatives. Snap every item separately (would change the distances between shapes); snap the middle of the selection (not on the grid for most shapes).
Cost. A selection of only pen lines is not snapped.

## 2026-11-07: Folder icons live in a hidden file in the vault

Decision. The icon style (folder, notebook, line) and colour (OneNote's sixteen section colours) of a folder are kept in `.scalenote/folder-icons.json` at the top of the vault, keyed by folder path, with an atomic, version-checked write. A hidden folder is never listed, searched or exported, and Obsidian ignores it. The file may be edited elsewhere, so it is treated as untrusted and never overwritten when it cannot be read or is newer. The picture colours are one set of mid-tones used on every theme.
Alternatives. A setting in the app (would not sync or follow the vault); text in each folder (folders have no file of their own, and it would clutter the vault).
Cost. A renamed or moved folder is followed only by renames made in ScaleNote; one renamed in another program loses its icon. Entries of deleted folders stay in the file.

## 2026-11-07: 0.4.5 is the owner's view and icon requests; drawing over text moves on

Decision. 0.4.5 holds the paper and page colour, lasso snapping and folder icons. Drawing over text becomes 0.4.6, the `/canvas` block 0.4.7, split mode 0.4.8 and PDF import 0.4.9.
Cost. The plan numbers moved once more.

## 2026-11-07: Highlights sit behind ink and are tidied against figures

Decision. Highlights are always painted behind shapes, pen lines and note text (and over note boxes), whatever order they were drawn in. A highlight that covers a rectangle, ellipse or note and goes only a little over its edge (half its width plus 12 units) is cut at the edge when drawn. The drawing file is unchanged: order and points stay as drawn, so nothing is lost and older versions read it as before.
Alternatives. Rewrite the stroke when it is drawn (loses what was drawn, harder to undo); reorder items in the file (changes the file for a drawing-only effect).
Cost. A highlight can no longer be put on top of a pen line on purpose. The text of overlapping notes can show through the note above.

## 2026-11-07: The highlight work ships as 0.4.6

Decision. The highlight request is bundled with split mode as 0.4.6, because it is too small for a release alone and split mode was the planned item that needs no format decision (draw over text and the `/canvas` block do). Drawing over text becomes 0.4.7, the `/canvas` block 0.4.8 and PDF import 0.4.9.
Cost. The plan numbers moved again.

## 2026-11-07: Split mode shows the one drawing next to the text, and the view a page opens in is a setting

Decision. Split is a third view of a page next to Text and Canvas. It shows the same drawing the Canvas view shows, beside the text (above it on a phone), with the text keeping the cursor. The view a page opens in is Settings > Drawing > Open pages in (Text by default). The markdown view is not offered beside a drawing.
Alternatives. A drag handle to change the split (more code, easy to misjudge with a finger, can come later); a second copy of the drawing (two copies to keep in step); keeping the markdown view available in Split (three things on screen).
Cost. The two halves are fixed at the same size. On a phone the text gets about half the height.

## 2026-11-07: The cut is saved in the stroke (drawing format 4)

Decision. This replaces the 0.4.6 decision that the stroke stays unchanged and the cut is worked out when painting. Tried on the tablet, that showed the overshoot again when the square was removed, and one long stroke that strayed far lost its cut completely. Now a finished pen or highlighter stroke over a figure gets a `clip` (the figure's shape), and a part that strays far is split off as a plain stroke. The pieces go in and out with one undo. Format 4 is written only when a clip exists; older versions open it read-only, so nothing is lost. The points are never changed.
Alternatives. Keep computing at paint time and remember the figure (breaks when the figure goes); cut the points themselves (loses what was drawn).
Cost. A drawing with cuts cannot be edited in 0.4.6 and older. Strokes made before 0.4.7 are not cut. A long stroke becomes a few items in the file.

## 2026-11-07: Recolour the selection is the extra feature of 0.4.7, and the plan numbers move again

Decision. The owner asked for "another feature" and left the choice to me. I chose recolouring the loop selection with the existing colour menu, because it is small, needs no file format change and removes a common redraw. Draw over text becomes 0.4.8, the `/canvas` block 0.4.9, PDF import 0.4.10.
Cost. The plan numbers moved again.

## 2026-11-08: One View menu instead of loose Canvas and Split buttons

Decision. The top bar had three view buttons that named where you would go, which wrapped to a second row on a phone. The owner likes labels that name the destination, so those stay, but they move into one View menu that lists all three views and ticks the current one (the owner asked for all three to stay in the list). Markdown keeps its own button, shown only with text, as an icon on narrow screens.
Alternatives. A segmented control that shows the current view (clearer where you are, but it needs four wide buttons and was not what the owner wanted).
Cost. One more click to reach Canvas or Split; the button does not show the current view (the page itself does).

## 2026-11-09: The toggle block outline will always be visible (planned for 0.4.8)

Decision. This will replace the 0.2.2 choice to show the box around a toggle only while working in it. The owner finds it unclear where a toggle block is when no outline shows. Not built yet; it goes into 0.4.8 when the owner asks to start it.
Cost. More lines on a page with many toggles; keep the resting outline quiet.

## 2026-11-11: Empty lines are saved as extra blank lines

Decision. An empty line in the editor is written as one more blank line in the file, and read back from it. One blank line between blocks is the normal separation, so only the extra ones count. After a last block that is not a paragraph the editor keeps one empty line by itself, which is not saved. Empty lines inside a toggle or a callout are still dropped.
Alternatives. A marker such as `&nbsp;` on its own line (visible and ugly in Obsidian, and not plain markdown); not keeping them (what happened before: pressing Enter a few times was undone when the page was reopened).
Cost. A page written by hand with several blank lines in a row now shows them as empty lines.

## 2026-11-11: Folded toggles are remembered while the app is open, not in the file

Decision. Which toggles are folded is kept by the editor and remembered per page until the app is closed. A page seen for the first time since the app started has every toggle folded, even one the file marks as `<details open>`. Nothing about it is written to the page. The always-visible outline replaces the 0.2.2 choice.
Alternatives. Saving the state in the file (changes the page for a view setting).
Cost. After restarting the app every toggle is folded again.

## 2026-11-11: History is compared by blocks when shown as the page looks

Decision. Opened from the normal text, the History box shows versions as formatted text and splits them into whole blocks (a list, a table or a toggle is one piece) so every part can be shown as the page looks and put back whole. From the Markdown view it still compares line by line. Putting back is exact either way.
Cost. A change inside a long list shows the whole list on both sides.

## 2026-11-11: Tags start folded, and renaming a page updates links to it

Decision. Main tags start folded; a filter lists every match. Renaming a page (in the list or from its title) finds the pages that link to it first, then changes only the page name inside each matching link, keeping a link that was written with folders or with `.md` in that form. A page that cannot be written is reported and the rename stands. Folder renames and moves are not covered.
Cost. A link written with a folder path breaks if its folder is renamed.

## 2026-11-11: Draw over text moves to 0.4.9

Decision. 0.4.8 is already large, so draw over text moves to 0.4.9 together with columns and the Android in-app installer. The `/canvas` block becomes 0.4.10 and PDF import 0.4.11. The Linux two-finger zoom problem (the web engine zooms the whole window) is known and not yet fixed or investigated.

## 2026-11-11: On Linux the faster web view drawing path is switched off at startup

Decision. ScaleNote sets `WEBKIT_DISABLE_DMABUF_RENDERER=1` at the start of the program on Linux, before the web view exists, unless the person has already set that variable (even to `0`). This fixes the text turning bold on long pages. The owner confirmed it on Linux Mint: this setting and `WEBKIT_DISABLE_COMPOSITING_MODE=1` each fixed it, and with neither it stayed. The solid-background change from 0.4.8 did not fix it, and the release notes of 0.4.8 were wrong to call it fixed.
Alternatives. Switching off compositing completely (heavier, and the other setting was enough); changing the page so the web view draws it differently (tried in 0.4.8, no effect).
Cost. Somewhat slower drawing on Linux. Tauri's Linux notes describe this setting. If another system shows the same bug under other conditions, this may need to be revisited.

## 2026-11-11: A small 0.4.9 for the Linux text fix, later plans move up one

Decision. The Linux fix is its own small release, so the owner can test it. Draw over text, columns and the Android in-app installer become 0.4.10, the `/canvas` block 0.4.11 and PDF import 0.4.12.
Also noted. Handwriting to text moves to after v1: use the system recognisers on Windows and Android, wait for Linux until there is a good small offline option, offer packs as optional downloads, English first and Dutch later. A Fedora install check of the .rpm is wanted around 0.8.

## 2026-11-11: A different kind of list after a blank line starts a new list

Decision. When a blank line is followed by a list item of another kind (a to-do list, a numbered list with a different closing mark, or a bulleted list with a different bullet), it starts a new list. Before, any list item after a blank line continued the old list, so lists written one after another by the editor itself came back as one "kept exactly as written" block. The text is still kept to the byte either way. A list with blank lines between items of the same kind is still kept as written, so the editor never removes those blank lines.
Cost. A hand-written loose list that mixes a plain bullet with a to-do item is now two lists; its text is unchanged unless the owner edits it.

## 2026-11-11: Image size is written Obsidian-style; image controls become 0.4.13

Decision. When images can be resized, the size is written inside the picture's description, as `![alt|300x200](path)` (or `|300` for width alone). It is the simplest form that keeps the line a normal markdown image and that Obsidian also reads. Only a `|` followed by a number, or by `numberxnumber`, at the very end of the description counts as a size. A missing or odd size means the natural size. No Obsidian code is used.
Scope. The same eight handles as ScaleNote v1: corners scale and keep the proportions, edges stretch or thin; a 50 px minimum; mouse and touch; plus Reset to original size. No rotate, flip, crop or colour controls (v1 had none).
Also. The version plan moves up: 0.4.10 is this list fix, draw over text, columns and the Android installer are 0.4.11, the `/canvas` block 0.4.12, image controls 0.4.13 and PDF import 0.4.14.

## 2026-11-11: Callouts, toggles, tables and images may sit inside a toggle or a callout; raw text has no frame

Decision. This replaces the earlier rule that a callout inside a toggle or callout stays raw. Each block inside a toggle or callout is read with the reader for its kind, the same ones as at the top of a page, so a callout, a toggle, a table or an image inside one is a real block. Nesting deeper than eight levels stays raw. A block that is not changed is still written back byte for byte; a changed one is written in the one fixed layout.
Also. Text the editor cannot show as a block is shown as plain page text: no dashed frame, no "Kept exactly as written" label (the label is now only the name read out by a screen reader), wrapped like the rest of the page. The owner never wants the labelled block seen. The safety net itself stays, because unknown markdown must be kept byte for byte.
Alternatives. Dropping the unknown text from the page (loses content, not allowed); making every unknown syntax a real block (not possible now).
Version numbers named in earlier entries have since moved up by one or two; the table in PROGRESS.md is the current plan.
Cost. A raw piece now shows its markdown signs in page text, without a warning that it is a raw piece. Common causes should be fixed one by one as they are found: this release fixes callouts in toggles; loose lists are the next likely one.

## 2026-11-11: The 0.4.9, 0.4.10 and 0.4.11 changes are released as one 0.4.9

Decision. The owner deleted the first 0.4.9 and 0.4.10 releases. The Linux text fix, the list fix and the toggle and raw-text fix are released together as 0.4.9. The plan goes back down: draw over text, columns and the Android in-app installer are 0.4.10, the `/canvas` block 0.4.11, image controls 0.4.12 and PDF import 0.4.13. Version numbers named in earlier entries of this file are older; the table in PROGRESS.md is the current plan.


## 2026-11-11: Release plan: 0.4.10 draw over text, 0.4.11 one big release (canvas block, image controls, PDF)

Decision. The owner asked to merge the former 0.4.11 (`/canvas`), 0.4.12 (image controls) and 0.4.13 (PDF import) into one release, 0.4.11, accepting that it is big. 0.4.10 is draw over text (built), with columns and the Android in-app installer still to come in it. Version numbers named in earlier entries are older; the table in PROGRESS.md is the current plan.
Alternatives. Keeping three small releases (smaller steps to test on a device, rejected by the owner).
Cost. 0.4.11 is large and touches the markdown format, the editor and the drawing format together; it should be built in short slices on separate branches and only released at the end.

## 2026-11-11: Ink over text is anchored to blocks and lives in format 5 of the drawing file

Decision. A stroke drawn over the text belongs to the block of the text under its first point and its points are fractions of that block. The block is found again by its place and a fingerprint of its kind and first 40 characters; a stroke whose block cannot be found is kept in the file and not drawn. The ink is a separate `ink` list in format 5, written only when ink exists; older versions read such a file as read-only. The pen bar is a row above the text, using the canvas's colour menu and width slider.
Alternatives. One transparent canvas over the whole editor in pixel positions, as ScaleNote v1 does (ink drifts off the words when the width changes); block ids written into the markdown (would change the page text, against the clean-markdown rule); putting anchored items in `items` (the canvas view would draw them at wrong places and the eraser and loop would touch them); a floating pen bar (covers the first lines of the page); v1's custom colour (needs a new colour format and does not follow the theme).
Cost. Editing the first words of a block detaches its ink until the words come back; a stroke over several blocks belongs to the first one only, so it moves with that block alone; a block's height matters because vertical positions are fractions of it.

## 2026-11-11: Columns are a callout holding column callouts

Decision. The owner wants the same behaviour as Notion and left the format to me, asking only that it is stable, safe and simple. A columns block is `> [!columns]` (no title, no fold) holding 2 to 5 `> > [!column]` callouts. Obsidian opens the page and shows the text as nested callouts. Anything that does not have exactly that shape stays an ordinary callout, kept byte for byte, so no page can lose text. Columns do not nest; a column holds what a callout holds.
Alternatives. An html table (rejected: Obsidian and other programs show it badly and the exact-text rule is harder to keep), a custom code fence (rejected: other programs show it as code).
Cost. Ink over columns anchors to the whole columns block. Other programs show columns stacked, not side by side.

## 2026-11-11: The Android installer lives in a small generated Kotlin class

Decision. The owner chose "build it, you test the APK". The Rust core stays free of network code: a Kotlin class added at build time by `scripts/patch-android.mjs` downloads the file from this project's GitHub releases only, checks size and that it is a zip, and opens Android's installer through a FileProvider of its own. The user still confirms in Android's screen. Any failure falls back to the browser download.
Alternatives. Network code in Rust (rejected before: new dependency and attack surface), silent install (not possible without system rights).
Cost. The Kotlin has never been compiled or run by me; the CI build is the first compile and the owner's tablet the first real test. The permission "install unknown apps" must be allowed once by the user. The APK is still unsigned beyond the debug key, so Android updates over an installed build only if the signing key is the same.
