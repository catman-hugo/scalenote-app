# Security checklist, version 0.7.0

Checked by the builder by reading, searches and automatic tests. Not an outside review. Everything from 0.6.9 still applies.

| Item | Result |
|---|---|
| Animations live in the page's drawing file (format 7), which may come from another device by sync or from another program. Every field is checked when read: ids, box sizes, labels, at most 50 animations, 300 steps, titles of 120 and texts of 1000 characters, every item with the same checks as any drawing item, and the items of all steps count towards the limits of the whole file (20 000 items, a million points). Anything wrong makes the drawing read-only; nothing in it is ever partly kept or run | Unit tests with bad, repeated, too many and too big animations |
| Unknown fields in an animation or a step are not carried into the program (a clean copy is made, as for every item) | Unit test |
| An older app sees format 7 as a newer format and saves nothing over it | Unit test |
| The block in the markdown (`scalenote-animation`) is read with strict rules: an id of 6 to 16 letters and digits, `show` from a list, `fps` a number from 0.5 to 30 with at most two decimals, at most 20 lines of `key: value` of limited length. Anything else stays an ordinary code block. Unknown lines are kept as text only | Unit tests |
| A speed typed in "Other speed…" is checked the same way before it is written | Unit and browser tests |
| Captions are shown with `textContent`, never as html; no `innerHTML`, `eval` or `new Function` in the changes | Search |
| Before and after (onion skin) is painted on the screen only; it is never in the file, a print or an export | Browser test |
| A loop runs one timer per block, only while it plays and can be seen, so a page full of loops does not keep the device busy | Browser test with a controlled clock |
| No Rust code changed in 0.7.0 apart from the version | `git diff` |
| `npm audit` | 0 vulnerabilities |
| `cargo audit` | 0 vulnerabilities; 6 allowed warnings about unmaintained crates inside Tauri's own dependencies, as before |
| No real names, device names or addresses in code, tests or notes | Search |
| Open risk | Not tried on real devices: drawing steps with a pen on a tablet, the step bar and swipes on a phone, a loop's battery use, printing an animation, and syncing a page with an animation between devices |
