//! Tests for finding devices: the notes themselves (strictly read), and two real services on
//! the loopback address announcing and finding each other. No packet leaves the computer.

use super::discovery::{find, parse, Announcer, Route};
use super::identity::Identity;
use super::service::Service;
use super::SyncError;
use std::fs;
use std::net::{IpAddr, Ipv4Addr, SocketAddr, UdpSocket};
use std::path::PathBuf;
use std::time::Duration;

const LAN: IpAddr = IpAddr::V4(Ipv4Addr::new(192, 168, 1, 20));

fn note(key_hex: &str, name: &str, port: &str) -> Vec<u8> {
    format!("SNDISC1\n{key_hex}\n{name}\n{port}").into_bytes()
}

fn key_hex() -> String {
    "ab".repeat(32)
}

#[test]
fn a_good_note_is_read_and_the_address_comes_from_where_it_was_sent() {
    let found = parse(&note(&key_hex(), "alice-phone", "47821"), LAN).expect("note");
    assert_eq!(found.name, "alice-phone");
    assert_eq!(found.address, "192.168.1.20:47821");
    assert_eq!(found.key, [0xab; 32]);
}

#[test]
fn anything_that_is_not_exactly_a_note_is_ignored() {
    let good = key_hex();
    let bad: Vec<Vec<u8>> = vec![
        b"".to_vec(),
        b"hello".to_vec(),
        note(&good, "alice", "0"),
        note(&good, "alice", "70000"),
        note(&good, "alice", "47821 "),
        note(&good, "", "47821"),
        note(&good, "al ice", "47821"),
        note(&good, "al\u{1b}ice", "47821"),
        note(&"zz".repeat(32), "alice", "47821"),
        note(&"ab".repeat(31), "alice", "47821"),
        note(&good.to_uppercase(), "alice", "47821"),
        b"SNDISC2\nx\ny\n1".to_vec(),
        [note(&good, "alice", "47821"), b"\nextra".to_vec()].concat(),
        vec![0xff, 0xfe, 0x00],
        vec![b'a'; 5000],
    ];
    for (i, bytes) in bad.iter().enumerate() {
        assert!(parse(bytes, LAN).is_none(), "note {i} should be ignored");
    }
}

#[test]
fn notes_from_impossible_senders_are_ignored() {
    let good = note(&key_hex(), "alice", "47821");
    assert!(parse(&good, IpAddr::V4(Ipv4Addr::UNSPECIFIED)).is_none());
    assert!(parse(&good, IpAddr::V4(Ipv4Addr::BROADCAST)).is_none());
    assert!(parse(&good, IpAddr::V4(Ipv4Addr::new(239, 255, 42, 99))).is_none());
}

fn free_port() -> u16 {
    let socket = UdpSocket::bind("127.0.0.1:0").expect("bind");
    socket.local_addr().expect("addr").port()
}

fn loopback_route(port: u16) -> Route {
    Route { listen: SocketAddr::from(([127, 0, 0, 1], port)), join_group: false, send_to: vec![SocketAddr::from(([127, 0, 0, 1], port))], interval: Duration::from_millis(80) }
}

#[test]
fn an_announcer_is_heard_once_and_the_listener_leaves_out_itself() {
    let port = free_port();
    let route = loopback_route(port);
    let key = [7u8; 32];
    let mut announcer = Announcer::start(route.clone(), key, "alice-laptop".to_string(), 47821, || true).expect("start");
    let heard = find(&route, Duration::from_millis(600), &[1u8; 32]).expect("find");
    assert_eq!(heard.len(), 1, "several notes from one device are one device");
    assert_eq!(heard[0].name, "alice-laptop");
    assert_eq!(heard[0].address, "127.0.0.1:47821");
    let own = find(&route, Duration::from_millis(400), &key).expect("find");
    assert!(own.is_empty(), "a device does not list itself");
    announcer.stop();
}

#[test]
fn an_announcer_stops_when_told_to_and_when_keep_says_no() {
    let port = free_port();
    let route = loopback_route(port);
    let mut stopped = Announcer::start(route.clone(), [1u8; 32], "bob".to_string(), 1000, || true).expect("start");
    stopped.stop();
    assert!(stopped.is_finished());
    assert!(find(&route, Duration::from_millis(400), &[9u8; 32]).expect("find").is_empty(), "nothing is sent after stop");
    let flag = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(true));
    let seen = flag.clone();
    let ended = Announcer::start(route, [2u8; 32], "bob".to_string(), 1000, move || seen.load(std::sync::atomic::Ordering::SeqCst)).expect("start");
    flag.store(false, std::sync::atomic::Ordering::SeqCst);
    std::thread::sleep(Duration::from_millis(300));
    assert!(ended.is_finished());
}

#[test]
fn a_flood_of_bad_and_many_notes_is_bounded() {
    let port = free_port();
    let route = loopback_route(port);
    let sender = UdpSocket::bind("127.0.0.1:0").expect("bind");
    let target = SocketAddr::from(([127, 0, 0, 1], port));
    let listener = std::thread::spawn({
        let route = route.clone();
        move || find(&route, Duration::from_millis(1800), &[0u8; 32]).expect("find")
    });
    std::thread::sleep(Duration::from_millis(150));
    for i in 0..40u8 {
        let key = format!("{i:02x}").repeat(32);
        sender.send_to(&note(&key, "peer", &format!("{}", 2000 + i as u16)), target).expect("send");
        sender.send_to(b"garbage", target).expect("send");
        if i % 10 == 0 {
            sender.send_to(&vec![b'x'; 60_000], target).ok();
        }
        // A little pause: a real network does not deliver a thousand packets in one instant, and
        // Windows drops what does not fit in the socket's small receive buffer.
        std::thread::sleep(Duration::from_millis(8));
    }
    assert_eq!(listener.join().expect("thread").len(), 16, "at most 16 devices are kept");
}

struct Dir(PathBuf);

impl Dir {
    fn new(label: &str) -> Dir {
        let path = std::env::temp_dir().join(format!("sn-disc-{label}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&path);
        fs::create_dir_all(&path).expect("dir");
        Dir(path)
    }
}

impl Drop for Dir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn device(dir: &Dir, name: &str, route: &Route) -> Service {
    let service = Service::with_bind(&dir.0, Identity::generate().expect("identity"), name, true, "127.0.0.1", 0).expect("service");
    service.set_route(route.clone());
    service
}

#[test]
fn a_device_is_found_only_while_its_pairing_code_shows_and_the_address_pairs() {
    let (dir_a, dir_b) = (Dir::new("a"), Dir::new("b"));
    let route = loopback_route(free_port());
    let alice = device(&dir_a, "alice-laptop", &route);
    let bob = device(&dir_b, "bob-phone", &route);

    // Nothing shown yet: silent.
    assert!(bob.find_nearby(Duration::from_millis(500)).expect("find").is_empty());

    let code = alice.start_pairing().expect("pairing");
    let heard = bob.find_nearby(Duration::from_millis(900)).expect("find");
    assert_eq!(heard.len(), 1);
    assert_eq!(heard[0].name, "alice-laptop");
    assert!(!heard[0].paired);
    let port = alice.status().listening_port.expect("port");
    assert_eq!(heard[0].address, format!("127.0.0.1:{port}"));
    assert!(alice.find_nearby(Duration::from_millis(300)).expect("find").is_empty(), "alice does not find herself");

    // The found address is the one that pairs.
    bob.join(&heard[0].address, &code).expect("join");
    let after = bob.find_nearby(Duration::from_millis(500)).expect("find");
    assert!(after.iter().all(|d| d.paired), "a paired device is marked as paired");

    // Since 0.5.3 a device that has a paired device keeps announcing (so its pair finds it
    // again when its address changes). Closing the pairing screen alone does not end that.
    alice.stop_pairing().expect("stop");
    std::thread::sleep(Duration::from_millis(250));
    assert_eq!(bob.find_nearby(Duration::from_millis(600)).expect("find").len(), 1, "a paired device is still announced");
    // Pausing sync ends the announcement at once.
    alice.set_paused(true).expect("pause");
    std::thread::sleep(Duration::from_millis(250));
    assert!(bob.find_nearby(Duration::from_millis(500)).expect("find").is_empty(), "a paused device is silent");
    alice.set_paused(false).expect("resume");
    // Removing the last paired device ends it for good (no code showing, nobody paired).
    let id = alice.status().peers[0].id.clone();
    alice.remove_peer(&id).expect("remove");
    std::thread::sleep(Duration::from_millis(250));
    assert!(bob.find_nearby(Duration::from_millis(500)).expect("find").is_empty(), "nobody paired and no code: silent");
}

#[test]
fn an_expired_code_stops_the_announcement_and_sync_off_refuses_to_look() {
    let (dir_a, dir_b) = (Dir::new("c"), Dir::new("d"));
    let route = loopback_route(free_port());
    let alice = device(&dir_a, "alice-laptop", &route);
    let bob = device(&dir_b, "bob-phone", &route);
    alice.set_code_lifetime(Duration::from_millis(300));
    alice.start_pairing().expect("pairing");
    std::thread::sleep(Duration::from_millis(700));
    assert!(bob.find_nearby(Duration::from_millis(400)).expect("find").is_empty(), "an expired code is not announced");
    bob.set_enabled(false).expect("off");
    assert!(matches!(bob.find_nearby(Duration::from_millis(100)), Err(SyncError::Refused(_))));
}
