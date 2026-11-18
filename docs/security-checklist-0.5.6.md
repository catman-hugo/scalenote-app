# Security checklist, version 0.5.6 (in progress)

Checked by the builder by reading, searches and automatic tests. Not an outside review. Everything from 0.5.5 still applies.

| Item | Result |
|---|---|
| The words of an imported page are kept only beside a picture that exists directly in `attachments/` (no other folder, no `..`, no hidden names), at most 1 MB, written atomically. The app never runs or interprets the file; Rust only stores it | Rust test (`page_words_are_kept_beside_a_picture_and_nowhere_else`) |
| A words file from another device is untrusted: it is read only if it is the known format, wrong entries are skipped, boxes are kept inside the picture, sizes and counts are limited, and the text is only ever shown as text | Node tests (`tests/imagetext.test.mjs`) |
| The width of a PDF in a page is a whole number between 240 pixels and the page's width; an odd number after the name is kept as plain text | Node tests |
| No new dependencies | `package.json` and `Cargo.toml` unchanged |
| Open risk | The words file is only compiled into the app by CI (the Rust commands); not tried on a device |
