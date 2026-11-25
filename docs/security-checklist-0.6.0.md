# Security checklist, version 0.6.0

Checked by the builder by reading, searches and automatic tests. Not an outside review. Everything from the 0.5 line still applies.

| Item | Result |
|---|---|
| A file a device does not keep is never sent to it and never read as deleted, on either side of a sync, whoever starts it | Rust tests (`tests_keep`: one folder kept, text only, two devices that each keep a part, syncs started from both sides) |
| "Free up space" only removes a file that a saved list shows a paired device had in exactly this version; the hash is checked again right before removing. A file changed or made since the last sync stays | Rust tests (`freeing_space_…`, `a_file_changed_since_the_last_sync_is_never_freed`) |
| Order of "Free up space" keeps a crash harmless: the removed list is written first, then the file is taken out of the saved lists, then deleted | Reading (`keep::free_up_space`) |
| An app before 0.6 that starts a sync with a device that removed files reads them as left out, not as deleted: they are sent as ordinary skipped names, and the new lines start with `/`, which an old app drops | Rust test (`an_older_app_reads_removed_files_as_left_out…`, which runs the 0.5 decoder's reading on the new listing) |
| The other device's choices are untrusted: every path must be a safe vault path, at most 10,000 choices, kinds only from `t`, `d`, `i`, `f`; a damaged choice line ends the sync instead of being guessed | Rust test |
| This device's own choices file (`.scalenote/offline.txt`) is read with a size limit; a damaged file means "keep everything", the reading that can never remove anything. It is never synced | Rust test; reading (`manifest.rs` syncs only `folder-icons.json` from `.scalenote`) |
| A deletion by the person of a page this device keeps still reaches the other device (to its trash) | Rust test |
| Renaming, moving or deleting a folder or page with files not on this device is refused (`not_all_here`), so nothing is split between an old and a new name | Rust test (`a_folder_or_page_with_files_not_here_…`) |
| Links to attachments are read from kept pages as text only, limited to pages up to 8 MB; only safe paths directly in `attachments/` are taken | Rust test (`links_are_found_in_every_written_form`) |
| No new dependency | `Cargo.lock` diff (only the app's own version numbers) |
| Open risk | An app before 0.6 does not know the choices, so it can still send a device files it does not keep (they are kept there, nothing is lost). Nothing here was tried between two real devices; the Rust core is tested here, the app is compiled by CI |
