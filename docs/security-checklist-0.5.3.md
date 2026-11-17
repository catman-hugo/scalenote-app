# Security checklist, version 0.5.3

Checked by the builder by reading, searches and automatic tests. Not an outside review. Items marked "device" still need a try on real devices.

| Item | Result |
|---|---|
| Only paired devices can start a sync; anyone else is refused before any request is read. The key checks from 0.5.1 still decide who is paired | Rust tests with a stranger and a removed device |
| Everything from the other device is untrusted: messages are at most 60,000 bytes, a file at most 64 MiB, a list at most a fixed number of entries, with exact formats; anything else ends the sync with a calm error | Rust tests (huge, garbage and cut messages) |
| Paths from the other device are checked: no `..`, no absolute paths, no hidden or app folders, no links followed, no names that clash by case; a bad path is refused, never written | Rust tests with hostile paths and a link in the folder |
| A received file is written to a temporary file and renamed, so killing the app mid-sync leaves either the old or the new file | Rust tests (cut connection); existing atomic write tests |
| Every change is checked against what the file was a moment ago; if it changed meanwhile it is left for the next sync instead of overwritten | Rust tests (change during sync) |
| Nothing is deleted for good: a deleted file goes to the trash of the other device. A missing or damaged "last matched" list means a first sync, which never deletes | Rust tests |
| The first sync with a device changes nothing until the user says yes. Automatic sync never does a first sync | Rust and browser tests |
| Conflicts keep both versions; the older one is saved as a copy | Rust tests |
| Code from the network is never run; no new dependencies | Reading of the code; `Cargo.toml` and `Cargo.lock` diff |
| No secret in the folder, logs or messages. The "last matched" list holds only paths and file hashes, in the notes folder | Reading of the code |
| Pause stops starting and answering syncs and announcing; it is in memory only | Rust and browser tests |
| No new `unwrap()` or `expect()` in Rust code outside tests | Reading of the diff |
| No typed text in the interface code; no inline styles; the assistant is still absent | Browser tests under the policy |
| Open risk | Device: only tried between two services on one computer. Real discovery, real Wi-Fi, Android and Windows are untried. The Tauri app crate (`lib.rs`) was not compiled here; CI compiles it. A paired device now announces its name on the local network while sync is on. Every sync reads and hashes the whole folder (slow for very large folders). The canvas view is not refreshed when a file changes outside; folder names that differ only by case are not detected |
