//! Tests for the listening service: who may connect, when the port is open, and that every
//! refusal is final. Real services on loopback ports, talking through the real encrypted
//! connection.

use super::channel::Channel;
use super::identity::Identity;
use super::service::{ping, should_listen, EventKind, Service};
use super::SyncError;
use std::fs;
use std::io::{Read, Write};
use std::net::TcpStream;
use std::path::PathBuf;
use std::thread;
use std::time::{Duration, Instant};

struct Dir(PathBuf);

impl Dir {
    fn new(label: &str) -> Dir {
        let path = std::env::temp_dir().join(format!("sn-service-{label}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&path);
        fs::create_dir_all(&path).expect("make test dir");
        Dir(path)
    }
}

impl Drop for Dir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn device(dir: &Dir, name: &str) -> Service {
    Service::with_bind(&dir.0, Identity::generate().expect("identity"), name, true, "127.0.0.1", 0).expect("service")
}

fn address(service: &Service) -> String {
    format!("127.0.0.1:{}", service.status().listening_port.expect("listening"))
}

fn port_is_open(port: u16) -> bool {
    TcpStream::connect_timeout(&format!("127.0.0.1:{port}").parse().expect("address"), Duration::from_millis(300)).is_ok()
}

/// Waits until `check` is true (the listener thread notices changes within a fraction of a second).
fn wait_for(check: impl Fn() -> bool) -> bool {
    for _ in 0..60 {
        if check() {
            return true;
        }
        thread::sleep(Duration::from_millis(50));
    }
    false
}

fn pair(host: &Service, joiner: &Service) {
    let code = host.start_pairing().expect("code");
    joiner.join(&address(host), &code).expect("pair");
}

#[test]
fn the_rules_for_listening() {
    assert!(!should_listen(true, 0, false), "nobody paired and no pairing screen: silent");
    assert!(should_listen(true, 0, true));
    assert!(should_listen(true, 1, false));
    assert!(!should_listen(false, 3, true), "switched off beats everything");
}

#[test]
fn a_fresh_device_is_silent_and_pairing_opens_then_closes_the_port() {
    let dir = Dir::new("silent");
    let alice = device(&dir, "alice");
    assert_eq!(alice.status().listening_port, None, "nothing is open on the network");
    let code = alice.start_pairing().expect("code");
    assert_eq!(code.len(), 8);
    let port = alice.status().listening_port.expect("listening while pairing");
    assert!(port_is_open(port));
    assert!(alice.status().pairing_seconds_left.is_some_and(|s| s > 100));
    alice.stop_pairing().expect("close");
    assert_eq!(alice.status().listening_port, None);
    assert!(!port_is_open(port), "the port is really closed again");
    assert_eq!(alice.status().pairing_seconds_left, None);
}

#[test]
fn with_sync_off_nothing_listens_and_no_code_can_be_made() {
    let dir = Dir::new("off");
    let alice = device(&dir, "alice");
    alice.set_enabled(false).expect("off");
    assert!(matches!(alice.start_pairing(), Err(SyncError::Refused(_))));
    assert_eq!(alice.status().listening_port, None);
    // Turning sync off while a code is open closes the port and kills the code.
    alice.set_enabled(true).expect("on");
    alice.start_pairing().expect("code");
    let port = alice.status().listening_port.expect("port");
    alice.set_enabled(false).expect("off");
    assert!(wait_for(|| !port_is_open(port)));
    assert_eq!(alice.status().pairing_seconds_left, None);
}

#[test]
fn the_right_code_pairs_both_ways_and_it_is_remembered_across_restarts() {
    let (dir_a, dir_b) = (Dir::new("pair-a"), Dir::new("pair-b"));
    let alice = device(&dir_a, "alice-laptop");
    let bob = device(&dir_b, "bob-phone");
    pair(&alice, &bob);
    let (a, b) = (alice.status(), bob.status());
    assert_eq!(a.peers.len(), 1);
    assert_eq!(a.peers[0].name, "bob-phone");
    assert_eq!(b.peers[0].name, "alice-laptop");
    assert_eq!(a.peers[0].fingerprint, b.fingerprint);
    assert_eq!(b.peers[0].fingerprint, a.fingerprint);
    assert_eq!(a.pairing_seconds_left, None, "the code is used up");
    assert!(a.events.iter().any(|e| e.kind == EventKind::Paired && e.name == "bob-phone"), "pairing is shown in the activity list");
    assert!(b.events.iter().any(|e| e.kind == EventKind::Paired && e.name == "alice-laptop"));
    // Once a device is paired it keeps listening (so the other can reach it) even with the pairing screen closed.
    assert!(alice.status().listening_port.is_some());
    // The list is on disk and a restart starts listening at once.
    let restarted = Service::with_bind(&dir_a.0, Identity::generate().expect("identity"), "alice-laptop", true, "127.0.0.1", 0).expect("restart");
    assert_eq!(restarted.status().peers.len(), 1);
    assert!(restarted.status().listening_port.is_some());
}

#[test]
fn a_wrong_code_pairs_nothing_and_three_wrong_tries_kill_even_the_right_code() {
    let (dir_a, dir_b) = (Dir::new("wrong-a"), Dir::new("wrong-b"));
    let alice = device(&dir_a, "alice");
    let bob = device(&dir_b, "bob");
    let code = alice.start_pairing().expect("code");
    let target = address(&alice);
    let wrong = if code == "00000000" { "11111111" } else { "00000000" };
    for _ in 0..2 {
        assert!(bob.join(&target, wrong).is_err());
    }
    assert!(alice.status().peers.is_empty() && bob.status().peers.is_empty());
    assert!(alice.status().events.iter().filter(|e| e.kind == EventKind::Refused).count() >= 2, "wrong tries are shown");
    // The third wrong try uses the last attempt, so the right code is dead too.
    assert!(bob.join(&target, wrong).is_err());
    assert!(wait_for(|| alice.status().listening_port.is_none() || bob.join(&target, &code).is_err()));
    assert!(bob.join(&target, &code).is_err(), "three attempts are all a code gets");
    assert!(alice.status().peers.is_empty());
}

#[test]
fn an_old_code_does_not_work_and_the_port_closes_by_itself() {
    let (dir_a, dir_b) = (Dir::new("old-a"), Dir::new("old-b"));
    let alice = device(&dir_a, "alice");
    let bob = device(&dir_b, "bob");
    alice.set_code_lifetime(Duration::from_millis(400));
    let code = alice.start_pairing().expect("code");
    let target = address(&alice);
    let port = alice.status().listening_port.expect("port");
    thread::sleep(Duration::from_millis(600));
    assert!(bob.join(&target, &code).is_err());
    assert!(wait_for(|| !port_is_open(port)), "nobody asked it to stop, it stopped");
    assert!(alice.status().peers.is_empty());
}

#[test]
fn a_copied_code_cannot_pair_a_second_device() {
    let (dir_a, dir_b, dir_c) = (Dir::new("copy-a"), Dir::new("copy-b"), Dir::new("copy-c"));
    let (alice, bob, carol) = (device(&dir_a, "alice"), device(&dir_b, "bob"), device(&dir_c, "carol"));
    let code = alice.start_pairing().expect("code");
    let target = address(&alice);
    bob.join(&target, &code).expect("bob pairs");
    assert!(carol.join(&target, &code).is_err(), "the same code does nothing a second time");
    assert_eq!(alice.status().peers.len(), 1);
    assert!(carol.status().peers.is_empty());
}

#[test]
fn only_a_paired_device_gets_an_answer_and_an_unpaired_one_is_turned_away_and_noted() {
    let (dir_a, dir_b, dir_c) = (Dir::new("ping-a"), Dir::new("ping-b"), Dir::new("ping-c"));
    let (alice, bob, carol) = (device(&dir_a, "alice"), device(&dir_b, "bob"), device(&dir_c, "carol"));
    pair(&alice, &bob);
    let target = address(&alice);
    assert_eq!(ping(&bob, &target).expect("paired ping"), "alice");
    let refused_before = alice.status().events.iter().filter(|e| e.kind == EventKind::Refused).count();
    assert!(ping(&carol, &target).is_err(), "carol is not paired");
    assert!(wait_for(|| alice.status().events.iter().filter(|e| e.kind == EventKind::Refused).count() > refused_before), "the refusal is shown");
}

#[test]
fn removing_a_device_ends_its_access_and_the_silence_returns() {
    let (dir_a, dir_b) = (Dir::new("remove-a"), Dir::new("remove-b"));
    let (alice, bob) = (device(&dir_a, "alice"), device(&dir_b, "bob"));
    pair(&alice, &bob);
    let target = address(&alice);
    let port = alice.status().listening_port.expect("port");
    let id = alice.status().peers[0].id.clone();
    assert!(alice.remove_peer(&id).expect("remove"));
    assert!(!alice.remove_peer(&id).expect("remove again"));
    assert!(ping(&bob, &target).is_err(), "bob is not trusted any more");
    assert!(alice.status().events.iter().any(|e| e.kind == EventKind::Removed && e.name == "bob"));
    assert!(wait_for(|| !port_is_open(port)), "nobody paired and no pairing screen: the port is closed");
    assert!(matches!(alice.remove_peer("not-a-key"), Err(SyncError::Refused(_))));
}

#[test]
fn junk_connections_do_not_hurt_and_the_limit_on_connections_holds() {
    let (dir_a, dir_b) = (Dir::new("junk-a"), Dir::new("junk-b"));
    let (alice, bob) = (device(&dir_a, "alice"), device(&dir_b, "bob"));
    let code = alice.start_pairing().expect("code");
    let port = alice.status().listening_port.expect("port");
    for junk in [&b"GET / HTTP/1.1\r\n\r\n"[..], &[0xFF; 100][..], &[][..]] {
        let mut stream = TcpStream::connect(("127.0.0.1", port)).expect("connect");
        let _ = stream.write_all(junk);
        let mut sink = [0u8; 16];
        let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
        let _ = stream.read(&mut sink);
    }
    // Eight connections that say nothing fill the limit; a ninth is dropped at once.
    let idle: Vec<TcpStream> = (0..8).map(|_| TcpStream::connect(("127.0.0.1", port)).expect("connect")).collect();
    thread::sleep(Duration::from_millis(300));
    let started = Instant::now();
    let ninth = TcpStream::connect(("127.0.0.1", port)).expect("connect");
    ninth.set_read_timeout(Some(Duration::from_secs(2))).expect("timeout");
    assert!(Channel::connect(ninth, &Identity::generate().expect("identity")).is_err());
    assert!(started.elapsed() < Duration::from_secs(5));
    drop(idle);
    // The junk cost no attempts of the code, and pairing still works afterwards.
    assert!(wait_for(|| bob.join(&format!("127.0.0.1:{port}"), &code).is_ok()));
}

#[test]
fn no_private_key_is_ever_written_to_the_trust_file_or_the_activity_list() {
    let (dir_a, dir_b) = (Dir::new("keys-a"), Dir::new("keys-b"));
    let (alice, bob) = (device(&dir_a, "alice"), device(&dir_b, "bob"));
    pair(&alice, &bob);
    for (service, dir) in [(&alice, &dir_a), (&bob, &dir_b)] {
        let private = service.private_key_hex();
        for entry in fs::read_dir(&dir.0).expect("read dir") {
            let text = fs::read_to_string(entry.expect("entry").path()).unwrap_or_default();
            assert!(!text.contains(&private), "the private key is in a file");
        }
        assert!(!format!("{:?}", service.status()).contains(&private));
    }
}

#[test]
fn a_bad_address_or_code_fails_calmly() {
    let dir = Dir::new("bad-input");
    let bob = device(&dir, "bob");
    assert!(bob.join("127.0.0.1:9", "12345678").is_err(), "nothing listening there");
    assert!(bob.join("", "12345678").is_err());
    assert!(bob.join("no such host.invalid:1", "12345678").is_err());
    assert!(matches!(bob.join("127.0.0.1:9", "123"), Err(SyncError::Refused(_))));
    assert!(matches!(bob.join("127.0.0.1:9", "1234567a"), Err(SyncError::Refused(_))));
}

// ---- the manager ----

use super::identity::FileSecretStore;
use super::manager::Manager;

#[test]
fn the_manager_follows_the_switch_and_survives_broken_keys() {
    let dir = Dir::new("manager");
    let store = FileSecretStore::new(dir.0.join("keys").join("device.key"));
    let manager = Manager::start(&dir.0, &store);
    assert!(manager.problem().is_none() && manager.service().is_some());
    assert!(manager.settings().expect("settings").enabled, "on by default");
    assert_eq!(manager.service().expect("service").status().listening_port, None, "and silent until a device is paired");
    manager.update(Some("Alice laptop"), Some(false)).expect("update");
    assert_eq!(manager.settings().expect("settings").name, "Alice-laptop");
    assert!(manager.service().expect("service").start_pairing().is_err(), "off means no pairing");
    // A damaged key file: sync is unavailable with a reason, nothing panics, the file is kept.
    let broken = Dir::new("manager-broken");
    let path = broken.0.join("device.key");
    fs::write(&path, b"damaged").expect("write");
    let manager = Manager::start(&broken.0, &FileSecretStore::new(path.clone()));
    assert_eq!(manager.problem(), Some("keys"));
    assert!(manager.service().is_none());
    assert_eq!(fs::read(&path).expect("read"), b"damaged");
    assert!(manager.update(Some("x"), None).is_ok(), "the name and switch can still be saved");
}

#[test]
fn the_address_hint_never_panics_and_is_never_loopback() {
    if let Some(hint) = super::service::local_address_hint() {
        assert!(!hint.starts_with("127.") && hint != "0.0.0.0" && hint != "::1");
    }
}

#[test]
fn errors_have_codes_the_interface_can_turn_into_sentences() {
    let dir = Dir::new("codes");
    let bob = device(&dir, "bob");
    assert_eq!(bob.join("127.0.0.1:9", "12").expect_err("bad code").code(), "pair_bad_code");
    assert_eq!(bob.join("127.0.0.1:9", "12345678").expect_err("nobody there").code(), "sync_unreachable");
    bob.set_enabled(false).expect("off");
    assert_eq!(bob.start_pairing().expect_err("off").code(), "sync_off");
    assert_eq!(SyncError::Refused("anything else").code(), "pair_refused");
    assert_eq!(SyncError::Channel("x").code(), "pair_failed");
}
