# Security checklist, version 0.6.2

Checked by the builder by reading, searches and automatic tests. Not an outside review. Everything from 0.6.1 still applies.

| Item | Result |
|---|---|
| "Pages as images" has no page limit; for over 100 pages or over 100 MB of pictures it asks first with the guessed space, and Cancel stores nothing. The limits per picture (4 million pixels, two pages in memory at once) are unchanged, so a long PDF takes longer but not more memory | Node test (`tests/pdf.test.mjs`); browser tests (101 pages asks, Cancel stores nothing, Yes adds 101 pictures) |
| A PDF may be up to 64 MB (was 25 MB), checked in the interface and again in Rust (`MAX_PDF_BYTES`), the same as the largest file sync sends. The whole file still travels to the interface as one text, so a 64 MB PDF uses about 85 MB of memory while it is read | Rust tests (`attachments`); browser tests (30 MB says its size, 65 MB refused before any question) |
| The folder colours file from another device is merged folder by folder: only format 1 with an `icons` object, at most 5,000 entries, values kept as they are (the interface checks them when drawing); anything else falls back to the newer file as before. The last synced copy is kept per device in `.scalenote/sync-settings-<device>.json`, never synced, read with a 4 MB limit | Rust tests (`settings_merge`, and a sync between two services) |
| New dependency in the core: `serde_json` 1.0.154, already in the lock file through Tauri, pinned to that version. `if-addrs` 0.15.0 was already used for Tailscale | `Cargo.lock` diff (the core now lists `serde_json`; no version changed) |
| Closing the window with the tray on ends the window and its web view; sync goes on in Rust. The program only keeps running without a window while the tray icon exists and the exit was not asked for with a code (the tray's Quit and updates still end it) | Reading (`tray.rs`, `lib.rs`); compiled by CI only |
| Two fingers with Finger draws on only move, zoom or scroll the view; nothing is drawn or saved by them, and the start of a line from the first finger is dropped | Browser tests (canvas and text) |
| Sync checks a paired device every 30 seconds when nothing changed here (was 5 minutes): the same encrypted connection and checks; only file lists travel when nothing changed | Reading (`RESYNC_AFTER`); Rust test for the activity line |
| Open risk | The tray change and the two-finger moves were not tried on a device; the tray change is only compiled by CI |
