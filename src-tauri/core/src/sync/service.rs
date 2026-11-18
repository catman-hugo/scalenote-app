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
use super::discovery::{self, Announcer, Route};
use super::engine::{self, Outcome, Pair, Preview, Progress, Report};
use super::exchange::{self, is_sync_kind, KIND_NO};
use super::identity::{fingerprint, Identity, KEY_LEN};
use super::pairing::{self, clean_code, CodeBook, KIND_REFUSED, KIND_START};
use super::trust::{Peer, TrustList};
use super::{hex, Result, SyncError};
use crate::logger::format_utc;
use std::collections::{HashMap, HashSet};
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
/// A sync of a big vault can keep the other side busy (making its list) for a while.
const SYNC_TIMEOUT: Duration = Duration::from_secs(120);
/// With nothing changed here, a paired device is still synced again after this long.
const RESYNC_AFTER: Duration = Duration::from_secs(300);
const TRUST_FILE: &str = "sync-peers.txt";

/// Questions a paired device can ask (more are added with the sync itself in 0.5.3).
const KIND_PING: u8 = 0x20;
const KIND_PONG: u8 = 0x21;
/// "Which version of the app are you?" A paired device asks it after a sync and answers with its own, so
/// the device list can show who runs an old version. An older app answers "no", which is read as unknown.
const KIND_HELLO: u8 = 0x22;
const KIND_HELLO_ACK: u8 = 0x23;
/// The version of this build, sent to paired devices. Core and app are always given the same number.
pub const APP_VERSION: &str = env!("CARGO_PKG_VERSION");

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EventKind {
    Paired,
    /// A device that is not paired tried to do something other than pair, or used a wrong code.
    Refused,
    Removed,
    /// A sync finished (either side started it); `changed` is how many files changed.
    Synced,
    /// A sync did not finish.
    SyncFailed,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Event {
    /// UTC time, `2026-11-14T12:00:00Z`.
    pub when: String,
    pub kind: EventKind,
    /// The paired or removed device's name (empty for a refusal).
    pub name: String,
    /// For `Synced`: how many files changed on either side. 0 for the other kinds.
    pub changed: usize,
}

struct State {
    trust: TrustList,
    codes: CodeBook,
    pairing_open: bool,
    enabled: bool,
    name: String,
    events: Vec<Event>,
    /// The vault that sync works on (the folder the app has open), if any.
    vault: Option<PathBuf>,
    paused: bool,
    /// Devices this one may sync with only while the phone or computer is on Wi-Fi (or a wired
    /// network). Kept for this run; the interface sends it again at start.
    wifi_only: HashSet<[u8; KEY_LEN]>,
    /// Whether the connection is Wi-Fi or wired right now. Where the system cannot tell, this
    /// stays true, so nothing is ever blocked by a guess.
    on_wifi: bool,
    /// What this device knows about each paired device since the app started.
    live: HashMap<[u8; KEY_LEN], Live>,
    syncing: Option<SyncingView>,
}

#[derive(Default)]
struct Live {
    /// Where it was last reached or heard.
    address: Option<String>,
    last_sync: String,
    last_changed: usize,
    /// The app version the device told us, if it did.
    version: String,
    /// The vault's change signature right after the last sync, and when that was.
    synced_signature: Option<u64>,
    synced_at: Option<Instant>,
}

/// A sync that is running right now, for the status line.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SyncingView {
    pub name: String,
    pub done: usize,
    pub total: usize,
}

/// What one automatic round did with one device.
pub struct AutoResult {
    pub name: String,
    /// The report, or the short code of what went wrong.
    pub outcome: std::result::Result<Report, &'static str>,
}

struct Shared {
    /// Where to listen: normally every network interface and the default port; tests use the
    /// loopback address and a free port so they never open anything on the real network.
    bind_ip: &'static str,
    first_port: u16,
    /// Use exactly `first_port` and never the next ones. The home server needs this: each vault
    /// has its own port, and a vault must never quietly end up on its neighbour's.
    strict_port: bool,
    identity: Identity,
    trust_path: PathBuf,
    /// Where discovery notes go and are listened for (loopback only in tests).
    route: Mutex<Route>,
    state: Mutex<State>,
    connections: AtomicUsize,
    /// Held for the whole of a sync (either direction), so two syncs never write the same vault.
    session: Mutex<()>,
}

struct Listener {
    stop: Arc<AtomicBool>,
    handle: JoinHandle<()>,
    port: u16,
}

pub struct Service {
    shared: Arc<Shared>,
    listener: Mutex<Option<Listener>>,
    /// Shouts "I am here" while a pairing code is showing, and only then.
    announcer: Mutex<Option<Announcer>>,
}

/// A device heard on the network.
#[derive(Clone, Debug)]
pub struct Nearby {
    pub name: String,
    /// `ip:port`, ready for `join`.
    pub address: String,
    /// Already in the trust list.
    pub paired: bool,
}

/// What the Sync tab shows.
#[derive(Clone, Debug)]
pub struct Status {
    pub enabled: bool,
    pub listening_port: Option<u16>,
    pub fingerprint: String,
    pub paused: bool,
    pub on_wifi: bool,
    pub syncing: Option<SyncingView>,
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
    /// When this device last synced with it, in UTC. After a restart it is read from the saved list of
    /// the vault, so it is not lost ("" if never).
    pub last_sync: String,
    pub last_changed: usize,
    /// The app version the device reported at the last sync ("" if it never did, for example an older app).
    pub version: String,
    /// The device's version is known and is older than this device's.
    pub older: bool,
    /// There is a saved list for it in the open vault, so the next sync is not a first one.
    pub has_history: bool,
    /// Syncs with this device only on Wi-Fi.
    pub wifi_only: bool,
}

/// The real network route, unless the service is bound to loopback (tests), where nothing may
/// leave the computer: a route that sends nowhere.
fn initial_route(bind_ip: &str) -> Route {
    if bind_ip == "0.0.0.0" {
        Route::network()
    } else {
        Route { listen: SocketAddr::from(([127, 0, 0, 1], 0)), join_group: false, send_to: Vec::new(), interval: Duration::from_secs(1) }
    }
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
    record_changed(state, kind, name, 0);
}

fn record_changed(state: &mut State, kind: EventKind, name: &str, changed: usize) {
    state.events.push(Event { when: now_utc(), kind, name: name.to_string(), changed });
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

    /// Like `new`, but on exactly this port (the home server gives each vault its own).
    pub fn on_port(dir: &Path, identity: Identity, name: &str, enabled: bool, port: u16) -> Result<Service> {
        Service::build(dir, identity, name, enabled, "0.0.0.0", port, true)
    }

    pub(crate) fn with_bind(dir: &Path, identity: Identity, name: &str, enabled: bool, bind_ip: &'static str, first_port: u16) -> Result<Service> {
        Service::build(dir, identity, name, enabled, bind_ip, first_port, false)
    }

    fn build(dir: &Path, identity: Identity, name: &str, enabled: bool, bind_ip: &'static str, first_port: u16, strict_port: bool) -> Result<Service> {
        let trust_path = dir.join(TRUST_FILE);
        let trust = TrustList::load(&trust_path)?;
        let state = State { trust, codes: CodeBook::default(), pairing_open: false, enabled, name: clean_name(name), events: Vec::new(), vault: None, paused: false, wifi_only: HashSet::new(), on_wifi: true, live: HashMap::new(), syncing: None };
        let service = Service { shared: Arc::new(Shared { bind_ip, first_port, strict_port, identity, trust_path, route: Mutex::new(initial_route(bind_ip)), state: Mutex::new(state), connections: AtomicUsize::new(0), session: Mutex::new(()) }), listener: Mutex::new(None), announcer: Mutex::new(None) };
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
        let port = listener.as_ref().map(|l| l.port);
        drop(listener);
        self.refresh_announcer(port);
        Ok(())
    }

    /// The announcement runs exactly while a pairing code is showing on a listening device.
    fn refresh_announcer(&self, port: Option<u16>) {
        let mut announcer = lock(&self.announcer);
        if announcer.as_ref().is_some_and(|a| a.is_finished()) {
            announcer.take();
        }
        let showing = announcing(&self.shared);
        match (showing.then_some(port).flatten(), announcer.is_some()) {
            (Some(port), false) => {
                let (route, key, name) = (lock(&self.shared.route).clone(), *self.shared.identity.public(), lock(&self.shared.state).name.clone());
                let shared = self.shared.clone();
                let keep = move || announcing(&shared);
                // Not being able to announce is not fatal: the address can still be typed.
                *announcer = Announcer::start(route, key, name, port, keep).ok();
            }
            (None, true) => {
                announcer.take();
            }
            _ => {}
        }
    }

    /// Listens for a few seconds for devices that are showing a pairing code. Only when sync is
    /// on. The device's own announcements are left out.
    pub fn find_nearby(&self, wait: Duration) -> Result<Vec<Nearby>> {
        if !lock(&self.shared.state).enabled {
            return Err(SyncError::Refused("sync is off"));
        }
        let route = lock(&self.shared.route).clone();
        let heard = discovery::find(&route, wait, self.shared.identity.public())?;
        let state = lock(&self.shared.state);
        Ok(heard.into_iter().map(|d| Nearby { paired: state.trust.contains(&d.key), name: d.name, address: d.address }).collect())
    }

    /// For tests: discovery on loopback only, with quick notes.
    #[cfg(test)]
    pub(crate) fn set_route(&self, route: Route) {
        *lock(&self.shared.route) = route;
    }

    fn spawn_listener(&self) -> Result<Listener> {
        let mut bound = None;
        // Port 0 means "any free port" (tests); otherwise the default port and the next few.
        let tries = if self.shared.first_port == 0 || self.shared.strict_port { 1 } else { PORT_TRIES };
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

    /// For tests: this device's identity, to speak the protocol by hand as a paired device.
    #[cfg(test)]
    pub(crate) fn identity_for_tests(&self) -> &Identity {
        &self.shared.identity
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
        // Remember where it was reached, so the first sync does not have to look for it.
        if let Ok(target) = stream_address(address) {
            lock(&self.shared.state).live.entry(peer.public).or_default().address = Some(target);
        }
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
                state.live.remove(&key);
                if let Some(root) = &state.vault {
                    engine::forget_base(root, &key);
                }
                record(&mut state, EventKind::Removed, name.as_deref().unwrap_or(""));
                true
            } else {
                false
            }
        };
        self.refresh()?;
        Ok(removed)
    }

    /// The vault that sync works on: the folder the app has open. `None` when there is none.
    pub fn set_vault(&self, root: Option<PathBuf>) {
        lock(&self.shared.state).vault = root;
    }

    /// Pauses or resumes sync. While paused this device neither starts a sync nor answers one,
    /// and stops announcing itself. Pairing still works. It is not saved: closing the app ends it.
    pub fn set_paused(&self, paused: bool) -> Result<()> {
        lock(&self.shared.state).paused = paused;
        self.refresh()
    }

    /// Changes the name shown for a paired device (only on this device; the other one keeps
    /// calling itself what it likes).
    /// Limits syncing with one paired device to Wi-Fi (or a wired network).
    pub fn set_wifi_only(&self, id: &str, only: bool) -> Result<()> {
        let key = hex::decode::<KEY_LEN>(id).ok_or(SyncError::Refused("not a device id"))?;
        let mut state = lock(&self.shared.state);
        if !state.trust.peers().iter().any(|p| p.public == key) {
            return Err(SyncError::Refused("not a paired device"));
        }
        if only {
            state.wifi_only.insert(key);
        } else {
            state.wifi_only.remove(&key);
        }
        Ok(())
    }

    /// Tells the service what kind of network the system is on. Only the interface can ask the
    /// system, so it reports here; devices set to Wi-Fi only are left alone while this is false.
    pub fn set_on_wifi(&self, on_wifi: bool) {
        lock(&self.shared.state).on_wifi = on_wifi;
    }

    pub fn rename_peer(&self, id: &str, name: &str) -> Result<()> {
        let key = hex::decode::<KEY_LEN>(id).ok_or(SyncError::Refused("not a device id"))?;
        let mut state = lock(&self.shared.state);
        let added = state.trust.peers().iter().find(|p| p.public == key).map(|p| p.added.clone()).ok_or(SyncError::Refused("not a paired device"))?;
        let mut updated = state.trust.clone();
        updated.add(name, key, &added)?;
        updated.save(&self.shared.trust_path)?;
        state.trust = updated;
        Ok(())
    }

    /// Everything a sync with one paired device needs, or the reason it cannot start.
    fn prepare(&self, id: &str) -> Result<(Peer, PathBuf, String)> {
        let key = hex::decode::<KEY_LEN>(id).ok_or(SyncError::Refused("not a device id"))?;
        let state = lock(&self.shared.state);
        if !state.enabled {
            return Err(SyncError::Refused("sync is off"));
        }
        if state.paused {
            return Err(SyncError::Refused("sync is paused"));
        }
        let peer = state.trust.peers().iter().find(|p| p.public == key).cloned().ok_or(SyncError::Refused("not a paired device"))?;
        if state.wifi_only.contains(&peer.public) && !state.on_wifi {
            return Err(SyncError::Refused("only on Wi-Fi"));
        }
        let root = state.vault.clone().ok_or(SyncError::Refused("no vault is open"))?;
        Ok((peer, root, state.name.clone()))
    }

    /// Opens the encrypted connection to a paired device: the address it was last seen at, and
    /// if that fails a short look at the network for its announcement. Checks that the device
    /// that answers really holds the key of the paired device.
    fn reach(&self, peer: &Peer) -> Result<Channel<TcpStream>> {
        let known = lock(&self.shared.state).live.get(&peer.public).and_then(|l| l.address.clone());
        if let Some(address) = known {
            if let Ok(channel) = self.open(&address, peer) {
                return Ok(channel);
            }
        }
        let route = lock(&self.shared.route).clone();
        let heard = discovery::find(&route, Duration::from_millis(3500), self.shared.identity.public())?;
        let found = heard.into_iter().find(|d| d.key == peer.public).ok_or(SyncError::Refused("device not found"))?;
        self.open(&found.address, peer)
    }

    fn open(&self, address: &str, peer: &Peer) -> Result<Channel<TcpStream>> {
        let stream = connect_to(address)?;
        let channel = Channel::connect(stream, &self.shared.identity)?;
        if channel.remote() != &peer.public {
            return Err(SyncError::Refused("not the paired device"));
        }
        channel.stream().set_read_timeout(Some(SYNC_TIMEOUT))?;
        channel.stream().set_write_timeout(Some(SYNC_TIMEOUT))?;
        lock(&self.shared.state).live.entry(peer.public).or_default().address = stream_address(address).ok();
        Ok(channel)
    }

    fn take_session(&self) -> Result<MutexGuard<'_, ()>> {
        match self.shared.session.try_lock() {
            Ok(guard) => Ok(guard),
            Err(std::sync::TryLockError::Poisoned(poisoned)) => Ok(poisoned.into_inner()),
            Err(std::sync::TryLockError::WouldBlock) => Err(SyncError::Refused("sync is busy")),
        }
    }

    /// What a sync with that device would change. Changes nothing on either side.
    pub fn compare_peer(&self, id: &str) -> Result<Preview> {
        let (peer, root, own_name) = self.prepare(id)?;
        let _session = self.take_session()?;
        let mut channel = self.reach(&peer)?;
        engine::compare(&mut channel, &Pair { root: &root, peer_key: &peer.public, own_name: &own_name, peer_name: &peer.name, today: &today() })
    }

    /// Syncs with one paired device. The first sync with a device changes nothing until
    /// `approved` is true. `on_progress` is called as files are done.
    pub fn sync_peer(&self, id: &str, approved: bool, on_progress: &mut dyn FnMut(Progress)) -> Result<Outcome> {
        let (peer, root, own_name) = self.prepare(id)?;
        let _session = self.take_session()?;
        let result = self.sync_locked(&peer, &root, &own_name, approved, on_progress);
        let mut state = lock(&self.shared.state);
        state.syncing = None;
        match &result {
            Ok(Outcome::Done(report)) => {
                record_changed(&mut state, EventKind::Synced, &peer.name, report.changed());
                let signature = super::watch::signature(&root);
                let live = state.live.entry(peer.public).or_default();
                live.last_sync = now_utc();
                live.last_changed = report.changed();
                live.synced_signature = Some(signature);
                live.synced_at = Some(Instant::now());
                drop(state);
                self.exchange_version(&peer);
                return result;
            }
            Ok(Outcome::NeedsApproval(_)) => {}
            Err(_) => record(&mut state, EventKind::SyncFailed, &peer.name),
        }
        result
    }

    /// Asks a paired device for its app version over a short connection and tells it ours. Best effort:
    /// any failure (an older app, a device that went away) just leaves the version unknown.
    fn exchange_version(&self, peer: &Peer) {
        let known = lock(&self.shared.state).live.get(&peer.public).and_then(|l| l.address.clone());
        let Some(address) = known else { return };
        let Ok(mut channel) = self.open(&address, peer) else { return };
        let mut hello = vec![KIND_HELLO];
        hello.extend_from_slice(APP_VERSION.as_bytes());
        if channel.send(&hello).is_err() {
            return;
        }
        if let Ok(answer) = channel.recv() {
            if answer.first() == Some(&KIND_HELLO_ACK) {
                if let Some(version) = clean_version(&answer[1..]) {
                    lock(&self.shared.state).live.entry(peer.public).or_default().version = version;
                }
            }
        }
    }

    fn sync_locked(&self, peer: &Peer, root: &Path, own_name: &str, approved: bool, on_progress: &mut dyn FnMut(Progress)) -> Result<Outcome> {
        let mut channel = self.reach(peer)?;
        let shared = self.shared.clone();
        let name = peer.name.clone();
        lock(&shared.state).syncing = Some(SyncingView { name: name.clone(), done: 0, total: 0 });
        let mut report = |progress: Progress| {
            lock(&shared.state).syncing = Some(SyncingView { name: name.clone(), done: progress.done, total: progress.total });
            on_progress(progress);
        };
        engine::run(&mut channel, &Pair { root, peer_key: &peer.public, own_name, peer_name: &peer.name, today: &today() }, approved, &mut report)
    }

    /// One round of automatic syncing, called every little while by the app. Does nothing (and
    /// opens no connection, sends nothing) unless a paired device with a sync history is due:
    /// something changed here since the last sync, or it has been a few minutes. A device that
    /// has never synced here is never started automatically: the first sync waits for a yes.
    /// It looks for the due devices on the network for at most `look`.
    pub fn auto_sync_tick(&self, look: Duration) -> Vec<AutoResult> {
        let due = self.due_peers();
        if due.is_empty() {
            return Vec::new();
        }
        let route = lock(&self.shared.route).clone();
        let heard = discovery::find(&route, look, self.shared.identity.public()).unwrap_or_default();
        let mut results = Vec::new();
        for peer in due {
            let Some(found) = heard.iter().find(|d| d.key == peer.public) else { continue };
            lock(&self.shared.state).live.entry(peer.public).or_default().address = Some(found.address.clone());
            let outcome = match self.sync_peer(&hex::encode(&peer.public), false, &mut |_| {}) {
                Ok(Outcome::Done(report)) => Ok(report),
                Ok(Outcome::NeedsApproval(_)) => continue,
                Err(error) => Err(error.code()),
            };
            results.push(AutoResult { name: peer.name.clone(), outcome });
        }
        results
    }

    fn due_peers(&self) -> Vec<Peer> {
        let state = lock(&self.shared.state);
        let Some(root) = state.vault.clone() else { return Vec::new() };
        if !state.enabled || state.paused || state.syncing.is_some() {
            return Vec::new();
        }
        let signature = super::watch::signature(&root);
        state
            .trust
            .peers()
            .iter()
            .filter(|p| !state.wifi_only.contains(&p.public) || state.on_wifi)
            .filter(|p| engine::has_history(&root, &p.public))
            .filter(|p| match state.live.get(&p.public) {
                Some(live) => live.synced_signature != Some(signature) || live.synced_at.map_or(true, |at| at.elapsed() >= RESYNC_AFTER),
                None => true,
            })
            .cloned()
            .collect()
    }

    pub fn status(&self) -> Status {
        let listening_port = lock(&self.listener).as_ref().filter(|l| !l.handle.is_finished()).map(|l| l.port);
        let state = lock(&self.shared.state);
        let now = Instant::now();
        let peers = state
            .trust
            .peers()
            .iter()
            .map(|p| {
                let live = state.live.get(&p.public);
                PeerView {
                    id: hex::encode(&p.public),
                    name: p.name.clone(),
                    fingerprint: fingerprint(&p.public),
                    added: p.added.clone(),
                    last_sync: live.map(|l| l.last_sync.clone()).filter(|t| !t.is_empty()).or_else(|| state.vault.as_ref().and_then(|root| engine::last_sync_time(root, &p.public))).unwrap_or_default(),
                    last_changed: live.map_or(0, |l| l.last_changed),
                    version: live.map(|l| l.version.clone()).unwrap_or_default(),
                    older: live.is_some_and(|l| is_older(&l.version, APP_VERSION)),
                    has_history: state.vault.as_ref().is_some_and(|root| engine::has_history(root, &p.public)),
                    wifi_only: state.wifi_only.contains(&p.public),
                }
            })
            .collect();
        Status {
            enabled: state.enabled,
            listening_port,
            fingerprint: fingerprint(self.shared.identity.public()),
            paused: state.paused,
            on_wifi: state.on_wifi,
            syncing: state.syncing.clone(),
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

/// Whether this device should be shouting "I am here": while a pairing code shows, and while
/// it has paired devices and sync is on and not paused (so a paired device finds it again after
/// the address changed). Never otherwise.
fn announcing(shared: &Shared) -> bool {
    let state = lock(&shared.state);
    let pairing = state.pairing_open && state.codes.is_open(Instant::now());
    state.enabled && (pairing || (!state.paused && !state.trust.is_empty()))
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

/// The answering side of a sync: only for a paired device, only when this device has a vault
/// open and has not paused sync, and only one sync at a time.
fn serve_sync(shared: &Shared, channel: &mut Channel<TcpStream>, first: Vec<u8>, remote: &[u8; KEY_LEN]) -> Result<()> {
    channel.stream().set_read_timeout(Some(SYNC_TIMEOUT))?;
    channel.stream().set_write_timeout(Some(SYNC_TIMEOUT))?;
    let (root, allowed, peer_name) = {
        let state = lock(&shared.state);
        let name = state.trust.peers().iter().find(|p| &p.public == remote).map(|p| p.name.clone()).unwrap_or_default();
        (state.vault.clone(), !state.paused && state.enabled, name)
    };
    let guard = match shared.session.try_lock() {
        Ok(guard) => Some(guard),
        Err(std::sync::TryLockError::Poisoned(poisoned)) => Some(poisoned.into_inner()),
        Err(std::sync::TryLockError::WouldBlock) => None,
    };
    let (Some(root), Some(_guard)) = (root, guard) else {
        // No vault open, or another sync is running: say so and let the other device try later.
        let _ = exchange::send_blob(channel, KIND_NO, &[], &[]);
        return Err(SyncError::Refused("sync is busy"));
    };
    let result = engine_serve(channel, first, &root, allowed);
    let mut state = lock(&shared.state);
    match &result {
        Ok(changed) => {
            record_changed(&mut state, EventKind::Synced, &peer_name, *changed);
            let signature = super::watch::signature(&root);
            let live = state.live.entry(*remote).or_default();
            live.last_sync = now_utc();
            live.last_changed = *changed;
            live.synced_signature = Some(signature);
            live.synced_at = Some(Instant::now());
        }
        Err(_) => record(&mut state, EventKind::SyncFailed, &peer_name),
    }
    result.map(|_| ())
}

fn engine_serve(channel: &mut Channel<TcpStream>, first: Vec<u8>, root: &Path, allowed: bool) -> Result<usize> {
    exchange::serve(channel, first, root, allowed)
}

/// The `ip:port` a typed address leads to (the default port when none was typed).
fn stream_address(address: &str) -> Result<String> {
    let with_port = if address.rsplit_once(':').is_some_and(|(_, port)| port.parse::<u16>().is_ok()) { address.to_string() } else { format!("{address}:{DEFAULT_PORT}") };
    Ok(with_port.to_socket_addrs()?.next().ok_or(SyncError::Refused("address not found"))?.to_string())
}

/// Whether `theirs` is an older version than `ours` ("0.5.4" against "0.5.5"). Unknown or odd text is not older.
pub fn is_older(theirs: &str, ours: &str) -> bool {
    let parse = |text: &str| -> Option<Vec<u32>> { text.split('.').map(|part| part.parse().ok()).collect() };
    match (parse(theirs), parse(ours)) {
        (Some(a), Some(b)) if !theirs.is_empty() => a < b,
        _ => false,
    }
}

/// A version from another device is shown on screen, so only digits, dots and a short length are accepted.
fn clean_version(raw: &[u8]) -> Option<String> {
    let text = std::str::from_utf8(raw).ok()?;
    (!text.is_empty() && text.len() <= 20 && text.bytes().all(|b| b.is_ascii_digit() || b == b'.')).then(|| text.to_string())
}

fn connect_to(address: &str) -> Result<TcpStream> {
    let with_port = if address.rsplit_once(':').is_some_and(|(_, port)| port.parse::<u16>().is_ok()) { address.to_string() } else { format!("{address}:{DEFAULT_PORT}") };
    let target: SocketAddr = with_port.to_socket_addrs()?.next().ok_or(SyncError::Refused("address not found"))?;
    let stream = TcpStream::connect_timeout(&target, IO_TIMEOUT)?;
    stream.set_read_timeout(Some(IO_TIMEOUT))?;
    stream.set_write_timeout(Some(IO_TIMEOUT))?;
    // Send each message at once; waiting to batch small ones only slows a sync down.
    stream.set_nodelay(true)?;
    Ok(stream)
}

/// One incoming connection, start to end. Errors only end the connection.
fn handle_connection(shared: &Shared, stream: TcpStream) -> Result<()> {
    stream.set_nonblocking(false)?;
    stream.set_nodelay(true)?;
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
        Some(KIND_HELLO) if trusted => {
            if let Some(version) = clean_version(&first[1..]) {
                lock(&shared.state).live.entry(remote).or_default().version = version;
            }
            let mut answer = vec![KIND_HELLO_ACK];
            answer.extend_from_slice(APP_VERSION.as_bytes());
            channel.send(&answer)
        }
        Some(KIND_PING) if trusted => {
            let mut answer = vec![KIND_PONG];
            answer.extend_from_slice(name.as_bytes());
            channel.send(&answer)
        }
        Some(kind) if trusted && is_sync_kind(kind) => serve_sync(shared, &mut channel, first, &remote),
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
