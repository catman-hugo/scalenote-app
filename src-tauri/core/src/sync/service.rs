//! The part of a device that listens for other devices and keeps the list of paired ones.
//!
//! The rules, all in one place so they can be tested together:
//! - The device listens on the network ONLY while sync is switched on AND (a device is paired OR
//!   the "Pair a device" screen is open). Otherwise it is silent: no open port at all.
//! - A device that is not paired can do exactly one thing: pair, with the open code. Anything
//!   else it sends is refused and the connection is closed.
//! - A paired device (its key is in the trust list) can ask "are you there"; real sync requests
//!   come in 0.5.3.
//! - Nothing happens without a trace: every pairing, refusal and removal is added to a list of
//!   recent events that the Sync tab shows.
//! - Limits: 8 connections at a time, 10 seconds for every read and write, small messages only.

use super::channel::Channel;
use super::device::clean_name;
use super::identity::{fingerprint, Identity, KEY_LEN};
use super::pairing::{self, clean_code, CodeBook, KIND_REFUSED, KIND_START};
use super::trust::{Peer, TrustList};
use super::{hex, Result, SyncError};
use crate::logger::format_utc;
use std::io;
use std::net::{Shutdown, SocketAddr, TcpListener, TcpStream, ToSocketAddrs};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

/// The first port tried; if it is taken the next ones are tried (a handful).
pub const DEFAULT_PORT: u16 = 47821;
const PORT_TRIES: u16 = 10;
const MAX_CONNECTIONS: usize = 8;
const IO_TIMEOUT: Duration = Duration::from_secs(10);
const MAX_EVENTS: usize = 50;
const TRUST_FILE: &str = "sync-peers.txt";

/// Questions a paired device can ask (more are added with the sync itself in 0.5.3).
const KIND_PING: u8 = 0x20;
const KIND_PONG: u8 = 0x21;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EventKind {
    Paired,
    /// A device that is not paired tried to do something other than pair, or used a wrong code.
    Refused,
    Removed,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Event {
    /// UTC time, `2026-11-14T12:00:00Z`.
    pub when: String,
    pub kind: EventKind,
    /// The paired or removed device's name (empty for a refusal).
    pub name: String,
}

struct State {
    trust: TrustList,
    codes: CodeBook,
    pairing_open: bool,
    enabled: bool,
    name: String,
    events: Vec<Event>,
}

struct Shared {
    /// Where to listen: normally every network interface and the default port; tests use the
    /// loopback address and a free port so they never open anything on the real network.
    bind_ip: &'static str,
    first_port: u16,
    identity: Identity,
    trust_path: PathBuf,
    state: Mutex<State>,
    connections: AtomicUsize,
}

struct Listener {
    stop: Arc<AtomicBool>,
    handle: JoinHandle<()>,
    port: u16,
}

pub struct Service {
    shared: Arc<Shared>,
    listener: Mutex<Option<Listener>>,
}

/// What the Sync tab shows.
#[derive(Clone, Debug)]
pub struct Status {
    pub enabled: bool,
    pub listening_port: Option<u16>,
    pub fingerprint: String,
    pub peers: Vec<PeerView>,
    /// Seconds the open code is still good for, or `None` when no code is open.
    pub pairing_seconds_left: Option<u64>,
    pub events: Vec<Event>,
}

#[derive(Clone, Debug)]
pub struct PeerView {
    /// The key as hex; it identifies the device in `remove_peer`.
    pub id: String,
    pub name: String,
    pub fingerprint: String,
    pub added: String,
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    // A panic in another thread must not lock the app out of its own settings.
    mutex.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn now_utc() -> String {
    format_utc(SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_secs()))
}

fn today() -> String {
    now_utc().chars().take(10).collect()
}

fn record(state: &mut State, kind: EventKind, name: &str) {
    state.events.push(Event { when: now_utc(), kind, name: name.to_string() });
    let extra = state.events.len().saturating_sub(MAX_EVENTS);
    state.events.drain(..extra);
}

/// Whether a device should be listening at all: sync on, and someone to talk to or a pairing
/// in progress.
pub fn should_listen(enabled: bool, paired: usize, pairing_open: bool) -> bool {
    enabled && (paired > 0 || pairing_open)
}

impl Service {
    /// `dir` is the app's own folder (outside any vault); the trust list lives there.
    pub fn new(dir: &Path, identity: Identity, name: &str, enabled: bool) -> Result<Service> {
        Service::with_bind(dir, identity, name, enabled, "0.0.0.0", DEFAULT_PORT)
    }

    pub(crate) fn with_bind(dir: &Path, identity: Identity, name: &str, enabled: bool, bind_ip: &'static str, first_port: u16) -> Result<Service> {
        let trust_path = dir.join(TRUST_FILE);
        let trust = TrustList::load(&trust_path)?;
        let state = State { trust, codes: CodeBook::default(), pairing_open: false, enabled, name: clean_name(name), events: Vec::new() };
        let service = Service { shared: Arc::new(Shared { bind_ip, first_port, identity, trust_path, state: Mutex::new(state), connections: AtomicUsize::new(0) }), listener: Mutex::new(None) };
        service.refresh()?;
        Ok(service)
    }

    /// Starts or stops listening to match the rules. Call after anything that changes them.
    pub fn refresh(&self) -> Result<()> {
        let want = may_listen(&self.shared);
        let mut listener = lock(&self.listener);
        // A listener that ended by itself is forgotten here so it can be started again.
        if listener.as_ref().is_some_and(|l| l.handle.is_finished()) {
            if let Some(ended) = listener.take() {
                let _ = ended.handle.join();
            }
        }
        match (want, listener.is_some()) {
            (true, false) => *listener = Some(self.spawn_listener()?),
            (false, true) => {
                if let Some(running) = listener.take() {
                    running.stop.store(true, Ordering::SeqCst);
                    let _ = running.handle.join();
                }
            }
            _ => {}
        }
        Ok(())
    }

    fn spawn_listener(&self) -> Result<Listener> {
        let mut bound = None;
        // Port 0 means "any free port" (tests); otherwise the default port and the next few.
        let tries = if self.shared.first_port == 0 { 1 } else { PORT_TRIES };
        for offset in 0..tries {
            if let Ok(socket) = TcpListener::bind((self.shared.bind_ip, self.shared.first_port + offset)) {
                bound = Some(socket);
                break;
            }
        }
        let socket = bound.ok_or_else(|| SyncError::Io(io::Error::new(io::ErrorKind::AddrInUse, "no free port")))?;
        self.start_on(socket)
    }

    fn start_on(&self, socket: TcpListener) -> Result<Listener> {
        socket.set_nonblocking(true)?;
        let port = socket.local_addr()?.port();
        let stop = Arc::new(AtomicBool::new(false));
        let shared = self.shared.clone();
        let flag = stop.clone();
        let handle = thread::spawn(move || {
            // The loop also ends by itself when the rules no longer allow listening (for
            // example when the code has run out), which closes the port without anyone asking.
            while !flag.load(Ordering::SeqCst) && may_listen(&shared) {
                match socket.accept() {
                    Ok((stream, _)) => {
                        if shared.connections.load(Ordering::SeqCst) >= MAX_CONNECTIONS {
                            let _ = stream.shutdown(Shutdown::Both);
                            continue;
                        }
                        shared.connections.fetch_add(1, Ordering::SeqCst);
                        let shared = shared.clone();
                        thread::spawn(move || {
                            let _ = handle_connection(&shared, stream);
                            shared.connections.fetch_sub(1, Ordering::SeqCst);
                        });
                    }
                    Err(error) if error.kind() == io::ErrorKind::WouldBlock => thread::sleep(Duration::from_millis(40)),
                    Err(_) => thread::sleep(Duration::from_millis(200)),
                }
            }
        });
        Ok(Listener { stop, handle, port })
    }

    pub fn set_enabled(&self, enabled: bool) -> Result<()> {
        {
            let mut state = lock(&self.shared.state);
            state.enabled = enabled;
            if !enabled {
                state.pairing_open = false;
                state.codes.close();
            }
        }
        self.refresh()
    }

    /// For tests: a code that runs out quickly.
    #[cfg(test)]
    pub(crate) fn set_code_lifetime(&self, lifetime: Duration) {
        lock(&self.shared.state).codes.set_lifetime(lifetime);
    }

    /// For tests: the private key as hex, to check that it never lands in a file.
    #[cfg(test)]
    pub(crate) fn private_key_hex(&self) -> String {
        hex::encode(self.shared.identity.private())
    }

    pub fn set_name(&self, name: &str) {
        lock(&self.shared.state).name = clean_name(name);
    }

    /// Opens the pairing screen: makes a code to show and starts listening if it was not.
    pub fn start_pairing(&self) -> Result<String> {
        let code = {
            let mut state = lock(&self.shared.state);
            if !state.enabled {
                return Err(SyncError::Refused("sync is off"));
            }
            state.pairing_open = true;
            state.codes.open(Instant::now())?
        };
        self.refresh()?;
        Ok(code)
    }

    /// Closes the pairing screen; the code stops working at once.
    pub fn stop_pairing(&self) -> Result<()> {
        {
            let mut state = lock(&self.shared.state);
            state.pairing_open = false;
            state.codes.close();
        }
        self.refresh()
    }

    /// The other direction: this device types the code and goes to the other device's address
    /// (`host:port`; the port may be left out). Blocks until it is done or fails (at most about
    /// 30 seconds).
    pub fn join(&self, address: &str, typed_code: &str) -> Result<Peer> {
        let code = clean_code(typed_code).ok_or(SyncError::Refused("the code is not 8 digits"))?;
        let name = lock(&self.shared.state).name.clone();
        let stream = connect_to(address)?;
        let mut channel = Channel::connect(stream, &self.shared.identity)?;
        let peer = pairing::join(&mut channel, &code, &name, &today())?;
        self.trust(peer.clone())?;
        Ok(peer)
    }

    fn trust(&self, peer: Peer) -> Result<()> {
        trust_peer(&self.shared, peer)?;
        self.refresh()
    }

    pub fn remove_peer(&self, id: &str) -> Result<bool> {
        let key = hex::decode::<KEY_LEN>(id).ok_or(SyncError::Refused("not a device id"))?;
        let removed = {
            let mut state = lock(&self.shared.state);
            let name = state.trust.peers().iter().find(|p| p.public == key).map(|p| p.name.clone());
            if state.trust.remove(&key) {
                state.trust.save(&self.shared.trust_path)?;
                record(&mut state, EventKind::Removed, name.as_deref().unwrap_or(""));
                true
            } else {
                false
            }
        };
        self.refresh()?;
        Ok(removed)
    }

    pub fn status(&self) -> Status {
        let listening_port = lock(&self.listener).as_ref().filter(|l| !l.handle.is_finished()).map(|l| l.port);
        let state = lock(&self.shared.state);
        let now = Instant::now();
        let peers = state
            .trust
            .peers()
            .iter()
            .map(|p| PeerView { id: hex::encode(&p.public), name: p.name.clone(), fingerprint: fingerprint(&p.public), added: p.added.clone() })
            .collect();
        Status {
            enabled: state.enabled,
            listening_port,
            fingerprint: fingerprint(self.shared.identity.public()),
            peers,
            pairing_seconds_left: if state.pairing_open && state.codes.is_open(now) { state.codes.seconds_left(now) } else { None },
            events: state.events.clone(),
        }
    }

    /// Stops listening (the app is closing).
    pub fn shutdown(&self) {
        {
            let mut state = lock(&self.shared.state);
            state.enabled = false;
            state.codes.close();
        }
        let _ = self.refresh();
    }
}

fn may_listen(shared: &Shared) -> bool {
    let state = lock(&shared.state);
    should_listen(state.enabled, state.trust.peers().len(), state.pairing_open && state.codes.is_open(Instant::now()))
}

fn trust_peer(shared: &Shared, peer: Peer) -> Result<()> {
    let mut state = lock(&shared.state);
    let mut updated = state.trust.clone();
    updated.add(&peer.name, peer.public, &peer.added)?;
    // Saved first: if the file cannot be written, nobody is trusted that is not on disk.
    updated.save(&shared.trust_path)?;
    state.trust = updated;
    record(&mut state, EventKind::Paired, &peer.name);
    Ok(())
}

fn connect_to(address: &str) -> Result<TcpStream> {
    let with_port = if address.rsplit_once(':').is_some_and(|(_, port)| port.parse::<u16>().is_ok()) { address.to_string() } else { format!("{address}:{DEFAULT_PORT}") };
    let target: SocketAddr = with_port.to_socket_addrs()?.next().ok_or(SyncError::Refused("address not found"))?;
    let stream = TcpStream::connect_timeout(&target, IO_TIMEOUT)?;
    stream.set_read_timeout(Some(IO_TIMEOUT))?;
    stream.set_write_timeout(Some(IO_TIMEOUT))?;
    Ok(stream)
}

/// One incoming connection, start to end. Errors only end the connection.
fn handle_connection(shared: &Shared, stream: TcpStream) -> Result<()> {
    stream.set_nonblocking(false)?;
    stream.set_read_timeout(Some(IO_TIMEOUT))?;
    stream.set_write_timeout(Some(IO_TIMEOUT))?;
    let mut channel = Channel::accept(stream, &shared.identity)?;
    let first = channel.recv()?;
    let remote = *channel.remote();
    let (trusted, name) = {
        let state = lock(&shared.state);
        (state.trust.contains(&remote), state.name.clone())
    };
    match first.first().copied() {
        Some(KIND_START) => {
            let code = {
                let mut state = lock(&shared.state);
                if state.pairing_open { state.codes.take_attempt(Instant::now()) } else { None }
            };
            match pairing::host_from(&mut channel, first, code.as_deref(), &name, &today()) {
                Ok(peer) => {
                    {
                        let mut state = lock(&shared.state);
                        state.codes.close();
                        state.pairing_open = false;
                    }
                    trust_peer(shared, peer)
                }
                Err(error) => {
                    record(&mut lock(&shared.state), EventKind::Refused, "");
                    Err(error)
                }
            }
        }
        Some(KIND_PING) if trusted => {
            let mut answer = vec![KIND_PONG];
            answer.extend_from_slice(name.as_bytes());
            channel.send(&answer)
        }
        _ => {
            // Not paired, or not something a device may ask: say no and hang up.
            let _ = channel.send(&[KIND_REFUSED]);
            record(&mut lock(&shared.state), EventKind::Refused, "");
            Err(SyncError::Refused("not allowed"))
        }
    }
}

/// Asks a paired device "are you there" over a fresh connection; returns its name. This is how
/// the trust list is shown to work end to end (the sync requests of 0.5.3 use the same road).
pub fn ping(service: &Service, address: &str) -> Result<String> {
    let stream = connect_to(address)?;
    let mut channel = Channel::connect(stream, &service.shared.identity)?;
    channel.send(&[KIND_PING])?;
    let answer = channel.recv()?;
    if answer.first() == Some(&KIND_PONG) {
        Ok(String::from_utf8_lossy(&answer[1..]).into_owned())
    } else {
        Err(SyncError::Refused("not paired with that device"))
    }
}

/// This device's address on the local network, as far as the system can tell, for showing to
/// the person ("type this on the other device"). It asks the system which interface it would
/// use to reach another network; a UDP "connection" sends nothing, so no packet leaves. `None`
/// when there is no network.
pub fn local_address_hint() -> Option<String> {
    let socket = std::net::UdpSocket::bind("0.0.0.0:0").ok()?;
    // 192.0.2.1 is a documentation address: it is never a real machine.
    socket.connect("192.0.2.1:9").ok()?;
    let ip = socket.local_addr().ok()?.ip();
    (!ip.is_unspecified() && !ip.is_loopback()).then(|| ip.to_string())
}
