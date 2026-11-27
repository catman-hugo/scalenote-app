//! Tests for the sync itself: two real services on loopback, two real folders, the real
//! encrypted connection. Nothing is faked: the same code path that two devices use.

use super::channel::Channel;
use super::engine::Outcome;
use super::exchange::{recv_blob, send_blob, KIND_BYE, KIND_DEL, KIND_LIST, KIND_LISTING, KIND_NO, KIND_PUT};
use super::identity::Identity;
use super::service::{EventKind, Service};
use super::SyncError;
use std::fs;
use std::net::TcpStream;
use std::path::{Path, PathBuf};
use std::time::Duration;

struct Dir(PathBuf);

impl Dir {
    fn new(label: &str) -> Dir {
        let path = std::env::temp_dir().join(format!("sn-sync-{label}-{}", std::process::id()));
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

struct Pair {
    alice: Service,
    bob: Service,
    /// Alice's vault and Bob's vault.
    va: Dir,
    vb: Dir,
    /// How Alice names Bob in `sync_peer`.
    bob_id: String,
    _dirs: (Dir, Dir),
}

fn setup(label: &str) -> Pair {
    let (da, db) = (Dir::new(&format!("{label}-da")), Dir::new(&format!("{label}-db")));
    let (va, vb) = (Dir::new(&format!("{label}-va")), Dir::new(&format!("{label}-vb")));
    let make = |dir: &Dir, name: &str| Service::with_bind(&dir.0, Identity::generate().expect("identity"), name, true, "127.0.0.1", 0).expect("service");
    let (alice, bob) = (make(&da, "alice"), make(&db, "bob"));
    let code = bob.start_pairing().expect("code");
    let address = format!("127.0.0.1:{}", bob.status().listening_port.expect("listening"));
    alice.join(&address, &code).expect("pair");
    alice.set_vault(Some(va.0.clone()));
    bob.set_vault(Some(vb.0.clone()));
    let bob_id = alice.status().peers[0].id.clone();
    Pair { alice, bob, va, vb, bob_id, _dirs: (da, db) }
}

fn write(root: &Path, relative: &str, text: &str) {
    let path = root.join(relative);
    fs::create_dir_all(path.parent().expect("parent")).expect("folders");
    fs::write(path, text).expect("write");
}

fn read(root: &Path, relative: &str) -> String {
    fs::read_to_string(root.join(relative)).unwrap_or_else(|_| "<missing>".to_string())
}

fn sync(pair: &Pair) -> super::engine::Report {
    match pair.alice.sync_peer(&pair.bob_id, true, &mut |_| {}).expect("sync") {
        Outcome::Done(report) => report,
        Outcome::NeedsApproval(_) => panic!("approval was given"),
    }
}

fn names(root: &Path) -> Vec<String> {
    super::manifest::Manifest::scan(root).expect("scan").manifest.files.keys().cloned().collect()
}

#[test]
fn the_first_sync_waits_for_a_yes_changes_nothing_and_then_joins_both_vaults() {
    let p = setup("first");
    write(&p.va.0, "Alice page.md", "from alice");
    write(&p.vb.0, "Bob page.md", "from bob");
    write(&p.vb.0, "School/Notes.md", "deep");
    let outcome = p.alice.sync_peer(&p.bob_id, false, &mut |_| {}).expect("preview");
    let Outcome::NeedsApproval(preview) = outcome else { panic!("a first sync must wait") };
    assert!(preview.first);
    assert_eq!((preview.summary.push, preview.summary.pull), (1, 2));
    assert_eq!(names(&p.va.0), vec!["Alice page.md"], "nothing changed here before the yes");
    assert_eq!(names(&p.vb.0).len(), 2, "nothing changed there either");
    let report = sync(&p);
    assert_eq!((report.sent, report.received, report.changed()), (1, 2, 3));
    assert_eq!(names(&p.va.0), names(&p.vb.0));
    assert_eq!(read(&p.va.0, "School/Notes.md"), "deep");
    assert_eq!(read(&p.vb.0, "Alice page.md"), "from alice");
    // The second sync is not a first one any more and has nothing to do.
    let Outcome::Done(again) = p.alice.sync_peer(&p.bob_id, false, &mut |_| {}).expect("second") else { panic!("no approval needed twice") };
    assert_eq!(again.changed(), 0);
    assert!(p.alice.status().events.iter().any(|e| e.kind == EventKind::Synced && e.changed == 3 && e.name == "bob"), "the sync is in the activity list");
    // The answering side notes it a moment later, when it sees the goodbye. It counts what it
    // wrote itself: one file (Alice page), not the two it gave away.
    let noted = (0..60).any(|_| {
        std::thread::sleep(Duration::from_millis(50));
        p.bob.status().events.iter().any(|e| e.kind == EventKind::Synced && e.changed == 1 && e.name == "alice")
    });
    assert!(noted, "the other device also notes it");
}

#[test]
fn compare_shows_the_plan_and_changes_nothing_anywhere() {
    let p = setup("compare");
    write(&p.va.0, "A.md", "a");
    write(&p.vb.0, "B.md", "b");
    let preview = p.alice.compare_peer(&p.bob_id).expect("compare");
    assert_eq!((preview.summary.push, preview.summary.pull), (1, 1));
    assert_eq!(names(&p.va.0), vec!["A.md"]);
    assert_eq!(names(&p.vb.0), vec!["B.md"]);
    assert!(!p.alice.status().peers[0].has_history, "comparing is not a sync");
}

#[test]
fn edits_go_across_and_a_delete_goes_to_the_other_devices_trash_and_can_be_restored() {
    let p = setup("edit");
    write(&p.va.0, "Plan.md", "v1");
    write(&p.va.0, "Photo.png", "not really a picture");
    sync(&p);
    write(&p.va.0, "Plan.md", "v2 from alice");
    let r = sync(&p);
    assert_eq!(r.sent, 1);
    assert_eq!(read(&p.vb.0, "Plan.md"), "v2 from alice");
    // Bob deletes a page and a picture; Alice gets them in her trash.
    fs::remove_file(p.vb.0.join("Plan.md")).expect("delete");
    fs::remove_file(p.vb.0.join("Photo.png")).expect("delete");
    let r = sync(&p);
    assert_eq!(r.deleted_here, 2);
    assert!(!p.va.0.join("Plan.md").exists() && !p.va.0.join("Photo.png").exists());
    let vault = crate::vault::Vault::open(&p.va.0).expect("vault");
    let trash = vault.trash_list().expect("trash");
    assert_eq!(trash.len(), 2, "both files are in the trash, not gone");
    let page = trash.iter().find(|t| t.name == "Plan.md").expect("page in trash");
    vault.restore_from_trash(&page.id).expect("restore");
    assert_eq!(read(&p.va.0, "Plan.md"), "v2 from alice");
}

#[test]
fn a_conflict_keeps_both_versions_on_both_devices_and_loses_no_text() {
    let p = setup("conflict");
    write(&p.va.0, "Shared.md", "start");
    sync(&p);
    write(&p.va.0, "Shared.md", "alice wrote this");
    write(&p.vb.0, "Shared.md", "bob wrote that");
    let r = sync(&p);
    assert_eq!(r.conflicts, 1);
    assert_eq!(r.conflict_copies.len(), 1);
    assert_eq!(names(&p.va.0), names(&p.vb.0), "both devices have the same files");
    assert_eq!(names(&p.va.0).len(), 2);
    let texts: Vec<String> = names(&p.va.0).iter().map(|n| read(&p.va.0, n)).collect();
    assert!(texts.contains(&"alice wrote this".to_string()) && texts.contains(&"bob wrote that".to_string()), "both versions survive: {texts:?}");
    for name in names(&p.va.0) {
        assert_eq!(read(&p.va.0, &name), read(&p.vb.0, &name), "{name} is identical on both");
    }
    assert!(r.conflict_copies[0].contains("(conflict "), "the copy is named as a conflict copy");
    // A third sync has nothing left to do.
    assert_eq!(sync(&p).changed(), 0);
}

#[test]
fn an_edit_beats_a_delete_on_the_other_side() {
    let p = setup("editdelete");
    write(&p.va.0, "Keep.md", "start");
    sync(&p);
    fs::remove_file(p.va.0.join("Keep.md")).expect("delete on alice");
    write(&p.vb.0, "Keep.md", "bob kept typing");
    sync(&p);
    assert_eq!(read(&p.va.0, "Keep.md"), "bob kept typing");
    assert_eq!(read(&p.vb.0, "Keep.md"), "bob kept typing");
}

#[test]
fn a_folder_of_settings_and_a_drawing_sync_too_but_the_settings_never_get_a_copy_file() {
    let p = setup("settings");
    write(&p.va.0, ".scalenote/folder-icons.json", "{\"a\":1}");
    write(&p.va.0, "Page.md", "text");
    write(&p.va.0, "Page.canvas.json", "{\"ink\":[]}");
    sync(&p);
    assert_eq!(read(&p.vb.0, ".scalenote/folder-icons.json"), "{\"a\":1}");
    assert_eq!(read(&p.vb.0, "Page.canvas.json"), "{\"ink\":[]}");
    write(&p.va.0, ".scalenote/folder-icons.json", "{\"a\":2}");
    write(&p.vb.0, ".scalenote/folder-icons.json", "{\"a\":3}");
    sync(&p);
    assert_eq!(read(&p.va.0, ".scalenote/folder-icons.json"), read(&p.vb.0, ".scalenote/folder-icons.json"));
    let hidden: Vec<_> = fs::read_dir(p.va.0.join(".scalenote")).expect("dir").flatten().map(|e| e.file_name().to_string_lossy().into_owned()).filter(|n| n.contains("conflict")).collect();
    assert!(hidden.is_empty(), "no hidden conflict copy: {hidden:?}");
}

#[test]
fn pause_stops_both_directions_and_resume_brings_it_back() {
    let p = setup("pause");
    write(&p.va.0, "A.md", "a");
    p.alice.set_paused(true).expect("pause");
    assert!(p.alice.status().paused);
    let error = p.alice.sync_peer(&p.bob_id, true, &mut |_| {}).err().expect("paused");
    assert_eq!(error.code(), "sync_paused");
    // Bob is paused: Alice's sync is turned away, and nothing changes on either side.
    p.alice.set_paused(false).expect("resume");
    p.bob.set_paused(true).expect("pause bob");
    let error = p.alice.sync_peer(&p.bob_id, true, &mut |_| {}).err().expect("bob paused");
    assert_eq!(error.code(), "sync_peer_refused");
    assert!(names(&p.vb.0).is_empty());
    p.bob.set_paused(false).expect("resume bob");
    assert_eq!(sync(&p).sent, 1);
}

#[test]
fn wifi_only_blocks_a_device_off_wifi_and_never_blocks_the_others() {
    let p = setup("wifionly");
    write(&p.va.0, "A.md", "a");
    assert!(!p.alice.status().peers[0].wifi_only);
    p.alice.set_wifi_only(&p.bob_id, true).expect("set");
    assert!(p.alice.status().peers[0].wifi_only);
    // On Wi-Fi (or when the system cannot tell) the sync goes ahead.
    assert!(p.alice.status().on_wifi);
    // Off Wi-Fi it is refused before any connection is opened, by hand or by the automatic round.
    p.alice.set_on_wifi(false);
    let error = p.alice.sync_peer(&p.bob_id, true, &mut |_| {}).err().expect("blocked");
    assert_eq!(error.code(), "sync_wifi_only");
    assert!(p.alice.auto_sync_tick(Duration::from_millis(50)).is_empty());
    assert!(names(&p.vb.0).is_empty());
    // Switching the limit off lets it through again without Wi-Fi.
    p.alice.set_wifi_only(&p.bob_id, false).expect("unset");
    assert_eq!(sync(&p).sent, 1);
    // A made-up or unpaired id is an error, not a silent no-op.
    assert!(p.alice.set_wifi_only("zz", true).is_err());
    assert!(p.alice.set_wifi_only(&"00".repeat(32), true).is_err());
}

#[test]
fn a_device_that_is_not_paired_or_a_vault_that_is_not_open_gets_nothing() {
    let p = setup("refuse");
    write(&p.vb.0, "Secret.md", "private");
    // A stranger with its own key connects and asks for the list.
    let port = p.bob.status().listening_port.expect("port");
    let stream = TcpStream::connect(("127.0.0.1", port)).expect("connect");
    let mut stranger = Channel::connect(stream, &Identity::generate().expect("identity")).expect("handshake");
    send_blob(&mut stranger, KIND_LIST, &[], &[]).expect("ask");
    // The refusal is a single byte, not a blob; either way it is not a list.
    let answer = stranger.recv().expect("answer");
    assert_eq!(answer, vec![super::pairing::KIND_REFUSED], "a stranger is turned away and never gets a list");
    let _ = KIND_LISTING;
    // A paired device is told no while no vault is open.
    p.bob.set_vault(None);
    let error = p.alice.sync_peer(&p.bob_id, true, &mut |_| {}).err().expect("no vault there");
    assert_eq!(error.code(), "sync_peer_refused");
    let error = Service::with_bind(&Dir::new("refuse-x").0, Identity::generate().expect("identity"), "x", true, "127.0.0.1", 0).expect("service").sync_peer(&p.bob_id, true, &mut |_| {}).err().expect("not paired");
    assert!(matches!(error, SyncError::Refused(_)));
}

/// A paired device that is hostile or damaged: the rules still hold on the answering side.
fn paired_channel(p: &Pair) -> Channel<TcpStream> {
    // Use Alice's real identity to be a trusted caller, but speak the protocol by hand.
    let port = p.bob.status().listening_port.expect("port");
    let stream = TcpStream::connect(("127.0.0.1", port)).expect("connect");
    stream.set_read_timeout(Some(Duration::from_secs(5))).expect("timeout");
    Channel::connect(stream, p.alice_identity()).expect("handshake")
}

impl Pair {
    fn alice_identity(&self) -> &Identity {
        self.alice.identity_for_tests()
    }
}

fn put_meta(expected: &str, content: &[u8], path: &str) -> String {
    format!("{expected}\n{}\n{path}", super::manifest::hash_bytes(content))
}

#[test]
fn paths_that_lead_out_of_the_vault_or_into_hidden_places_are_refused_and_nothing_is_written() {
    let p = setup("paths");
    let outside = p.vb.0.parent().expect("parent").join(format!("sn-escape-{}.md", std::process::id()));
    let _ = fs::remove_file(&outside);
    for bad in ["../escape.md", "a/../../escape.md", "/etc/escape.md", ".trash/x.md", ".scalenote/other.json", "C:/x.md", "a\\b.md", "x.sn-tmp"] {
        let mut channel = paired_channel(&p);
        let body = b"owned";
        send_blob(&mut channel, KIND_PUT, put_meta("-", body, bad).as_bytes(), body).expect("send");
        let answer = recv_blob(&mut channel, 1 << 20).expect("answer");
        assert_eq!(answer.kind, KIND_NO, "{bad} must be refused");
    }
    assert!(!outside.exists(), "nothing landed outside the vault");
    assert!(names(&p.vb.0).is_empty() && fs::read_dir(&p.vb.0).expect("dir").count() == 0, "nothing landed inside either");
}

#[test]
fn a_file_that_changed_since_the_plan_is_not_overwritten_or_deleted() {
    let p = setup("changed");
    write(&p.vb.0, "Note.md", "typed a moment ago");
    let mut channel = paired_channel(&p);
    let old = "0".repeat(64);
    let body = b"stale plan";
    send_blob(&mut channel, KIND_PUT, put_meta(&old, body, "Note.md").as_bytes(), body).expect("send");
    assert_eq!(recv_blob(&mut channel, 1 << 20).expect("answer").kind, super::exchange::KIND_CHANGED);
    send_blob(&mut channel, KIND_DEL, format!("{old}\nNote.md").as_bytes(), &[]).expect("send");
    assert_eq!(recv_blob(&mut channel, 1 << 20).expect("answer").kind, super::exchange::KIND_CHANGED);
    assert_eq!(read(&p.vb.0, "Note.md"), "typed a moment ago");
    send_blob(&mut channel, KIND_BYE, &[], &[]).expect("bye");
}

#[test]
fn damaged_or_oversized_requests_end_the_connection_without_storing_anything() {
    let p = setup("damaged");
    // The announced hash does not match the bytes.
    let mut channel = paired_channel(&p);
    send_blob(&mut channel, KIND_PUT, put_meta("-", b"other", "X.md").as_bytes(), b"real bytes").expect("send");
    assert_eq!(recv_blob(&mut channel, 1 << 20).expect("answer").kind, KIND_NO);
    assert!(!p.vb.0.join("X.md").exists());
    // A body far bigger than any file is refused before it is read: hand-made head message.
    let mut channel = paired_channel(&p);
    let meta = put_meta("-", b"", "Huge.md");
    let mut head = vec![KIND_PUT];
    head.extend_from_slice(&(meta.len() as u16).to_be_bytes());
    head.extend_from_slice(meta.as_bytes());
    head.extend_from_slice(&(10u64 * 1024 * 1024 * 1024).to_be_bytes());
    channel.send(&head).expect("send head");
    assert!(recv_blob(&mut channel, 1 << 20).is_err(), "the connection is dropped");
    assert!(!p.vb.0.join("Huge.md").exists());
}

#[test]
fn a_connection_cut_in_the_middle_of_a_file_leaves_no_half_file_and_the_next_sync_finishes() {
    let p = setup("cut");
    write(&p.vb.0, "Existing.md", "must survive");
    // Send the head of a big PUT and only the first chunk, then hang up.
    let big = vec![b'x'; 300_000];
    let mut channel = paired_channel(&p);
    let meta = put_meta("-", &big, "Big.md");
    let mut head = vec![KIND_PUT];
    head.extend_from_slice(&(meta.len() as u16).to_be_bytes());
    head.extend_from_slice(meta.as_bytes());
    head.extend_from_slice(&(big.len() as u64).to_be_bytes());
    channel.send(&head).expect("head");
    let mut chunk = vec![0x50];
    chunk.extend_from_slice(&big[..50_000]);
    channel.send(&chunk).expect("chunk");
    drop(channel);
    std::thread::sleep(Duration::from_millis(300));
    assert!(!p.vb.0.join("Big.md").exists(), "a file that did not arrive whole is not there");
    let leftovers: Vec<_> = fs::read_dir(&p.vb.0).expect("dir").flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect();
    assert_eq!(leftovers, vec!["Existing.md"], "no temporary file either");
    write(&p.va.0, "Big.md", &"x".repeat(300_000));
    sync(&p);
    assert_eq!(read(&p.vb.0, "Big.md").len(), 300_000);
    assert_eq!(read(&p.vb.0, "Existing.md"), "must survive");
}

#[test]
fn a_big_vault_and_a_big_attachment_arrive_whole() {
    let p = setup("big");
    for i in 0..1500 {
        write(&p.va.0, &format!("Folder {}/Page {i}.md", i % 30), &format!("page number {i}\n"));
    }
    let attachment: Vec<u8> = (0..20_000_000u32).map(|i| (i % 251) as u8).collect();
    fs::write(p.va.0.join("Scan.pdf"), &attachment).expect("attachment");
    let report = sync(&p);
    assert_eq!(report.sent, 1501);
    assert_eq!(names(&p.va.0), names(&p.vb.0));
    assert_eq!(fs::read(p.vb.0.join("Scan.pdf")).expect("read"), attachment, "the attachment is byte for byte the same");
    assert_eq!(sync(&p).changed(), 0, "and the next sync sees nothing to do");
}

#[test]
fn a_file_over_the_transfer_limit_is_reported_not_moved() {
    let p = setup("toobig");
    // A sparse file looks big to the list without needing the disk space.
    let file = fs::File::create(p.va.0.join("Huge.bin")).expect("file");
    file.set_len(super::files::MAX_TRANSFER_BYTES + 1).expect("sparse");
    write(&p.va.0, "Small.md", "fine");
    let report = sync(&p);
    assert_eq!(report.too_big, vec!["Huge.bin".to_string()]);
    assert_eq!(names(&p.vb.0), vec!["Small.md"]);
}

#[test]
fn a_linked_folder_is_never_followed_out_of_the_vault() {
    #[cfg(unix)]
    {
        let p = setup("link");
        let outside = Dir::new("link-outside");
        write(&outside.0, "Private.md", "not for sync");
        std::os::unix::fs::symlink(&outside.0, p.va.0.join("Linked")).expect("link");
        write(&p.va.0, "Real.md", "real");
        sync(&p);
        assert_eq!(names(&p.vb.0), vec!["Real.md"]);
        // And the answering side never writes through a link either.
        std::os::unix::fs::symlink(&outside.0, p.vb.0.join("Door")).expect("link");
        let mut channel = paired_channel(&p);
        let body = b"through the door";
        send_blob(&mut channel, KIND_PUT, put_meta("-", body, "Door/Written.md").as_bytes(), body).expect("send");
        assert_eq!(recv_blob(&mut channel, 1 << 20).expect("answer").kind, KIND_NO);
        assert!(!outside.0.join("Written.md").exists());
    }
}

#[test]
fn rename_a_paired_device_and_removing_it_forgets_the_sync_history() {
    let p = setup("rename");
    write(&p.va.0, "A.md", "a");
    sync(&p);
    assert!(p.alice.status().peers[0].has_history);
    p.alice.rename_peer(&p.bob_id, "Bob's tablet!").expect("rename");
    assert_eq!(p.alice.status().peers[0].name, "Bobs-tablet", "the name is cleaned like any device name");
    assert!(p.alice.rename_peer("not-a-key", "x").is_err());
    p.alice.remove_peer(&p.bob_id).expect("remove");
    assert!(!super::engine::has_history(&p.va.0, &[0u8; 32]));
    assert!(p.alice.status().peers.is_empty());
    assert!(names(&p.va.0).contains(&"A.md".to_string()), "removing a device never touches the notes");
}

#[test]
fn the_vault_signature_moves_when_something_changes_and_ignores_hidden_things() {
    let dir = Dir::new("signature");
    let before = super::watch::signature(&dir.0);
    write(&dir.0, "A.md", "one");
    let after_add = super::watch::signature(&dir.0);
    assert_ne!(before, after_add);
    write(&dir.0, ".trash/x/item", "hidden");
    write(&dir.0, ".scalenote/sync-base-x.txt", "hidden");
    assert_eq!(after_add, super::watch::signature(&dir.0), "hidden folders do not count");
    write(&dir.0, "A.md", "two!");
    assert_ne!(after_add, super::watch::signature(&dir.0));
}

#[test]
fn the_automatic_round_does_nothing_and_opens_no_connection_when_nothing_is_due() {
    let p = setup("auto");
    // No history yet: a first sync is never started by itself.
    assert!(p.alice.auto_sync_tick(Duration::from_millis(50)).is_empty());
    write(&p.va.0, "A.md", "a");
    sync(&p);
    // Right after a sync with nothing changed: not due either.
    assert!(p.alice.auto_sync_tick(Duration::from_millis(50)).is_empty());
    p.alice.set_paused(true).expect("pause");
    write(&p.va.0, "B.md", "b");
    assert!(p.alice.auto_sync_tick(Duration::from_millis(50)).is_empty(), "paused means paused");
    let _ = Duration::from_millis(1);
}

#[test]
fn after_a_sync_each_side_shows_the_other_ones_app_version_and_the_last_sync_time() {
    let p = setup("version");
    assert_eq!(p.alice.status().peers[0].version, "", "unknown before any sync");
    assert_eq!(p.alice.status().peers[0].last_sync, "", "never synced");
    write(&p.va.0, "A.md", "one\n");
    sync(&p);
    let seen = &p.alice.status().peers[0];
    assert_eq!(seen.version, super::service::APP_VERSION);
    assert!(seen.last_sync.ends_with('Z') && seen.last_sync.len() == 20, "{}", seen.last_sync);
    // The other side learned Alice's version from the same exchange.
    assert_eq!(p.bob.status().peers[0].version, super::service::APP_VERSION);
}

#[test]
fn the_last_sync_time_is_still_known_after_a_restart() {
    let p = setup("restart-time");
    write(&p.va.0, "A.md", "one\n");
    sync(&p);
    let before = p.alice.status().peers[0].last_sync.clone();
    assert!(!before.is_empty());
    // A new service with the same folders knows nothing live, but the vault's saved list tells it.
    let again = Service::with_bind(&p._dirs.0 .0, Identity::generate().expect("identity"), "alice", true, "127.0.0.1", 0).expect("service");
    again.set_vault(Some(p.va.0.clone()));
    // The live time is taken just after the list is saved, so the two can be a second apart.
    let after = again.status().peers[0].last_sync.clone();
    let seconds = |t: &str| -> i64 { t[11..13].parse::<i64>().unwrap_or(0) * 3600 + t[14..16].parse::<i64>().unwrap_or(0) * 60 + t[17..19].parse::<i64>().unwrap_or(0) };
    assert_eq!(after.len(), 20, "{after}");
    assert_eq!(after[..10], before[..10], "same day: {after} {before}");
    assert!((seconds(&before) - seconds(&after)).abs() <= 1, "{after} vs {before}");
}

#[test]
fn a_version_sent_by_another_device_is_only_shown_if_it_is_plain_digits_and_dots() {
    let p = setup("badversion");
    let address = format!("127.0.0.1:{}", p.bob.status().listening_port.expect("listening"));
    for hostile in [&b"<b>1</b>"[..], b"", b"1.2.3.4.5.6.7.8.9.10.11.12.13", &[0xff, 0xfe][..], b"1 2"] {
        let stream = TcpStream::connect(&address).expect("connect");
        stream.set_read_timeout(Some(Duration::from_secs(5))).expect("timeout");
        let identity = Identity::generate().expect("identity");
        // An unpaired device may not ask this at all; the connection is refused, and nothing is stored.
        let mut channel = Channel::connect(stream, &identity).expect("channel");
        let mut message = vec![0x22];
        message.extend_from_slice(hostile);
        channel.send(&message).expect("send");
        let answer = channel.recv().expect("answer");
        assert_ne!(answer.first(), Some(&0x23), "an unpaired device gets no version answer");
    }
    assert_eq!(p.bob.status().peers[0].version, "");
}

#[test]
fn older_versions_are_recognised_and_odd_text_is_never_older() {
    use super::service::is_older;
    assert!(is_older("0.5.4", "0.5.5"));
    assert!(is_older("0.4.15", "0.5.0"));
    assert!(is_older("0.5.9", "0.5.10"), "numbers, not text, are compared");
    assert!(!is_older("0.5.5", "0.5.5"));
    assert!(!is_older("0.6.0", "0.5.5"));
    for odd in ["", "x", "1..2", "1.2.x", "-1"] {
        assert!(!is_older(odd, "0.5.5"), "{odd:?}");
    }
}

// ---------- 0.5.6: each paired device belongs to one notes folder ----------

#[test]
fn an_older_pairing_is_tied_at_its_first_sync_and_then_only_syncs_in_that_folder_on_either_side() {
    let p = setup("folders-old");
    write(&p.va.0, "A.md", "from alice\n");
    // Paired before any folder was open: not tied yet, so the old behaviour (one sync ties it).
    assert_eq!(p.alice.status().peers[0].folder, "");
    sync(&p);
    let tied = p.alice.status().peers[0].clone();
    assert_eq!(tied.folder, p.va.0.to_str().expect("path"));
    assert!(!tied.other_folder);
    assert_eq!(read(&p.vb.0, "A.md"), "from alice\n");

    // Alice opens another folder: the sync is refused here and nothing moves either way.
    let other = Dir::new("folders-old-va2");
    write(&other.0, "Private.md", "never to bob\n");
    p.alice.set_vault(Some(other.0.clone()));
    assert!(p.alice.status().peers[0].other_folder);
    let error = p.alice.sync_peer(&p.bob_id, true, &mut |_| {}).err().expect("refused");
    assert_eq!(error.code(), "sync_other_folder");
    assert_eq!(p.alice.compare_peer(&p.bob_id).err().expect("compare refused").code(), "sync_other_folder");
    assert_eq!(read(&p.vb.0, "Private.md"), "<missing>");
    assert!(p.alice.auto_sync_tick(Duration::from_millis(50)).is_empty(), "never started automatically either");

    // Back in the right folder, but now Bob has another folder open: Bob refuses and says why.
    p.alice.set_vault(Some(p.va.0.clone()));
    let bob_other = Dir::new("folders-old-vb2");
    p.bob.set_vault(Some(bob_other.0.clone()));
    let error = p.alice.sync_peer(&p.bob_id, true, &mut |_| {}).err().expect("bob refuses");
    assert_eq!(error.code(), "sync_peer_other_folder");
    assert!(names(&bob_other.0).is_empty(), "nothing written into Bob's other folder");
    p.bob.set_vault(Some(p.vb.0.clone()));
    sync(&p);
}

#[test]
fn a_device_paired_while_a_folder_is_open_belongs_to_it_and_two_server_vaults_never_mix() {
    // Alice is the phone; Bob and Carol stand for two vaults on a home server.
    let (da, db, dc) = (Dir::new("mix-da"), Dir::new("mix-db"), Dir::new("mix-dc"));
    let (school, personal) = (Dir::new("mix-school"), Dir::new("mix-personal"));
    let (server_school, server_personal) = (Dir::new("mix-s-school"), Dir::new("mix-s-personal"));
    let make = |dir: &Dir, name: &str| Service::with_bind(&dir.0, Identity::generate().expect("identity"), name, true, "127.0.0.1", 0).expect("service");
    let (alice, bob, carol) = (make(&da, "phone"), make(&db, "school-vault"), make(&dc, "personal-vault"));
    bob.set_vault(Some(server_school.0.clone()));
    carol.set_vault(Some(server_personal.0.clone()));
    let join = |host: &Service| {
        let code = host.start_pairing().expect("code");
        let address = format!("127.0.0.1:{}", host.status().listening_port.expect("listening"));
        alice.join(&address, &code).expect("pair").public
    };
    alice.set_vault(Some(school.0.clone()));
    let bob_id = super::hex::encode(&join(&bob));
    alice.set_vault(Some(personal.0.clone()));
    let carol_id = super::hex::encode(&join(&carol));
    let peers = alice.status().peers;
    let folder_of = |id: &str| peers.iter().find(|p| p.id == id).expect("peer").folder.clone();
    assert_eq!(folder_of(&bob_id), school.0.to_str().expect("path"));
    assert_eq!(folder_of(&carol_id), personal.0.to_str().expect("path"));

    write(&personal.0, "Diary.md", "personal\n");
    write(&school.0, "Lecture.md", "school\n");
    // With the personal folder open, only the personal vault syncs.
    assert!(matches!(alice.sync_peer(&carol_id, true, &mut |_| {}).expect("carol"), Outcome::Done(_)));
    assert_eq!(alice.sync_peer(&bob_id, true, &mut |_| {}).err().expect("bob refused").code(), "sync_other_folder");
    alice.set_vault(Some(school.0.clone()));
    assert!(matches!(alice.sync_peer(&bob_id, true, &mut |_| {}).expect("bob"), Outcome::Done(_)));
    assert_eq!(read(&server_personal.0, "Diary.md"), "personal\n");
    assert_eq!(read(&server_school.0, "Lecture.md"), "school\n");
    assert_eq!(read(&server_school.0, "Diary.md"), "<missing>", "the vaults never mix");
    assert_eq!(read(&server_personal.0, "Lecture.md"), "<missing>");

    // A pairing can be moved to the open folder on purpose, and the ties survive a restart.
    alice.tie_to_open_folder(&carol_id).expect("move");
    assert!(!alice.status().peers.iter().find(|p| p.id == carol_id).expect("carol").other_folder);
    drop(alice);
    let again = Service::with_bind(&da.0, Identity::generate().expect("identity"), "phone", true, "127.0.0.1", 0).expect("restart");
    let peers = again.status().peers;
    assert!(peers.iter().all(|p| p.folder == school.0.to_str().expect("path")), "kept after a restart: {peers:?}");
    // Unpairing forgets the tie too.
    again.remove_peer(&bob_id).expect("remove");
    assert!(!fs::read_to_string(da.0.join("sync-folders.txt")).expect("file").contains(&bob_id));
}

fn folders(root: &Path) -> Vec<String> {
    super::manifest::Manifest::scan(root).expect("scan").folders.into_iter().collect()
}

#[test]
fn an_empty_folder_reaches_the_other_device_and_a_moved_folder_leaves_no_empty_copy_behind() {
    let p = setup("folders-move");
    write(&p.va.0, "Cytology/Cells.md", "cells");
    write(&p.va.0, "Histology/Tissue.md", "tissue");
    sync(&p);
    assert_eq!(folders(&p.vb.0), vec!["Cytology", "Histology"]);
    // On Alice's device: both folders move into Year 2/Course, and an empty folder is made.
    fs::create_dir_all(p.va.0.join("Year 2/Course")).expect("course");
    fs::rename(p.va.0.join("Cytology"), p.va.0.join("Year 2/Course/Cytology")).expect("move");
    fs::rename(p.va.0.join("Histology"), p.va.0.join("Year 2/Course/Histology")).expect("move");
    fs::create_dir_all(p.va.0.join("Year 2/Empty course")).expect("empty");
    let report = sync(&p);
    assert_eq!(folders(&p.vb.0), folders(&p.va.0), "the same folders on both");
    assert_eq!(folders(&p.vb.0), vec!["Year 2", "Year 2/Course", "Year 2/Course/Cytology", "Year 2/Course/Histology", "Year 2/Empty course"]);
    assert_eq!(read(&p.vb.0, "Year 2/Course/Cytology/Cells.md"), "cells");
    assert_eq!(report.folders, 3, "Empty course made there, the two old folders removed there");
    // Nothing more to do.
    assert_eq!(sync(&p).changed(), 0);
}

#[test]
fn a_folder_removed_on_one_device_stays_where_something_was_added_to_it() {
    let p = setup("folders-keep");
    fs::create_dir_all(p.va.0.join("Plans/Empty")).expect("plans");
    sync(&p);
    assert_eq!(folders(&p.vb.0), vec!["Plans", "Plans/Empty"], "empty folders reach the other device");
    // Bob adds a page to Plans while Alice removes the whole folder.
    write(&p.vb.0, "Plans/New idea.md", "keep me");
    fs::remove_dir_all(p.va.0.join("Plans")).expect("remove");
    sync(&p);
    assert_eq!(read(&p.vb.0, "Plans/New idea.md"), "keep me", "a folder never takes a page with it");
    assert_eq!(read(&p.va.0, "Plans/New idea.md"), "keep me", "and the page comes back to Alice");
    assert_eq!(folders(&p.vb.0), vec!["Plans"], "only the empty folder inside was removed");
    assert_eq!(folders(&p.va.0), vec!["Plans"]);
}

#[test]
fn folders_are_left_alone_with_a_device_that_lists_none() {
    // What an app before 0.6.7 sends: a listing without the folder lines.
    let dir = Dir::new("folders-old");
    fs::create_dir_all(dir.0.join("Only here")).expect("dir");
    let listing = super::exchange::own_listing(&dir.0).expect("listing");
    assert_eq!(listing.folders, Some(["Only here".to_string()].into()));
    let old = super::exchange::Listing { folders: None, ..listing.clone() };
    let decoded = super::exchange::decode_listing_full(&super::exchange::encode_listing_full(&old)).expect("decode");
    assert_eq!(decoded.folders, None, "no folder list is not an empty folder list");
    let decoded = super::exchange::decode_listing_full(&super::exchange::encode_listing_full(&listing)).expect("decode");
    assert_eq!(decoded, listing);
    // And the lines an older app would see are only ones it skips (they start with `/`).
    let body = super::exchange::encode_listing_full(&listing);
    let text = String::from_utf8_lossy(&body);
    assert!(text.contains("\n/folders\n/folder Only here\n"), "{text}");
}

// ---------- 0.6.9: both devices keep the list at the end of a sync ----------

/// Bob as a device that starts syncs too: where Alice listens, and how Bob names her.
fn bob_can_reach_alice(p: &Pair) -> String {
    let alice_id = p.bob.status().peers[0].id.clone();
    let port = p.alice.status().listening_port.expect("alice listens");
    p.bob.set_address_for_test(&alice_id, &format!("127.0.0.1:{port}"));
    alice_id
}

fn bob_syncs(p: &Pair, alice_id: &str) -> super::engine::Report {
    match p.bob.sync_peer(alice_id, false, &mut |_| {}).expect("sync") {
        Outcome::Done(report) => report,
        Outcome::NeedsApproval(_) => panic!("bob was asked for a first sync although alice and bob had synced"),
    }
}

/// The answering side notes a sync when it sees the goodbye, a moment after the caller is done.
fn wait_until(check: impl Fn() -> bool) -> bool {
    (0..100).any(|_| {
        if check() {
            return true;
        }
        std::thread::sleep(Duration::from_millis(30));
        false
    })
}

#[test]
fn the_device_that_only_answered_does_not_see_its_first_sync_when_it_starts_one() {
    // Reported: a phone that had synced for weeks, always started by the laptop, showed "First
    // sync with …" the first time Sync now was pressed on the phone.
    let p = setup("base-first");
    write(&p.va.0, "A.md", "from alice\n");
    sync(&p);
    let alice_id = bob_can_reach_alice(&p);
    assert!(wait_until(|| p.bob.status().peers[0].has_history), "bob kept the list too");
    let report = bob_syncs(&p, &alice_id);
    assert_eq!(report.changed(), 0);
}

#[test]
fn a_page_renamed_on_the_device_that_started_the_syncs_is_not_sent_back_under_its_old_name() {
    // Reported: a new page reached the phone unnamed; after it was named on the laptop, the
    // phone sent the unnamed page back, so it was there twice.
    let p = setup("base-rename");
    write(&p.va.0, "Untitled.md", "lecture notes\n");
    sync(&p);
    assert_eq!(read(&p.vb.0, "Untitled.md"), "lecture notes\n");
    fs::rename(p.va.0.join("Untitled.md"), p.va.0.join("Cell biology.md")).expect("rename");
    let alice_id = bob_can_reach_alice(&p);
    assert!(wait_until(|| p.bob.status().peers[0].has_history));
    bob_syncs(&p, &alice_id);
    assert_eq!(names(&p.va.0), vec!["Cell biology.md"], "the old name did not come back");
    assert_eq!(names(&p.vb.0), vec!["Cell biology.md"], "and it is renamed on bob too");
}

#[test]
fn an_edit_on_the_device_that_started_the_syncs_is_not_a_conflict_when_the_other_starts_the_next() {
    // Reported: editing a page on the laptop and syncing made a conflict copy.
    let p = setup("base-edit");
    write(&p.va.0, "Week 3.md", "first line\n");
    sync(&p);
    write(&p.va.0, "Week 3.md", "first line\nsecond line\n");
    let alice_id = bob_can_reach_alice(&p);
    assert!(wait_until(|| p.bob.status().peers[0].has_history));
    let report = bob_syncs(&p, &alice_id);
    assert!(report.clashes.is_empty(), "{:?}", report.clashes);
    assert_eq!(names(&p.va.0), vec!["Week 3.md"], "no conflict copy");
    assert_eq!(read(&p.vb.0, "Week 3.md"), "first line\nsecond line\n");
}

#[test]
fn edits_on_both_devices_are_joined_when_the_answering_device_starts_the_next_sync() {
    // The page texts are kept on both sides too, so the answering device can join edits.
    let p = setup("base-join");
    write(&p.va.0, "Notes.md", "one\n\ntwo\n\nthree\n");
    sync(&p);
    write(&p.va.0, "Notes.md", "one changed\n\ntwo\n\nthree\n");
    write(&p.vb.0, "Notes.md", "one\n\ntwo\n\nthree changed\n");
    let alice_id = bob_can_reach_alice(&p);
    assert!(wait_until(|| p.bob.status().peers[0].has_history));
    bob_syncs(&p, &alice_id);
    assert_eq!(read(&p.vb.0, "Notes.md"), "one changed\n\ntwo\n\nthree changed\n");
    assert_eq!(read(&p.va.0, "Notes.md"), "one changed\n\ntwo\n\nthree changed\n");
    assert_eq!(names(&p.vb.0), vec!["Notes.md"], "no conflict copy");
}

#[test]
fn a_folder_removed_on_the_device_that_started_the_syncs_is_removed_when_the_other_starts_the_next() {
    let p = setup("base-folder");
    fs::create_dir_all(p.va.0.join("Old plans")).expect("folder");
    sync(&p);
    assert!(p.vb.0.join("Old plans").is_dir());
    fs::remove_dir(p.va.0.join("Old plans")).expect("remove");
    let alice_id = bob_can_reach_alice(&p);
    assert!(wait_until(|| p.bob.status().peers[0].has_history));
    bob_syncs(&p, &alice_id);
    assert!(!p.va.0.join("Old plans").exists(), "the folder did not come back");
    assert!(!p.vb.0.join("Old plans").exists());
}

#[test]
fn a_device_that_did_not_say_base_gets_no_list() {
    // An app before 0.6.9 would end the sync on a request it does not know.
    let p = setup("base-old");
    let bob_key = super::hex::decode::<{ super::identity::KEY_LEN }>(&p.bob_id).expect("key");
    super::service::read_hello_for_test(&p.alice, bob_key, b"0.6.8 shares=1");
    write(&p.va.0, "A.md", "a\n");
    // One sync: its greeting is known, so no hello first. (After the sync the real greeting is
    // asked again, and a 0.6.9 app would say `base=1` there.)
    sync(&p);
    std::thread::sleep(Duration::from_millis(300));
    assert!(!p.bob.status().peers[0].has_history, "no list was sent");
    assert_eq!(read(&p.vb.0, "A.md"), "a\n", "and the sync itself worked as before");
}

#[test]
fn the_answering_device_keeps_only_files_that_are_exactly_so_on_its_side() {
    let dir = Dir::new("base-keep");
    write(&dir.0, "Same.md", "same\n");
    write(&dir.0, "Changed here.md", "mine now\n");
    fs::create_dir_all(dir.0.join("Kept folder")).expect("folder");
    let mut said = super::exchange::own_listing(&dir.0).expect("listing");
    said.manifest.files.get_mut("Changed here.md").expect("file").hash = "0".repeat(64);
    said.manifest.files.insert("Not here.md".to_string(), said.manifest.files["Same.md"].clone());
    said.folders = Some(["Kept folder".to_string(), "Gone folder".to_string()].into());
    let key = [7u8; super::identity::KEY_LEN];
    super::engine::keep_own_base(&dir.0, &key, true, &said).expect("keep");
    let tag = &super::hex::encode(&key)[..16];
    let base = fs::read_to_string(dir.0.join(format!(".scalenote/sync-base-{tag}.txt"))).expect("base");
    let base = super::manifest::Manifest::from_text(&base).expect("parse");
    assert_eq!(base.files.keys().cloned().collect::<Vec<_>>(), vec!["Same.md"]);
    assert_eq!(super::foldersync::load(&dir.0, tag), Some(["Kept folder".to_string()].into()));
}
