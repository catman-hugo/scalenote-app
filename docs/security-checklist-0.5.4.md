# Security checklist, version 0.5.4

Checked by the builder by reading, searches and automatic tests. Not an outside review. Items marked "device" still need a try on real devices. Everything from 0.5.3 still applies.

| Item | Result |
|---|---|
| New Android permissions are the smallest that do the job: ACCESS_NETWORK_STATE (is it Wi-Fi?), ACCESS_WIFI_STATE and CHANGE_WIFI_MULTICAST_STATE (hear announcements). None reads the network's name or address, and none gives new access to notes | Node test of the manifest patch; reading |
| The page can ask the Android app only one new question: "is this Wi-Fi or wired?". The answer is a yes or no; no network name, address or other text reaches the page | Node test of the bridge source; reading |
| The multicast lock is held only while the app is on screen and released when it leaves | Node test of the activity patch; device |
| The Wi-Fi only list is saved as plain device ids; it is checked on reading (64 hex digits, each once, at most 16). It lives in the app's settings, not in the notes folder | Node tests with garbage and many ids |
| The Wi-Fi only rule is enforced in the sync service, so a sync by hand and an automatic sync obey it alike. Where the system cannot say, it counts as Wi-Fi, so a wrong guess never blocks | Rust test; Node test |
| "The last page" is read as a folder and a page path of plain text ending in .md, with no `..`, no control characters and a length limit. It is only used if the page is in the open folder's list | Node tests with hostile values |
| Reset to defaults never touches notes, the open folder, paired devices, what was read or dismissed, or the last page; it needs two presses | Node test; browser test |
| Back and Forward use the page's own history with a position number only; a made-up or out-of-range number opens nothing | Node tests |
| Settings search only hides and shows rows; the typed text is never put into the page as markup | Browser test with odd input |
| No new dependencies | `Cargo.toml`, `Cargo.lock` and `package-lock.json` diff |
| No new `unwrap()` or `expect()` in Rust code outside tests | Reading of the diff |
| No typed text in the interface code; no inline styles; the assistant is still absent | Browser tests under the policy |
| Open risk | Device: the Android changes (lock, network question, back gesture) were only built by CI, not run on a phone or tablet. The Kotlin was checked by compiling, not by use. `lib.rs` is compiled by CI only. Whether the multicast lock is enough to hear other devices on a real Wi-Fi is not known. Some routers block multicast between devices |
