# Security checklist, version 0.5.0

Checked by the builder by reading, searches and automatic tests. Not an outside review. Items marked "device" still need a try on a real device.

| Item | Result |
|---|---|
| No network code: this version adds no listening, no sending and no discovery. The sync rules only read folders and compare lists | Reading of the diff, search for network calls |
| The file list read from text (it will come from another device later) is treated as untrusted: size limit 64 MB, 200,000 files, path length 1,024 bytes, name length 255 bytes, 32 folders deep; exact header, exact line shape, lower case 64-digit hashes, no repeated path; any path that is absolute, has `..`, `.`, a backslash, a hidden folder or a temporary-file ending is refused | 3 Rust tests with bad input |
| Scanning a vault never follows links, so a link cannot make the list (or later a sync) read or write outside the vault; links and other odd entries are reported, not read | Rust test with real links |
| Files that are too big (over 256 MB), unreadable, or have names other systems cannot hold are left out and reported, never read in full into memory (hashing streams the file), and never treated as deleted | Rust tests with real folders |
| The planner never loses text: both versions of a conflict are kept, a delete that meets an edit keeps the edit, deletes are only ever planned as "move to the trash", and the first sync (no earlier list) plans no delete at all | Rust tests |
| Two names that differ only by upper/lower case are reported, not created side by side; conflict copy names always fit in a file name and never reuse a name in use | Rust tests |
| Device identity: a random 128-bit id from the system's random source (no fallback to a weaker one); the name is cleaned to letters, digits, `-` and `_` (max 40 characters) both when saved and when read back, so a changed settings file cannot put odd characters into file names; a settings file that is damaged or over 4 KB is replaced, not trusted | Rust tests |
| The device settings are written atomically (temporary file, then rename) and live in the app's own data folder, outside every vault | Reading of the diff, Rust tests |
| Secrets: none are created yet. Pairing keys (0.5.1) will go into the system's secure storage | n/a |
| Two new dependencies, both pinned to exact versions: sha2 0.10.9 (SHA-256, used to tell whether file content is the same) and getrandom 0.3.4 (system random numbers). Both were already in the build as parts of other libraries; no other version appeared in the lock file | `Cargo.lock` diff |
| No new `unwrap()` or `expect()` in Rust code outside tests | Reading of the diff |
| The page policy is unchanged; the interface adds no inline styles and no typed text outside the language file | Browser tests under the policy |
| The assistant is still off and absent from the interface | Browser test |
| Open risk | Device: the Tauri app crate (`lib.rs`) was not compiled here because the system libraries are missing; CI compiles it. The Sync tab on a real Android phone and on Windows |
