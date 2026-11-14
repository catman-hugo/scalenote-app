//! Tests for identity, trust list, the encrypted connection and pairing. Real keys, real
//! loopback connections between threads, and the real functions (no copies of the logic).

use super::channel::{Channel, MAX_MESSAGE};
use super::identity::{self, FileSecretStore, Identity, SecretStore};
use super::pairing::{self, clean_code, new_code, CodeBook, CODE_DIGITS, CODE_LIFETIME, MAX_ATTEMPTS};
use super::trust::{TrustList, MAX_PEERS};
use super::{hex, SyncError};
use std::fs;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::PathBuf;
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant};

struct Dir(PathBuf);

impl Dir {
    fn new(label: &str) -> Dir {
        let path = std::env::temp_dir().join(format!("sn-pair-{label}-{}", std::process::id()));
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

fn limits(stream: &TcpStream) {
    stream.set_read_timeout(Some(Duration::from_secs(10))).expect("timeout");
    stream.set_write_timeout(Some(Duration::from_secs(10))).expect("timeout");
}

/// Two connected ends: (joiner side, host side).
fn tcp_pair() -> (TcpStream, TcpStream) {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
    let address = listener.local_addr().expect("address");
    let client = TcpStream::connect(address).expect("connect");
    let (server, _) = listener.accept().expect("accept");
    limits(&client);
    limits(&server);
    (client, server)
}

fn secure_pair(a: &Identity, b: &Identity) -> (Channel<TcpStream>, Channel<TcpStream>) {
    let (client, server) = tcp_pair();
    thread::scope(|scope| {
        let host = scope.spawn(|| Channel::accept(server, b).expect("accept"));
        let joiner = Channel::connect(client, a).expect("connect");
        (joiner, host.join().expect("thread"))
    })
}

// ---- identity ----

#[test]
fn identities_are_different_and_stay_the_same_once_kept() {
    let dir = Dir::new("identity");
    let store = FileSecretStore::new(dir.0.join("keys").join("device.key"));
    let first = identity::load_or_create(&store).expect("create");
    let again = identity::load_or_create(&store).expect("load");
    assert_eq!(first.public(), again.public());
    let other = Identity::generate().expect("generate");
    assert_ne!(first.public(), other.public());
}

#[cfg(unix)]
#[test]
fn the_key_file_is_private_to_the_user() {
    use std::os::unix::fs::PermissionsExt;
    let dir = Dir::new("private");
    let path = dir.0.join("device.key");
    identity::load_or_create(&FileSecretStore::new(path.clone())).expect("create");
    assert_eq!(fs::metadata(&path).expect("meta").permissions().mode() & 0o777, 0o600);
    assert!(!dir.0.join("device.key.sn-tmp").exists(), "no temporary copy is left");
}

#[test]
fn a_damaged_key_is_reported_and_never_replaced() {
    let dir = Dir::new("damaged");
    let path = dir.0.join("device.key");
    fs::write(&path, b"not a key").expect("write");
    let store = FileSecretStore::new(path.clone());
    assert!(matches!(identity::load_or_create(&store), Err(SyncError::Damaged(_))));
    assert_eq!(fs::read(&path).expect("read"), b"not a key", "the file was left alone");
    fs::write(&path, vec![0u8; 5000]).expect("write");
    assert!(store.load().is_err(), "a big file is not read");
}

#[test]
fn the_private_key_never_shows_in_debug_output_or_the_fingerprint() {
    let identity = Identity::generate().expect("generate");
    let shown = format!("{identity:?}");
    let private = hex::encode(identity.private());
    assert!(!shown.contains(&private));
    let fingerprint = identity::fingerprint(identity.public());
    assert_eq!(fingerprint.split(' ').count(), 5);
    assert!(fingerprint.split(' ').all(|g| g.len() == 4));
    assert!(!fingerprint.replace(' ', "").contains(&private[..8]));
}

// ---- trust list ----

#[test]
fn trust_list_round_trips_and_cleans_names() {
    let (a, b) = (Identity::generate().expect("a"), Identity::generate().expect("b"));
    let mut list = TrustList::default();
    list.add("Bob's Laptop / 2", *a.public(), "2026-11-14").expect("add");
    list.add("alice phone", *b.public(), "2026-11-15").expect("add");
    assert_eq!(list.peers()[0].name, "Bobs-Laptop-2");
    let read = TrustList::from_text(&list.to_text()).expect("read back");
    assert_eq!(read, list);
    assert!(read.contains(a.public()) && read.contains(b.public()));
}

#[test]
fn the_same_key_with_a_new_name_is_renamed_not_added_twice() {
    let a = Identity::generate().expect("a");
    let mut list = TrustList::default();
    list.add("one", *a.public(), "2026-11-14").expect("add");
    list.add("two", *a.public(), "2026-11-15").expect("rename");
    assert_eq!(list.peers().len(), 1);
    assert_eq!(list.peers()[0].name, "two");
    assert_eq!(list.peers()[0].added, "2026-11-14", "the pairing day stays");
}

#[test]
fn removing_a_device_removes_trust_and_only_that_one() {
    let (a, b) = (Identity::generate().expect("a"), Identity::generate().expect("b"));
    let mut list = TrustList::default();
    list.add("a", *a.public(), "2026-11-14").expect("add");
    list.add("b", *b.public(), "2026-11-14").expect("add");
    assert!(list.remove(a.public()));
    assert!(!list.remove(a.public()), "second time there is nothing to remove");
    assert!(!list.contains(a.public()) && list.contains(b.public()));
}

#[test]
fn trust_list_refuses_bad_files_and_keeps_its_size_limit() {
    let key = hex::encode(&[0xabu8; 32]);
    assert!(TrustList::from_text("").is_err());
    assert!(TrustList::from_text("scalenote-trust 2\n").is_err());
    assert!(TrustList::from_text(&format!("scalenote-trust 1\n{key} 2026-11-14\n")).is_err(), "no name");
    assert!(TrustList::from_text("scalenote-trust 1\nzz 2026-11-14 bob\n").is_err(), "bad key");
    assert!(TrustList::from_text(&format!("scalenote-trust 1\n{} 2026-11-14 bob\n", key.to_uppercase())).is_err(), "upper case key");
    assert!(TrustList::from_text(&format!("scalenote-trust 1\n{key} 2026-11-14 bob\n{key} 2026-11-14 bob\n")).is_err(), "same key twice");
    assert!(TrustList::from_text(&format!("scalenote-trust 1\n{key} 2026-11-14 {}\n", "x".repeat(41))).is_err(), "name too long");
    let mut list = TrustList::default();
    for i in 0..MAX_PEERS {
        list.add("p", [i as u8; 32], "2026-11-14").expect("add");
    }
    assert!(list.add("one too many", [200u8; 32], "2026-11-14").is_err());
}

#[test]
fn a_damaged_trust_file_is_an_error_not_an_empty_list() {
    let dir = Dir::new("trust-file");
    let path = dir.0.join("sync-peers.txt");
    assert!(TrustList::load(&path).expect("missing is empty").is_empty());
    let a = Identity::generate().expect("a");
    let mut list = TrustList::default();
    list.add("a", *a.public(), "2026-11-14").expect("add");
    list.save(&path).expect("save");
    assert_eq!(TrustList::load(&path).expect("load"), list);
    fs::write(&path, "garbage").expect("write");
    assert!(TrustList::load(&path).is_err());
    assert_eq!(fs::read_to_string(&path).expect("read"), "garbage", "loading never rewrites");
}

// ---- the encrypted connection ----

#[test]
fn both_sides_learn_each_others_key_and_can_talk() {
    let (a, b) = (Identity::generate().expect("a"), Identity::generate().expect("b"));
    let (mut joiner, mut host) = secure_pair(&a, &b);
    assert_eq!(joiner.remote(), b.public());
    assert_eq!(host.remote(), a.public());
    joiner.send(b"hello").expect("send");
    assert_eq!(host.recv().expect("recv"), b"hello");
    host.send(&vec![9u8; MAX_MESSAGE]).expect("send big");
    assert_eq!(joiner.recv().expect("recv").len(), MAX_MESSAGE);
    assert!(joiner.send(&vec![0u8; MAX_MESSAGE + 1]).is_err(), "one message is limited");
}

#[test]
fn what_is_sent_is_not_readable_on_the_wire() {
    // A recording stream: everything one side writes is also kept, so the test can look at it.
    struct Tap(TcpStream, std::sync::Arc<std::sync::Mutex<Vec<u8>>>);
    impl Read for Tap {
        fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
            self.0.read(buf)
        }
    }
    impl Write for Tap {
        fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
            self.1.lock().expect("lock").extend_from_slice(buf);
            self.0.write(buf)
        }
        fn flush(&mut self) -> std::io::Result<()> {
            self.0.flush()
        }
    }
    let (a, b) = (Identity::generate().expect("a"), Identity::generate().expect("b"));
    let (client, server) = tcp_pair();
    let log = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
    let tapped = Tap(client, log.clone());
    thread::scope(|scope| {
        let host = scope.spawn(|| {
            let mut channel = Channel::accept(server, &b).expect("accept");
            channel.recv().expect("recv")
        });
        let mut joiner = Channel::connect(tapped, &a).expect("connect");
        joiner.send(b"a secret page title that must not be visible").expect("send");
        assert_eq!(host.join().expect("thread"), b"a secret page title that must not be visible");
    });
    let seen = log.lock().expect("lock").clone();
    assert!(!seen.windows(8).any(|w| w == b"a secret"), "the text is encrypted on the wire");
}

#[test]
fn junk_and_oversize_handshakes_end_the_connection_quietly() {
    let b = Identity::generate().expect("b");
    for junk in [vec![0u8, 3, 1, 2, 3], vec![0xFF, 0xFF], vec![], vec![0, 40, 1]] {
        let (mut client, server) = tcp_pair();
        client.write_all(&junk).expect("write");
        drop(client);
        assert!(Channel::accept(server, &b).is_err());
    }
    // A big frame is refused from its length alone, before any of it is read.
    let (mut client, server) = tcp_pair();
    client.write_all(&[0x10, 0x00]).expect("write");
    assert!(matches!(Channel::accept(server, &b), Err(SyncError::Channel(_))));
}

#[test]
fn a_changed_byte_in_a_message_is_detected() {
    // The relay flips one bit of the first real message and passes everything else through.
    let (a, b) = (Identity::generate().expect("a"), Identity::generate().expect("b"));
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
    let relay_address = listener.local_addr().expect("addr");
    let host_listener = TcpListener::bind("127.0.0.1:0").expect("bind");
    let host_address = host_listener.local_addr().expect("addr");
    thread::scope(|scope| {
        let host = scope.spawn(|| {
            let (stream, _) = host_listener.accept().expect("accept");
            limits(&stream);
            let mut channel = Channel::accept(stream, &b).expect("accept");
            channel.recv()
        });
        scope.spawn(|| {
            let (mut from_joiner, _) = listener.accept().expect("accept");
            let mut to_host = TcpStream::connect(host_address).expect("connect");
            limits(&from_joiner);
            limits(&to_host);
            // Three handshake frames (joiner, host, joiner), then one data frame.
            let frame = |from: &mut TcpStream, to: &mut TcpStream, flip: bool| {
                let mut length = [0u8; 2];
                from.read_exact(&mut length).expect("length");
                let mut body = vec![0u8; u16::from_be_bytes(length) as usize];
                from.read_exact(&mut body).expect("body");
                if flip {
                    let last = body.len() - 1;
                    body[last] ^= 1;
                }
                to.write_all(&length).expect("write");
                to.write_all(&body).expect("write");
            };
            frame(&mut from_joiner, &mut to_host, false);
            frame(&mut to_host, &mut from_joiner, false);
            frame(&mut from_joiner, &mut to_host, false);
            frame(&mut from_joiner, &mut to_host, true);
        });
        let client = TcpStream::connect(relay_address).expect("connect");
        limits(&client);
        let mut joiner = Channel::connect(client, &a).expect("connect");
        joiner.send(b"hello").expect("send");
        assert!(host.join().expect("thread").is_err(), "a changed message is refused");
    });
}

// ---- codes ----

#[test]
fn codes_are_eight_digits_and_typed_codes_are_cleaned() {
    for _ in 0..50 {
        let code = new_code().expect("code");
        assert_eq!(code.len(), CODE_DIGITS);
        assert!(code.bytes().all(|b| b.is_ascii_digit()));
    }
    assert_eq!(clean_code("1234 5678").as_deref(), Some("12345678"));
    assert_eq!(clean_code(" 1234-5678 ").as_deref(), Some("12345678"));
    for bad in ["", "1234567", "123456789", "1234 567a", "١٢٣٤٥٦٧٨", "1234.5678", "12345678\n9"] {
        assert!(clean_code(bad).is_none(), "{bad:?}");
    }
}

#[test]
fn a_code_dies_after_three_attempts_two_minutes_or_closing() {
    let start = Instant::now();
    let mut book = CodeBook::default();
    assert!(!book.is_open(start) && book.take_attempt(start).is_none());
    let code = book.open(start).expect("open");
    assert!(book.is_open(start));
    for _ in 0..MAX_ATTEMPTS {
        assert_eq!(book.take_attempt(start).as_deref(), Some(code.as_str()));
    }
    assert!(!book.is_open(start) && book.take_attempt(start).is_none(), "three attempts are all there are");
    book.open(start).expect("open");
    let late = start + CODE_LIFETIME;
    assert!(!book.is_open(late) && book.take_attempt(late).is_none(), "an old code is dead");
    book.open(start).expect("open");
    book.close();
    assert!(book.take_attempt(start).is_none());
    // A new code replaces the old one, which no longer works.
    let first = book.open(start).expect("open");
    let second = book.open(start).expect("open");
    assert_eq!(book.take_attempt(start).as_deref(), Some(second.as_str()));
    let _ = first;
}

// ---- pairing ----

fn run_pairing(host_code: Option<&str>, typed: &str) -> (Result<super::trust::Peer, SyncError>, Result<super::trust::Peer, SyncError>, Identity, Identity) {
    let (joiner_id, host_id) = (Identity::generate().expect("joiner"), Identity::generate().expect("host"));
    let (mut joiner, mut host) = secure_pair(&joiner_id, &host_id);
    let (joined, hosted) = thread::scope(|scope| {
        let hosting = scope.spawn(|| pairing::host(&mut host, host_code, "alice-laptop", "2026-11-14"));
        let joined = pairing::join(&mut joiner, typed, "bob-phone", "2026-11-14");
        (joined, hosting.join().expect("thread"))
    });
    (joined, hosted, joiner_id, host_id)
}

#[test]
fn the_right_code_pairs_both_devices_with_each_others_keys_and_names() {
    let (joined, hosted, joiner_id, host_id) = run_pairing(Some("12345678"), "12345678");
    let host_seen_by_joiner = joined.expect("joiner is paired");
    let joiner_seen_by_host = hosted.expect("host is paired");
    assert_eq!(&host_seen_by_joiner.public, host_id.public());
    assert_eq!(host_seen_by_joiner.name, "alice-laptop");
    assert_eq!(&joiner_seen_by_host.public, joiner_id.public());
    assert_eq!(joiner_seen_by_host.name, "bob-phone");
}

#[test]
fn a_wrong_code_pairs_nothing_on_either_side() {
    let (joined, hosted, _, _) = run_pairing(Some("12345678"), "12345679");
    assert!(matches!(joined, Err(SyncError::Refused(_))), "{joined:?}");
    assert!(matches!(hosted, Err(SyncError::Refused(_))), "{hosted:?}");
}

#[test]
fn a_host_without_an_open_code_refuses_everything() {
    let (joined, hosted, _, _) = run_pairing(None, "12345678");
    assert!(joined.is_err() && hosted.is_err());
}

#[test]
fn a_copied_code_cannot_be_used_twice() {
    // The service closes the code after a success (checked in the service tests); here the same
    // holds on the code book: once used up there is no code to check against.
    let mut book = CodeBook::default();
    let now = Instant::now();
    let code = book.open(now).expect("open");
    let (joined, hosted, _, _) = run_pairing(book.take_attempt(now).as_deref(), &code);
    assert!(joined.is_ok() && hosted.is_ok());
    book.close();
    let (joined, hosted, _, _) = run_pairing(book.take_attempt(now).as_deref(), &code);
    assert!(joined.is_err() && hosted.is_err());
}

#[test]
fn a_device_in_the_middle_that_relays_everything_is_not_paired_even_with_the_right_code_flow() {
    // The relay passes the pairing messages on untouched, so both ends do the code exchange
    // correctly. But each side sees a different device key at the other end (the relay's), so
    // the confirmation tags, which cover both keys, do not match.
    let (joiner_id, host_id, relay_id) = (Identity::generate().expect("j"), Identity::generate().expect("h"), Identity::generate().expect("m"));
    let joiner_side = TcpListener::bind("127.0.0.1:0").expect("bind");
    let host_side = TcpListener::bind("127.0.0.1:0").expect("bind");
    let (joiner_address, host_address) = (joiner_side.local_addr().expect("addr"), host_side.local_addr().expect("addr"));
    let (done_tx, done_rx) = mpsc::channel();
    thread::scope(|scope| {
        let host = scope.spawn(|| {
            let (stream, _) = host_side.accept().expect("accept");
            limits(&stream);
            let mut channel = Channel::accept(stream, &host_id).expect("accept");
            pairing::host(&mut channel, Some("12345678"), "alice-laptop", "2026-11-14")
        });
        scope.spawn(|| {
            let (from_joiner, _) = joiner_side.accept().expect("accept");
            limits(&from_joiner);
            let mut towards_joiner = Channel::accept(from_joiner, &relay_id).expect("accept");
            let to_host = TcpStream::connect(host_address).expect("connect");
            limits(&to_host);
            let mut towards_host = Channel::connect(to_host, &relay_id).expect("connect");
            // Four messages in the pairing exchange: start, reply, confirm, confirmed.
            let start = towards_joiner.recv().expect("recv");
            towards_host.send(&start).expect("send");
            let reply = towards_host.recv().expect("recv");
            towards_joiner.send(&reply).expect("send");
            let confirm = towards_joiner.recv().expect("recv");
            towards_host.send(&confirm).expect("send");
            if let Ok(answer) = towards_host.recv() {
                let _ = towards_joiner.send(&answer);
            }
            let _ = done_tx.send(());
        });
        let client = TcpStream::connect(joiner_address).expect("connect");
        limits(&client);
        let mut joiner = Channel::connect(client, &joiner_id).expect("connect");
        let joined = pairing::join(&mut joiner, "12345678", "bob-phone", "2026-11-14");
        let hosted = host.join().expect("thread");
        assert!(joined.is_err(), "the joiner did not accept the relay as the host: {joined:?}");
        assert!(hosted.is_err(), "the host did not accept the relay as the joiner: {hosted:?}");
    });
    let _ = done_rx.recv_timeout(Duration::from_secs(5));
}
