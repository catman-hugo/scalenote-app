# Security checklist, version 0.6.7

Checked by the builder by reading, searches and automatic tests. Not an outside review. Everything from 0.6.6 still applies.

| Item | Result |
|---|---|
| Folder names from another device pass the same check as file paths (safe names, not hidden, depth and count limits, no part of the path a link); the make and remove request (`0x36`) is answered only for one's own paired devices, never in a share | Rust tests (`foldersync::tests`, `tests_sync`), reading |
| A sync never removes a folder that holds anything: only an empty folder is removed (`files::remove_empty_folder`), after the files of that sync have moved | Rust test (`a_folder_removed_on_one_device_stays_where_something_was_added_to_it`) |
| Ink over the text read again after a sync: only the page's own drawing file, through the same reading and checks as before; ink being drawn or not yet saved is never replaced | Browser tests, reading |
| No new dependencies | `Cargo.lock`, `package-lock.json`: only the version of ScaleNote itself changed |
| Open risk | Not tried on real devices: folders and ink syncing between a computer and a phone |
