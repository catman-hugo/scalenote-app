# Security checklist, version 0.5.2

Checked by the builder by reading, searches and automatic tests. Not an outside review. Items marked "device" still need a try on real devices.

| Item | Result |
|---|---|
| Finding a device gives no trust: a found device is only an address to try. The pairing code and the key checks from 0.5.1 still decide who is paired | Rust test: the found address pairs with the code; nothing else changes |
| Nothing is announced unless sync is on AND a pairing code is showing; it stops when the code runs out, when pairing is closed and when sync is turned off | Rust tests (expired code, stop, sync off) |
| The address of a found device comes from where the note really came from, never from its text | Rust test |
| Notes from the network are untrusted: at most 200 bytes, an exact format, a clean name, a valid port, no extra lines; anything else is dropped. At most 16 devices are kept, each once; a flood of bad and many notes is bounded | Rust tests with garbage, huge and many notes |
| A note carries only the device's name, port and public key (already public by nature). It carries no code, no secret and no note text | Reading of the code |
| Notes are sent on the local network only (multicast with a hop limit of 1, and local broadcast) | Reading of the code; device |
| A device does not list itself | Rust test |
| No new dependencies | `Cargo.toml` and `Cargo.lock` diff |
| No new `unwrap()` or `expect()` in Rust code outside tests | Reading of the diff |
| No typed text in the interface code; no inline styles; the assistant is still absent | Browser tests under the policy |
| Open risk | Device: the real network route (multicast and broadcast) was only tried on loopback here. Routers or Wi-Fi isolation may block it. Android phones need a multicast lock to receive notes (not built yet). The Tauri app crate was not compiled here; CI compiles it. Someone on the same network can see that a device is pairing, and its name |
