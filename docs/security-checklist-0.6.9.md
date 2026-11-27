# Security checklist, version 0.6.9

Checked by the builder by reading, searches and automatic tests. Not an outside review. Everything from 0.6.8 still applies.

| Item | Result |
|---|---|
| At the end of a sync between one's own devices, the starting device sends the list of what both have (`KIND_BASE`, a listing). It is only taken from a paired device of one's own, during a sync it started with this device, and decoded with the same checks and size limits as any listing. The answering device keeps only files that are exactly the same on its side (same hash and size), and only folders that exist on its side, so the list can never make it treat a file it changed as unchanged or delete anything | Rust tests on loopback: a list with a changed file and a missing file keeps neither |
| `base=1` in the greeting only decides whether the list is sent; an older app never gets a request it does not know | Rust test with an older greeting |
| A sync now says hello first when the other device's greeting is not known yet; the hello is the same short exchange that already ran after each sync | Rust tests |
| The drawing file has one new optional field on ink, `fit`; anything but `true` makes the drawing read-only, as for any bad field | Unit test |
| The page place, Apply to all slides, page icons, pinned folders and the conflicts button only read and change what the app already read and changed (the page in the editor, the folder icons file, the list of conflict copies) | Reading, browser tests |
| `npm audit` | 0 vulnerabilities |
| `cargo audit` | 0 vulnerabilities; 6 allowed warnings about unmaintained crates inside Tauri's own dependencies, as before |
| No `unwrap()` or `expect()` added outside tests | Search |
| No real names, device names or addresses in code, tests or notes | Search |
| Open risk | Not tried on real devices: the sync list on both devices with a laptop and a phone, ink on slides across screen sizes, the page place with PDF pages that load slowly on a phone |
