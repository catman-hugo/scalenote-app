# Security checklist for the whole 0.6 line (0.6.0 to 0.6.8)

Checked by the builder by reading, searches and automatic tests. Not an outside review. It gathers the per-version lists (`security-checklist-0.6.0.md` to `-0.6.8.md`) and adds what was checked again across the whole line on 2026-11-26. Everything from the 0.5 line (`security-checklist-0.5.md`) still applies. Items marked "device" still need a try on real devices.

## Checked again for this list (2026-11-26)

| Check | Result |
|---|---|
| Known vulnerabilities in JavaScript libraries (`npm audit`, all and without development ones) | 0 found |
| Known vulnerabilities in Rust libraries (`cargo audit` 0.23.0, RustSec database of 2026-11-26, 548 crates) | 2 found, both new this week and both in Tauri's own dependencies: `cookie` 0.18.2 (RUSTSEC-2026-0594) and `url` 2.5.8 (RUSTSEC-2026-0592). Updated to the fixed `cookie` 0.18.3 and `url` 2.5.9; then 0 vulnerabilities. 6 warnings remain, the same kind as in the 0.5 list and all inside Tauri's Linux window toolkit (GTK, D-Bus): `chrono`, `proc-macro-error`, `zbus_names`, `zvariant`, `zvariant_derive` no longer maintained, and `glib` 0.18.5's unsound `VariantStrIter` (RUSTSEC-2024-0429), which ScaleNote does not use |
| `unwrap()` or `expect()` in Rust code outside tests (core, sync, server, app) | None |
| Personal details in the repository (real names, device names, addresses, network names) | One real first name was left in a test variable; renamed. Otherwise none; addresses are made-up examples |
| App commands added in the 0.6 line while the app lock is closed | Every command that reads or writes pages, shares, storage, search on other devices, keep choices and capture refuses ("locked"), through the same check as before. Still answering, and holding no page text: the name for sharing (`account_get`), the open page's name for share timing (`share_page_open`), throwing away things waiting to be captured (`capture_dismiss`), and the shortcut and tray switches |
| New dependencies in the whole line | `serde_json` 1.0.154 (0.6.2, already in the lock file through Tauri), `tauri-plugin-single-instance` 2.5.5 and `tauri-plugin-global-shortcut` 2.4.1 (0.6.6, official Tauri plugins, computers only), all pinned |
| Tests | Rust (core and app), JavaScript and browser tests all passing on 2026-11-26; numbers in the 0.6.8 pull request |

## The whole line, by area

### What each device keeps (0.6.0, 0.6.3, 0.6.5)

| Item | Result |
|---|---|
| A file a device does not keep is never sent to it and never read as deleted, on either side, whoever starts the sync | Rust tests |
| Free up space only removes a file that a paired device of one's own had in exactly this version (saved lists of one's own devices only, not share syncs), checked again by hash right before removing; the removed list is written first, so a crash is harmless | Rust tests |
| The other device's and this device's choices are untrusted: safe paths only, at most 10,000 choices, kinds only `t`, `d`, `i`, `f` (or `-`); a damaged own file means "keep everything" | Rust tests |
| Bringing a page that is not here only reads from a paired device over the encrypted connection; its links are read as text only | Rust tests |
| Folders and pages with files not on this device cannot be renamed, moved or deleted | Rust and browser tests |

### Finding devices (0.6.1)

| Item | Result |
|---|---|
| The "I'm here" note gives no trust and goes only to private and link-local networks, never mobile data, Tailscale or loopback; Wi-Fi only allows nothing more than local networks | Rust tests; device |

### Sharing with other people (0.6.4)

| Item | Result |
|---|---|
| An unpaired device can only send one invitation, one answer or open a share sync; messages at most 16 KB with fixed fields; an invitation makes no file until accepted | Rust tests |
| A share sync is only served to a device in that active share and sees only that share's pages and the attachments they link; ids are random 16 bytes, sent encrypted only to the invited device | Rust tests |
| Share records are checked when read (ids, names, safe paths, key lengths, at most 500 shares and 50 people); a damaged list is never saved over | Rust tests |
| Being findable is off until switched on and needs a name; only the name and account id go out | Rust tests; device |

### Search and storage (0.6.5)

| Item | Result |
|---|---|
| Search on other devices is answered only for one's own paired devices, the query at most 800 bytes, at most 4 seconds and one 48 KB answer; answers are checked (50 results, safe `.md` paths, short text) and the query is never logged | Rust tests |
| Storage counts sizes only, follows no links and stops at fixed limits | Rust tests |

### Sharing into ScaleNote (0.6.6)

| Item | Result |
|---|---|
| Everything shared in goes through one checker in Rust: links only `http`, `https`, `mailto`; files by their bytes, not their name; text only valid UTF-8 up to 1 MB; nothing is run; a page is never replaced | Rust and browser tests |
| Limits on how much waits and is held in memory; on Android only copies in the app's own cache folder are read | Rust tests; device |
| "Open with" never makes ScaleNote the default program; the shortcut and tray are off until switched on | Installer tests, reading; device |

### Folder sync and the fixes after testing (0.6.7, 0.6.8)

| Item | Result |
|---|---|
| Folder names from another device pass the same checks as file paths; only empty folders are ever removed; folder requests only between one's own devices | Rust tests |
| Ink reloaded after a sync never replaces ink being drawn or not yet saved | Browser tests |
| Waiting for a running sync is limited (60 seconds by hand, 5 seconds for a sync from another device) | Rust test |
| Pen keys act only while drawing and never in a text field or dialog | Unit and browser tests |

## Open risks for the line

- Nothing in the 0.6 line has had an outside review.
- Device tests still to do: keeping part of the folder on a laptop and a phone over several days, sharing with another person, Open with and Send to on Windows and Linux, sharing from other Android apps, the pen keys on a tablet pen.
