# Security checklist, version 0.6.8

Checked by the builder by reading, searches and automatic tests. Not an outside review. Everything from 0.6.7 still applies. The checks across the whole 0.6 line are in `security-checklist-0.6.md`.

| Item | Result |
|---|---|
| Sync now and Compare wait up to 60 seconds for a running sync, a sync started by another device up to 5 seconds; nothing else changed in who may sync or what is sent. Two devices that start a sync with each other at the same moment each give up after the short wait, so neither waits for ever | Rust test with two services on loopback |
| The Pen test keeps only the names of keys pressed (key, code, number; at most 20) and only on its own page; it has no text field and sends nothing | Browser test, reading |
| Pen buttons that send Page Down or Page Up only change the drawing tool or undo/redo while drawing; in a dialog, a text field or with a modifier key held they do nothing | Unit and browser tests |
| Pen colours too dark for a dark page are drawn lighter; only the drawing changes, the stored colour name stays the same | Unit test against every theme and page colour |
| Two libraries in Tauri's own dependencies had new advisories this week: `cookie` 0.18.2 (RUSTSEC-2026-0594, private cookie nonces can repeat after a fork) and `url` 2.5.8 (RUSTSEC-2026-0592, stack overflow on nested `blob:` URLs). Updated in the lock file to the fixed `cookie` 0.18.3 and `url` 2.5.9 (with `form_urlencoded` 1.2.3); ScaleNote does not fork or parse `blob:` URLs itself | `cargo audit`: 0 vulnerabilities after the update |
| Open risk | Not tried on real devices: the waiting sync with three devices, the pen keys on a tablet pen |
