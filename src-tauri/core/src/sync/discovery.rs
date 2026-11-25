//! Finding the other device on the local network, so nobody has to type an address.
//!
//! How it works, in plain words: while the "Pair a device" screen is open, that device shouts a
//! short note once a second ("a ScaleNote device called alice-laptop is here, port 47821, this is
//! its public key"). A device that opens "Find devices" listens for a couple of seconds and lists
//! what it heard. The note goes to a multicast group AND to the local broadcast address, because
//! some Wi-Fi routers drop one kind and not the other.
//!
//! What this does NOT do: it gives no trust. Anyone on the network can send such a note, so a
//! found device is only an address to try; the pairing code still decides who is paired. Nothing
//! is announced while no pairing screen is open, so a device that is merely switched on is not
//! visible. The address of a found device always comes from where the note really came from,
//! never from its text, so a note cannot point the finder at some third machine.
//! Everything received is untrusted: notes are small, strictly checked, and at most a few are kept.

use super::device::clean_name;
use super::identity::KEY_LEN;
use super::hex;
use std::io;
use std::net::{IpAddr, Ipv4Addr, SocketAddr, UdpSocket};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

/// A group address from the range kept for use inside one local network, and its port.
pub const GROUP: Ipv4Addr = Ipv4Addr::new(239, 255, 42, 99);
pub const PORT: u16 = 47822;
pub const ANNOUNCE_EVERY: Duration = Duration::from_secs(1);
const MAGIC: &str = "SNDISC1";
const MAX_NOTE_BYTES: usize = 200;
const MAX_FOUND: usize = 16;

/// A device that was heard.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Found {
    pub key: [u8; KEY_LEN],
    pub name: String,
    /// `ip:port`, from where the note came and the port it named.
    pub address: String,
}

/// Where notes go and where they are listened for. The real values use the multicast group and
/// the local broadcast address; tests use loopback only, so nothing leaves the computer.
#[derive(Clone, Debug)]
pub struct Route {
    pub listen: SocketAddr,
    /// The real network. Then notes also go out on every local network this device is on, not
    /// only along its main connection: a phone that makes a hotspot has mobile data (or nothing)
    /// as its main connection, and the hotspot is only one of its other networks (networks.rs).
    pub join_group: bool,
    pub send_to: Vec<SocketAddr>,
    pub interval: Duration,
}

impl Route {
    pub fn network() -> Route {
        Route {
            listen: SocketAddr::from(([0, 0, 0, 0], PORT)),
            join_group: true,
            send_to: vec![SocketAddr::from((GROUP, PORT)), SocketAddr::from((Ipv4Addr::BROADCAST, PORT))],
            interval: ANNOUNCE_EVERY,
        }
    }
}

fn encode(key: &[u8; KEY_LEN], name: &str, port: u16) -> Vec<u8> {
    format!("{MAGIC}\n{}\n{name}\n{port}", hex::encode(key)).into_bytes()
}

/// Reads one note. Anything that is not exactly a note gives `None`.
pub(crate) fn parse(bytes: &[u8], from: IpAddr) -> Option<Found> {
    if bytes.len() > MAX_NOTE_BYTES || from.is_unspecified() || from.is_multicast() || from == IpAddr::V4(Ipv4Addr::BROADCAST) {
        return None;
    }
    let text = std::str::from_utf8(bytes).ok()?;
    let mut lines = text.split('\n');
    if lines.next()? != MAGIC {
        return None;
    }
    let key = hex::decode::<KEY_LEN>(lines.next()?)?;
    let name = lines.next()?;
    // A name that is not already clean is not from a ScaleNote device.
    if name.is_empty() || clean_name(name) != name {
        return None;
    }
    let port: u16 = lines.next()?.parse().ok()?;
    if port == 0 || lines.next().is_some() {
        return None;
    }
    Some(Found { key, name: name.to_string(), address: SocketAddr::new(from, port).to_string() })
}

/// Sends notes once per interval until stopped or until `keep` says no (for example when the
/// pairing code has run out). Stopping waits for the thread, so nothing is sent afterwards.
pub struct Announcer {
    stop: Arc<AtomicBool>,
    handle: Option<JoinHandle<()>>,
}

impl Announcer {
    pub fn start(route: Route, key: [u8; KEY_LEN], name: String, port: u16, keep: impl Fn() -> bool + Send + 'static) -> io::Result<Announcer> {
        Announcer::start_with(route, key, name, port, keep, || None)
    }

    /// Like `start`, and each round also sends the note `extra` gives, if any (the people note of
    /// 0.6.4, which comes and goes with the "findable" switch).
    pub fn start_with(route: Route, key: [u8; KEY_LEN], name: String, port: u16, keep: impl Fn() -> bool + Send + 'static, extra: impl Fn() -> Option<Vec<u8>> + Send + 'static) -> io::Result<Announcer> {
        let socket = UdpSocket::bind("0.0.0.0:0")?;
        socket.set_broadcast(true)?;
        // 1: stay on this network, never cross a router.
        socket.set_multicast_ttl_v4(1)?;
        let stop = Arc::new(AtomicBool::new(false));
        let flag = stop.clone();
        let note = encode(&key, &name, port);
        let handle = thread::spawn(move || {
            while !flag.load(Ordering::SeqCst) && keep() {
                // A send that fails (no network right now) is simply tried again next time.
                for target in &route.send_to {
                    let _ = socket.send_to(&note, target);
                }
                if route.join_group {
                    // Looked up every round: a hotspot or a cable can come and go at any time.
                    send_on_every_network(&note, route.listen.port());
                }
                if let Some(person) = extra() {
                    for target in &route.send_to {
                        let _ = socket.send_to(&person, target);
                    }
                    if route.join_group {
                        send_on_every_network(&person, route.listen.port());
                    }
                }
                let until = Instant::now() + route.interval;
                while Instant::now() < until && !flag.load(Ordering::SeqCst) {
                    thread::sleep(Duration::from_millis(20));
                }
            }
        });
        Ok(Announcer { stop, handle: Some(handle) })
    }

    pub fn is_finished(&self) -> bool {
        match &self.handle {
            Some(handle) => handle.is_finished(),
            None => true,
        }
    }

    pub fn stop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        if let Some(handle) = self.handle.take() {
            let _ = handle.join();
        }
    }
}

impl Drop for Announcer {
    fn drop(&mut self) {
        self.stop();
    }
}

/// Sends the note on each local network separately, to that network's own broadcast address
/// (for a hotspot `192.168.43.255`, say). That address belongs to a network this device is
/// directly on, so the note leaves on that network even when it is not the main connection. The
/// socket is bound to this device's address there, so the note carries the right sender.
/// (Multicast per network would need a setting the standard library does not offer; the
/// broadcast reaches the same devices.)
fn send_on_every_network(note: &[u8], port: u16) {
    for net in super::networks::local_networks() {
        let Ok(socket) = UdpSocket::bind(SocketAddr::from((net.ip, 0))) else { continue };
        if socket.set_broadcast(true).is_ok() {
            let _ = socket.send_to(note, SocketAddr::from((net.broadcast(), port)));
        }
    }
}

/// Listens for `wait` and returns the devices heard (each once, at most 16), leaving out the
/// device with the key `own`.
pub fn find(route: &Route, wait: Duration, own: &[u8; KEY_LEN]) -> io::Result<Vec<Found>> {
    listen_for(route, wait, parse, |device: &Found, found: &[Found]| &device.key != own && !found.iter().any(|f| f.key == device.key))
}

/// Listens for `wait` and keeps every note `read` understands and `wanted` accepts (at most
/// `MAX_FOUND`). Device notes and people notes (0.6.4) are heard the same way.
fn listen_for<T>(route: &Route, wait: Duration, read: impl Fn(&[u8], IpAddr) -> Option<T>, wanted: impl Fn(&T, &[T]) -> bool) -> io::Result<Vec<T>> {
    let socket = UdpSocket::bind(route.listen)?;
    if route.join_group {
        // Joining can fail on a machine without a usable network; broadcast may still work.
        let _ = socket.join_multicast_v4(&GROUP, &Ipv4Addr::UNSPECIFIED);
        // Also on each local network by its own address: "unspecified" only means the main
        // connection, which is not the hotspot on a phone that makes one.
        for net in super::networks::local_networks() {
            let _ = socket.join_multicast_v4(&GROUP, &net.ip);
        }
    }
    let end = Instant::now() + wait;
    let mut found: Vec<T> = Vec::new();
    let mut buffer = [0u8; MAX_NOTE_BYTES + 1];
    loop {
        let left = end.saturating_duration_since(Instant::now());
        if left.is_zero() {
            break;
        }
        socket.set_read_timeout(Some(left.min(Duration::from_millis(200))))?;
        match socket.recv_from(&mut buffer) {
            Ok((size, from)) => {
                if let Some(item) = read(&buffer[..size], from.ip()) {
                    if found.len() < MAX_FOUND && wanted(&item, &found) {
                        found.push(item);
                    }
                }
            }
            Err(error) if matches!(error.kind(), io::ErrorKind::WouldBlock | io::ErrorKind::TimedOut) => {}
            // Any other read problem belongs to one packet, not to the search: Windows reports a
            // too-big packet (WSAEMSGSIZE) and a reset caused by an earlier send as errors, so one
            // hostile or odd packet must not end the search. The wait is bounded by `end`.
            Err(_) => thread::sleep(Duration::from_millis(5)),
        }
    }
    Ok(found)
}

/// A person who lets people nearby find them to share with (0.6.4): their account and one of
/// their devices. Sent in its own note, so apps before 0.6.4 (which only read device notes) are
/// not disturbed.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Person {
    pub account: [u8; super::account::ID_LEN],
    pub name: String,
    pub key: [u8; KEY_LEN],
    pub address: String,
}

const PERSON_MAGIC: &str = "SNPERSON1";

pub fn encode_person(account: &[u8; super::account::ID_LEN], name: &str, key: &[u8; KEY_LEN], port: u16) -> Vec<u8> {
    format!("{PERSON_MAGIC}\n{}\n{}\n{name}\n{port}", hex::encode(account), hex::encode(key)).into_bytes()
}

pub(crate) fn parse_person(bytes: &[u8], from: IpAddr) -> Option<Person> {
    if bytes.len() > MAX_NOTE_BYTES || from.is_unspecified() || from.is_multicast() || from == IpAddr::V4(Ipv4Addr::BROADCAST) {
        return None;
    }
    let mut lines = std::str::from_utf8(bytes).ok()?.split('\n');
    if lines.next()? != PERSON_MAGIC {
        return None;
    }
    let account = hex::decode::<{ super::account::ID_LEN }>(lines.next()?)?;
    let key = hex::decode::<KEY_LEN>(lines.next()?)?;
    let name = lines.next()?;
    if super::account::clean_person_name(name).as_deref() != Some(name) {
        return None;
    }
    let port: u16 = lines.next()?.parse().ok()?;
    if port == 0 || lines.next().is_some() {
        return None;
    }
    Some(Person { account, name: name.to_string(), key, address: SocketAddr::new(from, port).to_string() })
}

/// The people heard within `wait`, one entry per account, leaving out `own` (this person).
pub fn find_people(route: &Route, wait: Duration, own: Option<&[u8; super::account::ID_LEN]>) -> io::Result<Vec<Person>> {
    listen_for(route, wait, parse_person, |person: &Person, found: &[Person]| Some(&person.account) != own && !found.iter().any(|f| f.account == person.account))
}

#[cfg(test)]
mod network_tests {
    use super::*;

    /// On a machine with a local network, a note sent "on every network" arrives from this
    /// machine's own address there. Without one (some build machines), there is nothing to send on.
    #[test]
    fn a_note_goes_out_on_each_local_network_from_this_devices_address_there() {
        let nets = crate::sync::networks::local_networks();
        let listener = UdpSocket::bind("0.0.0.0:0").expect("bind");
        let port = listener.local_addr().expect("addr").port();
        listener.set_read_timeout(Some(Duration::from_millis(500))).expect("timeout");
        let note = encode(&[7u8; KEY_LEN], "alice", 47821);
        send_on_every_network(&note, port);
        let mut heard = Vec::new();
        let mut buffer = [0u8; MAX_NOTE_BYTES + 1];
        while let Ok((size, from)) = listener.recv_from(&mut buffer) {
            if let Some(found) = parse(&buffer[..size], from.ip()) {
                heard.push(found.address);
            }
        }
        for net in &nets {
            assert!(heard.contains(&format!("{}:47821", net.ip)), "nothing heard from {net:?}; heard {heard:?}");
        }
    }
}

