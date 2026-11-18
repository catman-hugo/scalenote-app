# Security checklist, version 0.5.5

Checked by the builder by reading, searches and automatic tests. Not an outside review. Items marked "device" still need a try on a real server. Everything from 0.5.4 still applies.

| Item | Result |
|---|---|
| The server uses the same sync service as the apps: the same encrypted connection, pairing and trust list. No new protocol and no new network code | Reading; Rust tests with real connections |
| Each vault has its own service: its own port, device key and list of paired devices. A device paired with vault A is refused by vault B | Rust test (`a_phone_paired_with_one_vault_cannot_reach_the_other...`) |
| A vault's port is exact. If it is taken the vault reports an error instead of moving to a neighbour's port | Rust test |
| Vault folders cannot overlap, be the same, or hold the data folder, so a vault never contains keys and two vaults never share files | Rust test with nested, equal and missing folders |
| The data folder (keys, paired devices) is made with mode 700; the program refuses to start if group or others have any access, or if it is a link | Rust test; real run |
| Key files are written private from the start (mode 600, temporary file then rename); the pairing code file is mode 600 and is removed when pairing closes | Rust test |
| The config file is plain text, at most 64 KiB, with a vault limit of 20, ports from 1024, full paths only, and plain vault names (a to z, 0 to 9, - and _) because the name becomes a folder name | Rust tests with odd and huge input |
| The server never runs code from anything received. The pairing command works through a file in the private data folder, not a network port or a socket | Reading |
| The pairing code is only ever shown on the console of the person who runs the command; it is not logged | Reading |
| A vault that cannot start (taken port, unreadable key) is left out and reported; the other vaults keep running | Rust test |
| The example service file runs as its own user with NoNewPrivileges, PrivateTmp, ProtectSystem=strict and ProtectHome, and can write only to the data and vault folders | Reading; server: device |
| No new dependencies. No new `unwrap()` or `expect()` in the server code outside tests | `Cargo.toml` diff; reading |
| Backups are plain copies. A restore only accepts a name from the list of backups, so a made-up path cannot reach outside the backups folder; it deletes nothing and keeps each replaced file first; links and hidden entries are skipped; size and depth limits apply | Rust tests (`only_a_listed_backup_can_be_restored_never_a_made_up_path` and others) |
| The inbox moves only plain, settled `.md` files of at most 1 MiB, valid text, from a folder outside the vaults; it never overwrites, never deletes pages, ignores links and hidden files, and puts rejects in a capped folder | Rust tests (6) |
| The version a device sends is only digits and dots, at most 20 characters; anything else is dropped | Rust test with hostile text |
| The folder colours in the settings file are checked against the known colour names and path rules; a folder called `__proto__` is just a key | Node tests |
| Tray and open at login: off by default; the window's scripts get no permission to call the login plugin directly, only our own commands do; a failed tray start turns the switch off again so the window cannot be hidden with no way back | Reading; browser tests with a stand-in. Rust side compiled by CI only; device: Windows and Linux |
| New dependency: `tauri-plugin-autostart` 2.7.0 (pinned with `=`) and what it needs (`auto-launch` and a few platform crates); the lockfile only gained packages, no existing package changed version | `Cargo.lock` diff |
| The server and inbox tests run on Linux and other Unix-like systems only, because the server is a Linux program; the backup tests run on Windows too | CI |
| The data folder is checked against the vaults before it is created, including through "." and links; a path with ".." in a missing part is refused (found in review: before, a missing data folder skipped the check) | Rust test; real run |
| The pairing code file is written to a temporary file and renamed, and the `pair` command never shows an empty code | Rust test; real run |
| A device paired with two server vaults is not tied to one local folder, so the guide says not to do that yet. Fixing it properly (each pairing remembers its folder) is planned for 0.5.6 | Reading |
| Open risk | Device: never run for days on a real server; restart, power cut and disk-full tests on the server are still to do. The server stops on a kill signal without a goodbye message (notes are safe because writes are atomic, but a sync in progress is cut and redone). Linux only. No central server exists or is added |
