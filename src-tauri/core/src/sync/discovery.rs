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

/// Listens for `wait` and returns the devices heard (each once, at most 16), leaving out the
/// device with the key `own`.
pub fn find(route: &Route, wait: Duration, own: &[u8; KEY_LEN]) -> io::Result<Vec<Found>> {
    let socket = UdpSocket::bind(route.listen)?;
    if route.join_group {
        // Joining can fail on a machine without a usable network; broadcast may still work.
        let _ = socket.join_multicast_v4(&GROUP, &Ipv4Addr::UNSPECIFIED);
    }
    let end = Instant::now() + wait;
    let mut found: Vec<Found> = Vec::new();
    let mut buffer = [0u8; MAX_NOTE_BYTES + 1];
    loop {
        let left = end.saturating_duration_since(Instant::now());
        if left.is_zero() {
            break;
        }
        socket.set_read_timeout(Some(left.min(Duration::from_millis(200))))?;
        match socket.recv_from(&mut buffer) {
            Ok((size, from)) => {
                if let Some(device) = parse(&buffer[..size], from.ip()) {
                    if &device.key != own && found.len() < MAX_FOUND && !found.iter().any(|f| f.key == device.key) {
                        found.push(device);
                    }
                }
            }
            Err(error) if matches!(error.kind(), io::ErrorKind::WouldBlock | io::ErrorKind::TimedOut) => {}
            Err(error) => return Err(error),
        }
    }
    Ok(found)
}
