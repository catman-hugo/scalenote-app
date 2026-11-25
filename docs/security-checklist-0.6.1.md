# Security checklist, version 0.6.1

Checked by the builder by reading, searches and automatic tests. Not an outside review. Everything from 0.6.0 still applies.

| Item | Result |
|---|---|
| The "I'm here" note is the same note as before (key, name, port), now also sent to the broadcast address of each local network. It still gives no trust: a found device is only an address to try; the encrypted connection checks the paired key | Reading (`discovery.rs`); Rust test that the note leaves from this device's address on each network |
| Only private and link-local networks are used (10/8, 172.16/12, 192.168/16, 169.254/16), never mobile data (by connection name), Tailscale, loopback or point-to-point links; the note still never crosses a router (broadcast, multicast time-to-live 1) | Rust test (`hotspots_cables_and_home_wifi_count_but_mobile_data_and_tailscale_do_not`) |
| "Wi-Fi only" now also allows a device whose address is on one of those local networks, and nothing else; Tailscale and unknown addresses still wait for Wi-Fi | Rust tests (`broadcast_and_membership_follow_the_network_size`, `wifi_only_blocks_a_device_off_wifi_and_never_blocks_the_others`) |
| The addresses shown on the pairing screen are only this device's own local ones; mobile data addresses are not shown | Reading (`service::local_addresses`); browser test for showing them |
| No new dependency (`if-addrs` 0.15.0 was already used for Tailscale) | `Cargo.lock` diff (only the app's own version numbers) |
| Open risk | Whether each system sends and receives the notes on a hotspot it makes itself (Android, Windows, Linux) can only be seen on real devices. The build machine here has no private network, so the sending test ran without one; GitHub's test machines have one |
