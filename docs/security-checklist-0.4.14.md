# Security checklist, version 0.4.14

Checked by the builder by reading, searches and automatic tests. Not an outside review. Items marked "device" still need a try on a real device.

| Item | Result |
|---|---|
| The canvas block is still only read when it is exactly the three-line fence with an id of 6 to 16 lowercase letters and digits. Inside a callout, toggle or column the same check is used on the text left after the `> ` marks are removed. Anything else stays an ordinary code block, byte for byte | `tests/richblocks.test.mjs` |
| Nesting depth is still limited (8 levels); deeper text stays raw | Existing test, kept passing |
| A page with canvas blocks inside callouts, toggles and columns that is opened and not changed is written back to the byte | Unit and browser tests |
| The Settings tabs only move existing controls into groups. Labels come from `web/strings.js` and are set with `textContent`. No new setting, no new stored value | Reading of the diff |
| No new network calls, no new permissions, no new Rust commands, no change to the page policy, no new dependency | Reading of the diff against v0.4.13 |
| No Rust code changed, so no new `unwrap()` or `expect()` | Reading of the diff |
| Secrets: none exist | n/a |
| The assistant is still off and absent from the interface | Browser test |
| Open risk | Device: dragging columns or toggles that hold a canvas block, and a block inside a very narrow column on a phone |
