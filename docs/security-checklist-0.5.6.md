# Security checklist, version 0.5.6 (in progress)

Checked by the builder by reading, searches and automatic tests. Not an outside review. Everything from 0.5.5 still applies.

| Item | Result |
|---|---|
| The words of an imported page are kept only beside a picture that exists directly in `attachments/` (no other folder, no `..`, no hidden names), at most 1 MB, written atomically. The app never runs or interprets the file; Rust only stores it | Rust test (`page_words_are_kept_beside_a_picture_and_nowhere_else`) |
| A words file from another device is untrusted: it is read only if it is the known format, wrong entries are skipped, boxes are kept inside the picture, sizes and counts are limited, and the text is only ever shown as text | Node tests (`tests/imagetext.test.mjs`) |
| The width of a PDF in a page is a whole number between 240 pixels and the page's width; an odd number after the name is kept as plain text | Node tests |
| App lock: the PIN or passcode is never stored; only a random salt and a PBKDF2-SHA256 hash (300,000 rounds) in a private file (mode 600) in the app's own folder, never in a vault. Compared in constant time. After 5 wrong tries each try waits longer (30 s doubling to 15 min); the count survives a restart | Rust tests (`applock`, 5) |
| While locked, every command that reads or writes pages refuses ("locked"): `with_vault`, opening a folder and the folder root used by sync screens. The app starts locked when a lock is set | Reading; the browser tests check no page names appear before unlocking. The Rust glue is compiled by CI only |
| A typed PIN or passcode is wiped from memory after use (`zeroize`); it is never logged | Reading |
| A damaged lock file counts as no lock (whoever can change that private file can read the pages directly; a lock that never opens would cost the pages). A file asking for fewer than 1,000 rounds is not trusted | Rust test |
| Fingerprint or face unlock (Android) is asked from Rust through the system's own prompt; the window's scripts get no permission to call the plugin. It only works when the lock is on and the person turned it on | Reading; device: Android |
| Zoom: the window zoom command refuses anything outside 80% to 200% | Reading |
| New dependencies, all pinned: `pbkdf2` 0.12.2 (RustCrypto, same `hmac`/`sha2` versions as before), `tauri-plugin-biometric` 2.5.0 (Android and iOS only, brings `objc2-local-authentication` for Apple), `zeroize` in the app (already used by the core). No existing package changed version | `Cargo.lock` diff |
| Open risk | The Rust commands for the words file, the lock, the fingerprint and the zoom are only compiled by CI; none was tried in the packaged app or on a device. The lock does not encrypt the pages |
