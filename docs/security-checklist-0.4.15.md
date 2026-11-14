# Security checklist, version 0.4.15

Checked by the builder by reading, searches and automatic tests. Not an outside review. Items marked "device" still need a try on a real device.

| Item | Result |
|---|---|
| The PDF text layer only receives text from pdf.js and puts it into the page as plain text through the library's own text layer (no markup is built from PDF text). The find box text is matched as plain text and never run as a pattern or code | Reading of the diff, browser tests |
| Text read from a PDF is limited: 20,000 pieces per page, 500 characters per piece, 200,000 characters per page, 2,000 find hits | `web/pdfrules.js`, unit tests |
| The text layer sets sizes only through script styles, so the page policy (`style-src 'self'`, no `unsafe-inline`) is unchanged; the browser tests run under that policy and report any violation | Browser tests |
| Print rules are added through the style sheet's own `insertRule`, not as a style element, and are removed after printing. The pictures in them are made by the app from the page's drawing, never from outside data | Browser tests |
| Pictures made for printing are limited: 4 million pixels and 8,000 pixels on the longest side each, 40 million characters in all; what does not fit is left out with a message | Reading of the diff |
| The drawing picture sent to export is checked in Rust: it must start with the PNG signature and be within the picture size limit, otherwise it is left out and the page is still exported. Its base64 length is checked before decoding. It is written under a fixed name that never replaces a picture of the page | 3 new Rust tests |
| The export folder, its fixed location and the rule that nothing existing is replaced are unchanged | Existing Rust tests |
| No new network calls, no new permissions, no new dependency, no change to the page policy. One Rust command got an optional picture argument | Reading of the diff against v0.4.14 |
| No new `unwrap()` or `expect()` in Rust code outside tests | Reading of the diff |
| Secrets: none exist | n/a |
| The assistant is still off and absent from the interface | Browser test |
| Open risk | Device: the Tauri app crate (`lib.rs`) was not compiled here because the system libraries are missing; CI compiles it. Selecting PDF text by touch on Android. Printing from the packaged app on Windows and Linux |
