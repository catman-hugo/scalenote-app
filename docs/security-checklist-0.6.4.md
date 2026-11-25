# Security checklist, version 0.6.4

Checked by the builder by reading, searches and automatic tests. Not an outside review. Everything from 0.6.3 still applies.

| Item | Result |
|---|---|
| A device that is not paired can do only three new things: send one invitation, send the answer to one, or open a share sync. Anything else is refused as before | Reading (`service::handle_connection`), Rust test (`invitations_and_answers_from_strangers_that_do_not_fit_are_refused_and_change_nothing`) |
| An invitation and an answer are one message of at most 16 KB, read into fixed fields; names are cleaned; an item name must be one portable name; keys must be 32 bytes; at most 10 such messages a minute and 20 waiting invitations | Rust tests (`invite::tests`, the stranger test) |
| An invitation is only taken when it is meant for this person's account, who is findable or already shares with the sender. It makes no file; nothing is copied until the person accepts | Rust tests |
| An answer is only taken for a share this person owns, from someone invited to it, with the share's random 16-byte id (sent only to the invited device, encrypted) | Rust test, reading |
| A share sync is only served to a device whose key is in that active share. It sees only that share's names (`s/…` for the item, `a/…` for attachments its pages link to). Names outside the share, `..`, hidden files and the notes folder's own files are refused; an attachment that no shared page links to may only be made new, never read, changed or removed | Rust tests (`space::tests`, `a_share_connection_from_a_stranger_or_for_something_outside_the_share_gets_nothing`) |
| The list of what both sides have alike that the calling device sends at the end of a share sync is only kept for files that are exactly so on the answering device | Reading (`engine::keep_share_base`) |
| Share records are checked when read (ids, names, safe paths, not under `.scalenote`, key lengths, at most 500 shares and 50 people); a damaged list is never saved over | Rust test (`records_from_elsewhere_are_checked_and_bad_ones_left_out`) |
| Joining edits reads only pages up to 2 MB and gives up (keeps both versions) when the same place changed | Rust tests (`textmerge`) |
| Apps before 0.6.4 never get the list of shares (they would refuse the whole list); it is only listed for devices that said `shares=1` | Rust test (`the_list_of_shares_goes_only_to_devices_that_know_it…`) |
| Being findable is off until switched on and needs a name; only the name and account id go out in the people note | Browser and Rust tests |
| Names from other people's devices are shown as text only | Browser test (`Share… on a folder lists the people nearby…`) |
| No new dependency | `Cargo.lock` diff (only the app's own version numbers) |
| Open risk | Not tried between two real devices. A person who is let in to a share can change or remove every page in it (by design: everyone edits), but removed pages go to the trash. The account id is chosen at random and not checked by anyone: someone nearby could pick the same name; the screens show names only, so choose whom to share with when you can see them |
