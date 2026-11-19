# Security checklist for the whole 0.5 line (0.5.0 to 0.5.6)

Checked by the builder by reading, searches and automatic tests. Not an outside review. It gathers the per-version lists (`security-checklist-0.5.0.md` to `-0.5.6.md`) and adds what was checked again across the whole line on 2026-11-19. Items marked "device" still need a try on real devices.

## Checked again for this list (2026-11-19)

| Check | Result |
|---|---|
| Known vulnerabilities in JavaScript libraries (`npm audit`, all and without development ones) | 0 found |
| Known vulnerabilities in Rust libraries (`cargo audit` 0.22.0, RustSec database of 2026-11-19, 509 crates) | 0 vulnerabilities. 6 warnings, all inside Tauri's Linux window toolkit (GTK, D-Bus) and none in code ScaleNote calls itself: `chrono`, `proc-macro-error`, `zbus_names`, `zvariant`, `zvariant_derive` no longer maintained; `glib` 0.18.5 has an unsound iterator (`VariantStrIter`, RUSTSEC-2024-0429) that ScaleNote does not use. They go away when Tauri moves to newer versions |
| `unwrap()` or `expect()` in Rust code outside tests (core, sync, server, app) | None |
| Personal details in the repository (device names, addresses, email, server names) | None. The only addresses are made-up examples (`192.168.1.x`) |
| Which app commands still work while the app lock is closed | Every command that reads or writes pages refuses ("locked"). This check found that pairing, joining, comparing, syncing by hand, renaming and removing devices, and the sync switch still answered while locked; they now refuse too. Still answering: the lock itself, the app settings (folder paths, look), the sync status (device names, times, counts; no page text), pause, and the Wi-Fi state. Automatic sync keeps running inside Rust, by design, so pages stay in step while the screen is locked |
| Tests | Rust core 266, JavaScript 320, browser 413 (run alone), all passing on 2026-11-19 (the run also checks that no app file goes over the local network) |

## The whole line, by area

### Between devices (0.5.1 to 0.5.3)

| Item | Result |
|---|---|
| Everything between two devices goes through an encrypted, mutually authenticated connection (Noise XX with 25519 keys, ChaCha20-Poly1305, SHA-256; `snow` 0.10.0). A device is trusted only by its pinned public key, never by its name or address | Rust tests with real connections |
| Pairing uses a one-time 8-digit code with SPAKE2 (`spake2` 0.4.0): the code is never sent and cannot be worked out from what is sent; a tag (HMAC-SHA256) over both keys stops a device in the middle. The code lives 120 seconds, allows 3 tries and dies when pairing closes | Rust tests, including a relay in the middle |
| A device that is not paired may only pair; anything else is refused before a request is read. A removed device is refused again | Rust tests |
| Everything received is untrusted: messages at most 60,000 bytes, a file at most 64 MiB, lists with fixed limits and exact formats, at most 8 connections, timeouts; anything else ends the sync calmly | Rust tests with huge, garbage and cut messages |
| Paths from the other device: no `..`, no absolute paths, no hidden or app folders, no links followed, no names that clash by case | Rust tests with hostile paths and links |
| Writes are atomic (temporary file, then rename); a file changed during a sync is left for the next one; nothing is deleted for good (it goes to the trash); the first sync with a device changes nothing until the person says yes, and automatic sync never does a first sync | Rust and browser tests |
| Conflicts keep both versions | Rust tests |
| Each paired device belongs to one notes folder; a sync in another folder is refused on both sides, so two folders or two server vaults never mix (0.5.6) | Rust tests with two "server vaults" on one phone |
| Discovery notes are at most 200 bytes with an exact format; at most 16 devices are kept; a device's address comes from where the note came from, never from its text; notes carry only name, port and public key, and are sent on the local network only | Rust tests with garbage and floods; device |
| A device listens only while sync is on and a device is paired or a pairing code is showing, and announces itself only while sync is on and not paused | Rust tests |
| The version a device reports is only digits and dots, at most 20 characters | Rust test |

### Keys and secrets

| Item | Result |
|---|---|
| The device's private key is never in the vault, a log, an error text or debug output; memory holding it is wiped (`zeroize` 1.8.2). Windows: the system credential store (`keyring` 3.6.3). Linux and Android: a file only the user can read, in the app's own folder | Rust tests; Windows store: device |
| The app lock keeps no PIN or passcode, only a salted PBKDF2-SHA256 hash (300,000 rounds, `pbkdf2` 0.12.2) in a private file; compared in constant time; growing waits after 5 wrong tries that survive a restart; a typed PIN is wiped from memory after use | Rust tests (5) |
| Fingerprint or face unlock (Android) is asked from Rust through the system's own prompt; the window's scripts cannot call the plugin | Reading; device |

### Home server (0.5.5)

| Item | Result |
|---|---|
| Same sync code as the apps; each vault has its own port, key and paired devices, and a device paired with one vault is refused by another | Rust tests |
| The data folder is private (mode 700, refused if others can read it or if it is a link) and is checked against the vaults before it is made, so keys never sit inside a vault | Rust tests; real run |
| Pairing on the server goes through a private file, not a network port; the code file is private and written in one step | Rust tests; real run |
| The config is plain text with limits (64 KiB, 20 vaults, ports from 1024, full paths, plain vault names) | Rust tests |
| The add-only inbox moves only plain, settled `.md` files of at most 1 MiB from a folder outside the vaults; never overwrites or deletes | Rust tests |
| The example service runs as its own user with NoNewPrivileges, PrivateTmp, ProtectSystem=strict and ProtectHome | Reading; device |

### Files and pages

| Item | Result |
|---|---|
| Backups are plain copies beside the vault; a restore takes only a listed backup name, deletes nothing and keeps every replaced file first | Rust tests |
| Words of imported PDF pages are kept only beside a picture that exists directly in `attachments/` (at most 1 MB); when read back they are checked as untrusted (format, sizes, boxes inside the picture) | Rust and JavaScript tests |
| A PDF's width is a whole number in a fixed range; anything else stays plain text | JavaScript tests |
| Unknown Markdown is kept byte for byte; opening a vault never loses content | Tests from earlier versions, still passing |

### The app on the device

| Item | Result |
|---|---|
| Android permissions are the smallest that do the job (network state, Wi-Fi state, multicast) plus what fingerprint unlock needs; none reads the network's name or address | JavaScript test of the manifest patch; reading |
| Tray and open at login are off by default; the window's scripts cannot call the login plugin directly | Reading; device |
| Window zoom accepts only 80% to 200% | Reading |
| The page's security policy is unchanged; no inline styles; every sentence comes from the language file; the assistant is off and absent | Browser tests under the policy |
| Dependencies are pinned to exact versions; each new one was checked against its documentation and the lock file only gained packages | `Cargo.lock` and `package-lock.json` diffs per version |

## Open risks

- **Never tried for real:** almost nothing of 0.5 has been tried on real devices together. Real Wi-Fi discovery, Android in the background, the Windows credential store, the home server over days and over Tailscale, the tray, open at login, the app lock and fingerprint unlock are all untried. The Tauri app code (`lib.rs`, `lock.rs`, `tray.rs`) is only compiled by CI.
- **The lock does not encrypt:** pages are plain files by design. Whoever can read the device's files can read the pages without the lock. Forgetting the PIN on Android means the pages in the app cannot be opened there.
- **Linux and Android keys:** on Linux and Android the device key is a private file, not the system's secure storage.
- **The local network sees some things:** anyone on it can see that two devices talk and what they are called, and can try a pairing code (3 tries per code, and only while one is showing).
- **The server stops on a kill signal without saying goodbye.** Pages are safe because every write is atomic, but a sync in progress is cut and done again.
- **Sync goes on while locked, by design:** after the app locks itself again with a folder open, automatic sync continues. Pages stay in step, but a device paired earlier also keeps receiving changes while the screen is locked.
