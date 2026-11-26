# Security checklist, version 0.6.6

Checked by the builder by reading, searches and automatic tests. Not an outside review. Everything from 0.6.5 still applies.

| Item | Result |
|---|---|
| Everything shared into ScaleNote (other apps, Open with, Send to, clipboard, dropped files) goes through one checker in Rust (`core/src/capture.rs`), whatever road it came by | Reading, Rust tests (`capture::tests`) |
| Links are only made links for `http`, `https` and `mailto`, at most 2000 characters, with no spaces or characters that end markdown; `javascript:`, `file:` and `data:` stay plain text | Rust test (`only_safe_links_become_links`) |
| Files are taken by what their bytes are (pictures and PDFs with the 0.5 limits, markdown and text only as valid UTF-8, at most 1 MB), never by their name; names are only a hint, cleaned, with folders taken off; everything else is refused and said so | Rust test (`pictures_pdfs_and_markdown_files_are_taken_and_other_files_are_refused`) |
| Nothing shared is ever run or opened by another program; a new page never replaces one; adding to a page checks it did not change in between; writes stay inside the notes folder | Rust tests |
| At most 50 things at once, 100 waiting, 64 MB per file and 128 MB of dropped files held in memory | Rust tests (app `capture::tests`) |
| On Android, files are copied by the app into its own cache folder under a random name (20 at most, 64 MB each), and Rust takes files only from that folder (a link out of it is refused); the copy is removed once added or dismissed, old copies after a day | Rust test (`only_files_in_the_android_share_folder_are_taken_from_android`), patch-script tests |
| The page gets shared things from the Android bridge as JSON text only; nothing is put into the page as code | Patch-script test |
| A second start of the program hands its files to the running one and ends (single-instance plugin), so one notes folder never has two programs writing it | Reading; tried only on a real computer |
| "Open with" never makes ScaleNote the default program: only `OpenWithProgids` values are written, never the unnamed value of a file type; Tauri's own file associations are not used for that reason; the uninstall removes everything added | Installer text tests (`tests/installers.test.mjs`) |
| The global shortcut and the tray are off until switched on; a refused shortcut turns the switch off again | Browser test |
| Two new dependencies, pinned: `tauri-plugin-single-instance =2.5.5` and `tauri-plugin-global-shortcut =2.4.1` (official Tauri plugins), computers only; used from Rust only, no permission for the window's scripts | `Cargo.toml`, `Cargo.lock` |
| Open risk | Not tried on real devices: the Android share menu, Send to and Open with on Windows (both installers), Open with on Linux and the shortcut are only built and tested as text here |
