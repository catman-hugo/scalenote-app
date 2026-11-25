# Security checklist, version 0.6.5

Checked by the builder by reading, searches and automatic tests. Not an outside review. Everything from 0.6.4 still applies.

| Item | Result |
|---|---|
| A search request is only answered for one of this person's own paired devices; a device that is only in a share with them is refused | Reading (`service::handle_connection`), Rust test (`a_paired_device_searches_the_text_of_pages_that_are_not_here_and_another_person_may_not`) |
| The query is at most 800 bytes; the answering device searches for at most 4 seconds and answers with one message of at most 48 KB: paths, titles and short lines, never whole pages | Rust tests (`remotesearch::tests`, `a_search_with_a_deadline_that_has_passed_stops_and_says_so`) |
| An answer is checked when it arrives: at most 50 results, safe page paths only (no `..`, no hidden folders, no attachments, `.md` only), titles and lines cut and stripped of control characters; only results for pages not on this device are kept; the asking device waits at most 8 seconds | Rust tests |
| Free up space counts only the saved lists of syncs with one's own devices (`sync-base-<16 hex>.txt`), never those of share syncs with other people | Rust test (`a_copy_on_someone_elses_device_does_not_count_when_freeing_space`) |
| Free up space still only removes a file a paired device had in exactly this version, checked again right before removing | Rust tests (0.6.0 and above) |
| The Storage count reads file sizes only, follows no links, stops at 200 000 files or depth 64 and says so; pages are read for their links up to 2 MB each and 256 MB in all | Rust tests (`storage::tests`), reading |
| Names from the notes folder (folders, pages) and from other devices (device names, titles, lines) are shown as text only | Browser tests (Storage folder names, search results) |
| The search query is not written to the log, here or on the device that answers | Reading |
| No new dependency | `Cargo.lock` diff (only the app's own version numbers) |
| Open risk | Not tried on real devices. A paired device can learn titles and short lines of any page through search; that was already true, since paired devices sync the whole folder |
