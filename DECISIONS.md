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
