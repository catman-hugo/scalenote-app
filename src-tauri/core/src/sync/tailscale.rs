//! Syncing over Tailscale, for networks where devices cannot see each other (most
//! school, work and public Wi-Fi keep devices apart and drop the "I'm here" messages that
//! `discovery.rs` uses).
//!
//! Tailscale is a private network of the person's own devices that works from anywhere. When it
//! is on, the device has an extra network connection with an address from 100.64.0.0/10, and
//! the other devices on it can reach that address directly.
//!
//! How ScaleNote uses it:
//! - `own_address` finds this device's Tailscale address, if Tailscale is on. It is shown in the
//!   Sync tab, so it can be typed on another device to pair from anywhere.
//! - Every greeting between two paired devices (`service.rs`, after each sync) carries the
//!   sender's Tailscale address and port. The other device keeps it in `sync-tailscale.txt`.
//! - When a paired device cannot be found the normal way, its kept Tailscale address is tried.
//!   So two devices that synced once at home keep syncing on such a network, with nothing to type.
//!
//! Nothing here changes who may connect: a connection over Tailscale goes through the same
//! encrypted channel and the same check of the paired key as one at home.
//!
//! The file holds addresses on this device only and is never synced. Format:
//!   scalenote-tailscale 1
//!   <device key in hex> <address:port>
//! It is read as untrusted input like the trust list; a damaged file is treated as empty.

use super::hex;
use super::identity::KEY_LEN;
use super::trust::MAX_PEERS;
use super::Result;
use crate::atomic::write_atomic;
use std::collections::BTreeMap;
use std::fs;
use std::net::{IpAddr, Ipv4Addr, SocketAddrV4};
use std::path::Path;

const HEADER: &str = "scalenote-tailscale 1";
const MAX_FILE_BYTES: u64 = 64 * 1024;

/// Whether `ip` is in the range Tailscale gives its devices (100.64.0.0/10).
pub fn is_tailscale_ip(ip: Ipv4Addr) -> bool {
    let [first, second, ..] = ip.octets();
    first == 100 && (second & 0b1100_0000) == 0b0100_0000
}

/// Whether a network connection with this name can be Tailscale's. Mobile networks also hand out
/// addresses from 100.64.0.0/10 (on their own connection, such as `rmnet_data0`), so the address
/// alone is not enough. Tailscale's connection is called "Tailscale" on Windows, `tailscale0` on
/// Linux, and is the VPN connection (`tun0`) on Android.
fn is_tailscale_name(name: &str) -> bool {
    let name = name.to_ascii_lowercase();
    name.contains("tailscale") || name.starts_with("tun") || name.starts_with("utun")
}

/// The Tailscale address among a device's connections (name and address), if there is one.
pub fn pick(connections: impl IntoIterator<Item = (String, IpAddr)>) -> Option<Ipv4Addr> {
    connections.into_iter().find_map(|(name, ip)| match ip {
        IpAddr::V4(v4) if is_tailscale_ip(v4) && is_tailscale_name(&name) => Some(v4),
        _ => None,
    })
}

/// This device's Tailscale address, or None when Tailscale is off (or the list of connections
/// cannot be read).
pub fn own_address() -> Option<Ipv4Addr> {
    let connections = if_addrs::get_if_addrs().ok()?;
    pick(connections.into_iter().map(|connection| (connection.name.clone(), connection.ip())))
}

/// What a greeting says about Tailscale: `ts=<address:port>`, or nothing when it is off.
pub fn greeting_part(port: Option<u16>) -> String {
    match (own_address(), port) {
        (Some(ip), Some(port)) => format!(" ts={ip}:{port}"),
        _ => String::new(),
    }
}

/// Reads a greeting: the app version, then optional `key=value` parts. Returns the version text
/// and a Tailscale address, if one was given and is a real Tailscale address. Older apps send the
/// version alone.
pub fn read_greeting(text: &str) -> (&str, Option<SocketAddrV4>) {
    let mut parts = text.split(' ');
    let version = parts.next().unwrap_or("");
    let address = parts
        .filter_map(|part| part.strip_prefix("ts="))
        .find_map(|value| value.parse::<SocketAddrV4>().ok())
        .filter(|address| is_tailscale_ip(*address.ip()) && address.port() != 0);
    (version, address)
}

/// The kept Tailscale address of each paired device.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct AddressBook {
    addresses: BTreeMap<[u8; KEY_LEN], SocketAddrV4>,
}

impl AddressBook {
    pub fn address_of(&self, key: &[u8; KEY_LEN]) -> Option<SocketAddrV4> {
        self.addresses.get(key).copied()
    }

    /// Keeps an address. Returns whether anything changed (so the file is only written then).
    pub fn set(&mut self, key: [u8; KEY_LEN], address: SocketAddrV4) -> bool {
        if !is_tailscale_ip(*address.ip()) || (!self.addresses.contains_key(&key) && self.addresses.len() >= MAX_PEERS) {
            return false;
        }
        self.addresses.insert(key, address) != Some(address)
    }

    pub fn forget(&mut self, key: &[u8; KEY_LEN]) -> bool {
        self.addresses.remove(key).is_some()
    }

    pub fn to_text(&self) -> String {
        let mut out = format!("{HEADER}\n");
        for (key, address) in &self.addresses {
            out.push_str(&format!("{} {address}\n", hex::encode(key)));
        }
        out
    }

    pub fn from_text(text: &str) -> Option<AddressBook> {
        let mut lines = text.lines();
        if lines.next() != Some(HEADER) {
            return None;
        }
        let mut book = AddressBook::default();
        for line in lines {
            let (key, address) = line.split_once(' ')?;
            let key = hex::decode::<KEY_LEN>(key)?;
            let address = address.parse::<SocketAddrV4>().ok()?;
            if !is_tailscale_ip(*address.ip()) {
                return None;
            }
            book.set(key, address);
        }
        Some(book)
    }

    pub fn load(path: &Path) -> AddressBook {
        match fs::metadata(path) {
            Ok(meta) if meta.is_file() && meta.len() <= MAX_FILE_BYTES => fs::read_to_string(path).ok().and_then(|text| AddressBook::from_text(&text)).unwrap_or_default(),
            _ => AddressBook::default(),
        }
    }

    pub fn save(&self, path: &Path) -> Result<()> {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        write_atomic(path, self.to_text().as_bytes())?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ip(text: &str) -> IpAddr {
        text.parse().expect("test address")
    }

    #[test]
    fn only_the_tailscale_range_counts() {
        assert!(is_tailscale_ip(Ipv4Addr::new(100, 64, 0, 1)));
        assert!(is_tailscale_ip(Ipv4Addr::new(100, 101, 102, 103)));
        assert!(is_tailscale_ip(Ipv4Addr::new(100, 127, 255, 254)));
        assert!(!is_tailscale_ip(Ipv4Addr::new(100, 63, 0, 1)));
        assert!(!is_tailscale_ip(Ipv4Addr::new(100, 128, 0, 1)));
        assert!(!is_tailscale_ip(Ipv4Addr::new(192, 168, 1, 20)));
    }

    #[test]
    fn the_tailscale_connection_is_picked_and_a_mobile_network_address_is_not() {
        let windows = vec![("Wi-Fi".to_string(), ip("192.168.1.20")), ("Tailscale".to_string(), ip("100.101.102.103"))];
        assert_eq!(pick(windows), Some(Ipv4Addr::new(100, 101, 102, 103)));
        let linux = vec![("lo".to_string(), ip("127.0.0.1")), ("tailscale0".to_string(), ip("fd7a:115c:a1e0::1")), ("tailscale0".to_string(), ip("100.80.1.2"))];
        assert_eq!(pick(linux), Some(Ipv4Addr::new(100, 80, 1, 2)));
        let android = vec![("rmnet_data0".to_string(), ip("100.70.1.1")), ("tun0".to_string(), ip("100.90.3.4"))];
        assert_eq!(pick(android), Some(Ipv4Addr::new(100, 90, 3, 4)), "the phone's mobile network address is skipped");
        let mobile_only = vec![("rmnet_data0".to_string(), ip("100.70.1.1")), ("wlan0".to_string(), ip("10.0.0.5"))];
        assert_eq!(pick(mobile_only), None, "Tailscale off");
        assert_eq!(pick(Vec::new()), None);
    }

    #[test]
    fn a_greeting_gives_the_version_and_a_real_tailscale_address_only() {
        assert_eq!(read_greeting("0.5.6"), ("0.5.6", None), "an older app");
        assert_eq!(read_greeting("0.5.7 ts=100.101.102.103:47821"), ("0.5.7", Some("100.101.102.103:47821".parse().expect("address"))));
        assert_eq!(read_greeting("0.5.7 ts=192.168.1.20:47821").1, None, "not a Tailscale address");
        assert_eq!(read_greeting("0.5.7 ts=100.101.102.103:0").1, None);
        assert_eq!(read_greeting("0.5.7 ts=nonsense other=1").1, None);
        assert_eq!(read_greeting("").0, "");
    }

    #[test]
    fn kept_addresses_are_read_back_and_bad_files_are_not_trusted() {
        let mut book = AddressBook::default();
        let address: SocketAddrV4 = "100.101.102.103:47821".parse().expect("address");
        assert!(book.set([1u8; KEY_LEN], address));
        assert!(!book.set([1u8; KEY_LEN], address), "the same again is no change");
        assert!(!book.set([2u8; KEY_LEN], "192.168.1.20:47821".parse().expect("address")), "only Tailscale addresses");
        assert_eq!(AddressBook::from_text(&book.to_text()), Some(book.clone()));
        assert_eq!(AddressBook::from_text("something else\n"), None);
        assert_eq!(AddressBook::from_text(&format!("{HEADER}\nnot-hex 100.101.102.103:1\n")), None);
        assert_eq!(AddressBook::from_text(&format!("{HEADER}\n{} 8.8.8.8:1\n", hex::encode(&[3u8; KEY_LEN]))), None);
        assert!(book.forget(&[1u8; KEY_LEN]));
        assert_eq!(book.address_of(&[1u8; KEY_LEN]), None);
    }
}
