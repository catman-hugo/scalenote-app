# Security checklist, version 0.6.3

Checked by the builder by reading, searches and automatic tests. Not an outside review. Everything from 0.6.2 still applies.

| Item | Result |
|---|---|
| Bringing a page that is not here (`engine::fetch`) only reads from a paired device over the same encrypted connection; it never sends or changes anything there, never overwrites a file that is here (a file that turned up meanwhile is left alone), checks every path is a safe vault path, and keeps the 64 MB per-file limit | Rust test (`a_page_that_is_not_here_is_brought_with_its_drawing_and_pictures…`) |
| A brought page's links are read as text only, to bring the pictures and PDFs it shows from `attachments/`; nothing in it is run | Reading (`keep::attachment_links`) |
| A choice from the interface is checked in Rust: a safe path or the whole folder, kinds only from `t`, `d`, `i`, `f` or `-`, at most 10,000 choices | Rust test (`switching_a_folder_off_frees_what_another_device_has…`) |
| Switching something off frees space with the same rules as 0.6.0 (only files another device had in the same version) | Rust tests |
| Pages only on another device cannot be renamed, moved or deleted from here (no such menu items, F2 and Delete do nothing) | Browser test |
| No new dependency | `Cargo.lock` diff (only the app's own version numbers) |
| Open risk | Not tried between two real devices; the new app commands (`offline_get`, `offline_set`, `offline_fetch`) are only compiled by CI |
