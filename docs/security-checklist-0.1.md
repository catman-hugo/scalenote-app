# Security checklist, version 0.1

Checked by the builder by reading and by automatic tests. Not an outside review.

| Item | Result |
|---|---|
| Paths from the interface cannot leave the vault (`..`, absolute, backslash, hidden names, symlinks) | Tested in `core/tests/vault_tests.rs` |
| Writes are atomic and a killed app never leaves a half-written note | Tested: writer killed 40 times at different moments |
| Size limits: notes 8 MiB, settings 64 KiB, note list 300000 entries and 40 levels deep, log lines 300 characters | In code, tested for notes |
| Files that are not valid UTF-8 are refused instead of converted | Tested |
| Nothing from a note is run as code: html in notes is shown as text inside a text box, the interface never uses `innerHTML`, and the page policy forbids inline and remote scripts | Checked in code; policy violations are checked by the browser tests |
| No network access in this version | Checked: no network code, the policy allows only the app's own files |
| Secrets: none exist yet | n/a |
| Logs hold no note text, titles or paths | By design: only action names and error codes. Not verified by a person reading a real log |
| No `unwrap()` or `expect()` outside tests | Checked with a search |
| Folder picker permission is limited to choosing a folder (`dialog:allow-open`) | In `capabilities/default.json`. Custom commands are available to the app's own page only |
| The assistant is off and absent from the interface | Tested in the browser tests |
| Open risk | Any file the user opens in the folder is trusted as far as its text goes. A note on a shared or synced folder can be changed by other programs at any time; this is handled with conflict copies |
