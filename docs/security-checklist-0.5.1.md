# Security checklist, version 0.5.1

Checked by the builder by reading, searches and automatic tests. Not an outside review. Items marked "device" still need a try on real devices.

| Item | Result |
|---|---|
| Everything between two devices goes through an encrypted, mutually authenticated connection (Noise XX, 25519 keys, ChaCha20-Poly1305, SHA-256, library snow 0.10.0). A device is trusted only by its pinned public key | Rust tests with real connections |
| Pairing uses a one-time 8-digit code with SPAKE2 (spake2 0.4.0), so the code is never sent and cannot be recovered from what is sent. After it, both sides send a tag (HMAC-SHA256, hmac 0.12.1) over both public keys and their name, so a device in the middle cannot swap keys | Rust tests: relay in the middle, tampered message, wrong, old and copied code |
| The code lives 120 seconds, allows 3 tries (counted before the check) and dies when the pairing screen closes. Closing Settings stops it | Rust tests, browser test |
| An unpaired device may only pair: every other request is refused; a paired device that was removed is refused again | Rust tests |
| Network input is untrusted: frames are limited (60,000 bytes, handshake 512), 8 connections at most, 10 second timeouts, the trust list is limited to 64 devices and read with strict checks; nothing received is ever run | Rust tests with bad input |
| The device only listens while sync is on AND a device is paired or the pairing screen is open; it stops listening when that stops being true | Rust tests |
| Secrets: the private key is never in the vault, a log, an error text or `Debug` output (only the fingerprint is shown); memory holding it is cleared when dropped (zeroize 1.8.2). Windows: system credential storage (keyring 3.6.3). Linux and Android: a file with owner-only permissions in the app's data folder, NOT the system storage yet (see DECISIONS.md). A damaged key is reported and never silently replaced | Rust tests (permissions 0600, no key in output); the Windows store was not compiled or run here |
| The trust list and settings are written atomically (temporary file, then rename) outside every vault | Rust tests |
| New dependencies, all pinned to exact versions: snow 0.10.0, spake2 0.4.0, hmac 0.12.1, zeroize 1.8.2, and keyring 3.6.3 (Windows only) | `Cargo.toml` and `Cargo.lock` diff; no existing version changed |
| No new `unwrap()` or `expect()` in Rust code outside tests | Reading of the diff |
| The interface adds no inline styles and no typed text outside the language file; the error messages never include the code or a key | Browser tests under the policy |
| The assistant is still off and absent | Browser test |
| Open risk | Device: the Tauri app crate (`lib.rs`, `secure.rs`) was not compiled here; CI compiles it. The Windows credential store was never run. Pairing between two real devices was not tried. Android's behaviour with a listening service in the background is unknown. Anyone on the same network can try the code, but gets 3 tries in 2 minutes, about a 1 in 33 million chance of guessing the code |
