//! The local networks this device is on right now: home Wi-Fi, a phone's hotspot (on the phone
//! that makes it and on the device that joins it), a USB cable with tethering on, or an Ethernet
//! cable between two computers. Sync never needs the internet: two devices on one of these
//! networks find each other and sync directly, also with mobile data off and no internet at all.
//!
//! Why this is needed: a device used to send its "I'm here" note only along its main connection
//! (the one to the internet). A phone that makes a hotspot has mobile data as its main connection,
//! or none at all with data off, so its notes never reached the hotspot. Now notes go out on every
//! local network (discovery.rs), and "Wi-Fi only" also allows a device that is reached on one of
//! them, because such a connection never uses mobile data (service.rs).
//!
//! Left out on purpose: the loopback address, Tailscale (tailscale.rs has its own way), mobile
//! data connections (by their system names), and addresses that are not private network addresses.

use super::tailscale::is_tailscale_ip;
use std::net::{IpAddr, Ipv4Addr};

/// One local network: this device's address on it and the network's size.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LocalNet {
    pub name: String,
    pub ip: Ipv4Addr,
    pub prefix: u8,
}

impl LocalNet {
    fn mask(&self) -> u32 {
        u32::MAX.checked_shl(32 - u32::from(self.prefix)).unwrap_or(0)
    }

    /// The address that reaches every device on this network (for the "I'm here" notes).
    pub fn broadcast(&self) -> Ipv4Addr {
        Ipv4Addr::from(u32::from(self.ip) | !self.mask())
    }

    /// Whether `ip` is another device on this network.
    pub fn contains(&self, ip: Ipv4Addr) -> bool {
        u32::from(ip) & self.mask() == u32::from(self.ip) & self.mask()
    }
}

/// Names of mobile data connections on Android and Linux: `rmnet_data0`, `ccmni0`, `wwan0`,
/// `clat4` (the IPv4 helper of an IPv6-only mobile network), `pdp_ip0` (Apple).
fn is_mobile_data_name(name: &str) -> bool {
    let name = name.to_ascii_lowercase();
    ["rmnet", "rev_rmnet", "ccmni", "wwan", "clat", "pdp_ip", "seth_", "v4-rmnet"].iter().any(|p| name.starts_with(p))
}

/// Private network addresses (10/8, 172.16/12, 192.168/16) and link-local ones (169.254/16, what
/// two computers joined by a cable give themselves when nothing hands out addresses).
fn is_local_ip(ip: Ipv4Addr) -> bool {
    ip.is_private() || ip.is_link_local()
}

/// Picks the local networks from a device's connections (name, address, prefix length).
pub fn pick(connections: impl IntoIterator<Item = (String, Ipv4Addr, u8)>) -> Vec<LocalNet> {
    let mut found: Vec<LocalNet> = Vec::new();
    for (name, ip, prefix) in connections {
        // A /31 or /32 is a point-to-point link, not a network with other devices on it.
        let usable = (8..=30).contains(&prefix) && is_local_ip(ip) && !is_tailscale_ip(ip) && !is_mobile_data_name(&name);
        if usable && !found.iter().any(|n| n.ip == ip) {
            found.push(LocalNet { name, ip, prefix });
        }
    }
    found
}

/// This device's local networks right now. An error from the system means "none known".
pub fn local_networks() -> Vec<LocalNet> {
    let Ok(interfaces) = if_addrs::get_if_addrs() else { return Vec::new() };
    pick(interfaces.into_iter().filter(|i| !i.is_loopback()).filter_map(|i| match i.addr {
        if_addrs::IfAddr::V4(v4) => Some((i.name, v4.ip, v4.prefixlen)),
        if_addrs::IfAddr::V6(_) => None,
    }))
}

/// Whether `ip` is a device on one of `nets`: a direct connection, never over mobile data.
pub fn is_on(nets: &[LocalNet], ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => nets.iter().any(|n| n.ip != v4 && n.contains(v4)),
        IpAddr::V6(_) => false,
    }
}

/// Whether `address` (`ip:port` or a bare ip) is a device on one of `nets`. Anything that is not
/// an address, such as an empty one, is not.
pub fn is_nearby(nets: &[LocalNet], address: &str) -> bool {
    let ip = address.parse::<std::net::SocketAddr>().map(|a| a.ip()).or_else(|_| address.parse::<IpAddr>());
    ip.is_ok_and(|ip| is_on(nets, ip))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn net(name: &str, ip: [u8; 4], prefix: u8) -> (String, Ipv4Addr, u8) {
        (name.to_string(), Ipv4Addr::from(ip), prefix)
    }

    #[test]
    fn hotspots_cables_and_home_wifi_count_but_mobile_data_and_tailscale_do_not() {
        let found = pick([
            net("wlan0", [192, 168, 1, 20], 24),
            net("ap0", [192, 168, 43, 1], 24),
            net("rndis0", [192, 168, 42, 129], 24),
            net("Ethernet", [169, 254, 10, 2], 16),
            net("rmnet_data0", [10, 120, 3, 9], 29),
            net("tailscale0", [100, 101, 1, 2], 32),
            net("tun0", [100, 101, 1, 2], 10),
            net("v4-rmnet_data2", [192, 0, 0, 4], 32),
            net("eth1", [203, 0, 113, 5], 24),
            net("ptp", [10, 0, 0, 1], 31),
        ]);
        let names: Vec<&str> = found.iter().map(|n| n.name.as_str()).collect();
        assert_eq!(names, ["wlan0", "ap0", "rndis0", "Ethernet"]);
    }

    #[test]
    fn broadcast_and_membership_follow_the_network_size() {
        let hotspot = LocalNet { name: "ap0".into(), ip: Ipv4Addr::new(192, 168, 43, 1), prefix: 24 };
        assert_eq!(hotspot.broadcast(), Ipv4Addr::new(192, 168, 43, 255));
        let cable = LocalNet { name: "Ethernet".into(), ip: Ipv4Addr::new(169, 254, 10, 2), prefix: 16 };
        assert_eq!(cable.broadcast(), Ipv4Addr::new(169, 254, 255, 255));
        let nets = [hotspot, cable];
        assert!(is_on(&nets, IpAddr::V4(Ipv4Addr::new(192, 168, 43, 77))));
        assert!(is_on(&nets, IpAddr::V4(Ipv4Addr::new(169, 254, 200, 1))));
        assert!(!is_on(&nets, IpAddr::V4(Ipv4Addr::new(192, 168, 1, 5))), "another network");
        assert!(!is_on(&nets, IpAddr::V4(Ipv4Addr::new(192, 168, 43, 1))), "this device itself");
        assert!(!is_on(&nets, IpAddr::V4(Ipv4Addr::new(100, 101, 1, 3))), "Tailscale");
        assert!(!is_on(&[], IpAddr::V4(Ipv4Addr::new(192, 168, 43, 77))));
        // What "Wi-Fi only" asks about a device's address.
        assert!(is_nearby(&nets, "192.168.43.77:47821"));
        assert!(is_nearby(&nets, "169.254.3.3"));
        assert!(!is_nearby(&nets, "100.101.1.3:47821"));
        assert!(!is_nearby(&nets, "127.0.0.1:47821"));
        assert!(!is_nearby(&nets, ""));
        assert!(!is_nearby(&nets, "laptop.example.local:47821"));
    }

    #[test]
    fn asking_the_system_never_fails() {
        // Whatever this machine has, the answer only holds usable local networks.
        for net in local_networks() {
            assert!(is_local_ip(net.ip) && (8..=30).contains(&net.prefix));
        }
    }
}
