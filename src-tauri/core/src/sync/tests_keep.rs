//! Tests for keeping only part of the vault on a device (0.6.0): two real services on loopback,
//! two real folders, the real encrypted connection, and the real keep rules from keep.rs.
//!
//! Alice is the device that keeps only part of the vault in most tests (think of a phone),
//! Bob keeps everything (think of a computer).

use super::engine::Outcome;
use super::exchange::{decode_listing, decode_listing_full, encode_listing_full, Listing};
use super::identity::Identity;
use super::keep::{self, KeepRules, Kinds};
use super::manifest::Manifest;
use super::service::Service;
use crate::vault::{Vault, VaultError};
use std::fs;
use std::path::{Path, PathBuf};

struct Dir(PathBuf);

impl Dir {
    fn new(label: &str) -> Dir {
        let path = std::env::temp_dir().join(format!("sn-keep-{label}-{}", std::process::id()));
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
    va: Dir,
    vb: Dir,
    bob_id: String,
    alice_id: String,
    _dirs: (Dir, Dir),
}

fn setup(label: &str) -> Pair {
    setup_on(label, None)
}

/// Like `setup`, with discovery notes on a loopback port both hear (for people nearby).
fn setup_on(label: &str, route: Option<super::discovery::Route>) -> Pair {
    let (da, db) = (Dir::new(&format!("{label}-da")), Dir::new(&format!("{label}-db")));
    let (va, vb) = (Dir::new(&format!("{label}-va")), Dir::new(&format!("{label}-vb")));
    let make = |dir: &Dir, name: &str| {
        let service = Service::with_bind(&dir.0, Identity::generate().expect("identity"), name, true, "127.0.0.1", 0).expect("service");
        if let Some(route) = &route {
            service.set_route(route.clone());
        }
        service
    };
    let (alice, bob) = (make(&da, "alice"), make(&db, "bob"));
    let code = bob.start_pairing().expect("code");
    let address = format!("127.0.0.1:{}", bob.status().listening_port.expect("listening"));
    alice.join(&address, &code).expect("pair");
    alice.set_vault(Some(va.0.clone()));
    bob.set_vault(Some(vb.0.clone()));
    let bob_id = alice.status().peers[0].id.clone();
    let alice_id = bob.status().peers[0].id.clone();
    Pair { alice, bob, va, vb, bob_id, alice_id, _dirs: (da, db) }
}

fn write(root: &Path, relative: &str, text: &str) {
    let path = root.join(relative);
    fs::create_dir_all(path.parent().expect("parent")).expect("folders");
    fs::write(path, text).expect("write");
}

fn names(root: &Path) -> Vec<String> {
    Manifest::scan(root).expect("scan").manifest.files.keys().filter(|p| !p.starts_with('.')).cloned().collect()
}

fn done(outcome: Outcome) -> super::engine::Report {
    match outcome {
        Outcome::Done(report) => report,
        Outcome::NeedsApproval(_) => panic!("approval was given"),
    }
}

/// Alice starts the sync.
fn sync(p: &Pair) -> super::engine::Report {
    done(p.alice.sync_peer(&p.bob_id, true, &mut |_| {}).expect("sync from alice"))
}

/// Bob starts the sync (he keeps his own saved list of what both had). Bob has never heard where
/// Alice listens (on loopback nobody announces), so the connection is opened to her port here
/// and the real engine runs on it, exactly as `sync_peer` would.
fn sync_from_bob(p: &Pair) -> super::engine::Report {
    // The answering side finishes its side of the last connection a moment after the goodbye.
    std::thread::sleep(std::time::Duration::from_millis(100));
    let port = p.alice.status().listening_port.expect("alice listens");
    let stream = std::net::TcpStream::connect(("127.0.0.1", port)).expect("connect");
    let mut channel = super::channel::Channel::connect(stream, p.bob.identity_for_tests()).expect("channel");
    let alice_key = super::hex::decode::<{ super::identity::KEY_LEN }>(&p.alice_id).expect("key");
    let pair = super::engine::Pair { root: &p.vb.0, peer_key: &alice_key, own_name: "bob", peer_name: "alice", today: "2026-11-24", shares: true, map: None };
    done(super::engine::run(&mut channel, &pair, true, &mut |_| {}).expect("sync from bob"))
}

fn choose(root: &Path, choices: &[(&str, &str)]) {
    let mut rules = KeepRules::load(root);
    for (path, letters) in choices {
        rules.set(path, Some(Kinds::from_letters(letters).expect("letters"))).expect("set");
    }
    rules.save(root).expect("save choices");
}

fn trash_has(root: &Path) -> bool {
    Vault::open(root).expect("vault").trash_list().expect("trash").iter().next().is_some()
}

#[test]
fn a_device_keeping_one_folder_gets_only_that_folder_and_the_other_device_loses_nothing() {
    let p = setup("one-folder");
    choose(&p.va.0, &[("", "-"), ("Uni", "tdif")]);
    write(&p.vb.0, "Uni/Cells.md", "cells");
    write(&p.vb.0, "Uni/Cells.canvas.json", "{}");
    write(&p.vb.0, "Home/Shopping.md", "milk");
    write(&p.vb.0, "Home/Shopping.canvas.json", "{}");
    let preview = p.alice.compare_peer(&p.bob_id).expect("compare");
    assert_eq!(preview.summary.pull, 2);
    assert_eq!(preview.not_kept_here, 2, "the preview says what is left alone");
    let report = sync(&p);
    assert_eq!(report.received, 2);
    assert_eq!(names(&p.va.0), ["Uni/Cells.canvas.json", "Uni/Cells.md"]);
    // The next syncs, from either side, change nothing: the files Alice does not keep are not
    // read as deleted on her side.
    assert_eq!(sync(&p).changed(), 0);
    assert_eq!(sync_from_bob(&p).changed(), 0);
    assert_eq!(names(&p.vb.0).len(), 4);
    assert!(!trash_has(&p.vb.0), "nothing went to Bob's trash");
    // Alice knows what exists elsewhere, for the page list.
    let elsewhere = keep::not_here(&p.va.0).expect("not here");
    assert!(elsewhere.contains("Home/Shopping.md") && elsewhere.contains("Home/Shopping.canvas.json"));
}

#[test]
fn text_only_keeps_pages_and_pictures_come_only_where_a_page_that_keeps_pictures_links_them() {
    let p = setup("text-only");
    choose(&p.va.0, &[("", "t"), ("Uni", "ti")]);
    write(&p.vb.0, "Uni/Cells.md", "![](attachments/cell.png)");
    write(&p.vb.0, "Home/Trip.md", "![](attachments/beach.png)");
    write(&p.vb.0, "Home/Trip.canvas.json", "{}");
    write(&p.vb.0, "attachments/cell.png", "png1");
    write(&p.vb.0, "attachments/cell.png.text.json", "{\"words\":[]}");
    write(&p.vb.0, "attachments/beach.png", "png2");
    write(&p.vb.0, "attachments/book.pdf", "pdf");
    sync(&p);
    assert_eq!(names(&p.va.0), ["Home/Trip.md", "Uni/Cells.md"], "first the pages");
    // Now Cells.md is here and links its picture, so the next sync brings it (and its words).
    sync(&p);
    assert_eq!(names(&p.va.0), ["Home/Trip.md", "Uni/Cells.md", "attachments/cell.png", "attachments/cell.png.text.json"]);
    assert_eq!(sync(&p).changed(), 0);
    assert_eq!(sync_from_bob(&p).changed(), 0);
    assert_eq!(names(&p.vb.0).len(), 7, "Bob keeps everything");
}

#[test]
fn freeing_space_removes_only_files_another_device_has_and_they_are_not_deleted_there() {
    let p = setup("free");
    write(&p.vb.0, "Home/Shopping.md", "milk");
    write(&p.vb.0, "Uni/Cells.md", "cells");
    sync(&p);
    // Bob starts a sync too, so he has his own saved list in which Alice has Home/Shopping.md.
    sync_from_bob(&p);
    write(&p.va.0, "Home/New idea.md", "only on alice");
    choose(&p.va.0, &[("Home", "-")]);
    let freed = keep::free_up_space(&p.va.0).expect("free");
    assert_eq!(freed.removed, ["Home/Shopping.md"]);
    assert_eq!(freed.only_here, ["Home/New idea.md"], "a page no other device has yet stays");
    assert_eq!(freed.bytes, 4);
    // Neither side reads the removed page as deleted.
    assert_eq!(sync(&p).deleted_there, 0);
    assert_eq!(sync_from_bob(&p).deleted_here, 0);
    assert!(p.vb.0.join("Home/Shopping.md").is_file());
    assert!(!trash_has(&p.vb.0));
    // The new page has reached Bob now, so it can go from Alice too.
    assert!(p.vb.0.join("Home/New idea.md").is_file());
    let again = keep::free_up_space(&p.va.0).expect("free again");
    assert_eq!(again.removed, ["Home/New idea.md"]);
    assert_eq!(sync(&p).changed(), 0);
    assert_eq!(sync_from_bob(&p).changed(), 0);
    assert_eq!(names(&p.vb.0), ["Home/New idea.md", "Home/Shopping.md", "Uni/Cells.md"]);
}

#[test]
fn a_file_changed_since_the_last_sync_is_never_freed() {
    let p = setup("changed");
    write(&p.vb.0, "Home/Shopping.md", "milk");
    sync(&p);
    write(&p.va.0, "Home/Shopping.md", "milk and eggs");
    choose(&p.va.0, &[("Home", "-")]);
    let freed = keep::free_up_space(&p.va.0).expect("free");
    assert!(freed.removed.is_empty());
    assert_eq!(freed.only_here, ["Home/Shopping.md"]);
    assert_eq!(fs::read_to_string(p.va.0.join("Home/Shopping.md")).expect("still here"), "milk and eggs");
    // The edit still syncs: a file that is here is synced like any other.
    assert_eq!(sync(&p).sent, 1);
    assert_eq!(fs::read_to_string(p.vb.0.join("Home/Shopping.md")).expect("bob"), "milk and eggs");
}

#[test]
fn keeping_a_folder_again_brings_its_files_back() {
    let p = setup("back");
    write(&p.vb.0, "Home/Shopping.md", "milk");
    sync(&p);
    choose(&p.va.0, &[("Home", "-")]);
    keep::free_up_space(&p.va.0).expect("free");
    assert!(!p.va.0.join("Home/Shopping.md").exists());
    choose(&p.va.0, &[("Home", "tdif")]);
    let report = sync(&p);
    assert_eq!((report.received, report.deleted_there), (1, 0));
    assert_eq!(fs::read_to_string(p.va.0.join("Home/Shopping.md")).expect("back"), "milk");
    assert!(keep::load_removed(&p.va.0).is_empty(), "it is off the removed list once it is back");
}

#[test]
fn deleting_a_page_this_device_keeps_still_reaches_the_other_device() {
    let p = setup("delete");
    choose(&p.va.0, &[("", "t")]);
    write(&p.vb.0, "Old.md", "bye");
    write(&p.vb.0, "Old.canvas.json", "{}");
    sync(&p);
    assert_eq!(names(&p.va.0), ["Old.md"]);
    fs::remove_file(p.va.0.join("Old.md")).expect("delete");
    let report = sync(&p);
    assert_eq!(report.deleted_there, 1);
    assert!(!p.vb.0.join("Old.md").exists() && trash_has(&p.vb.0), "it went to Bob's trash");
    assert!(p.vb.0.join("Old.canvas.json").exists(), "the drawing Alice never had is left alone");
}

#[test]
fn two_devices_that_each_keep_a_part_only_exchange_what_both_keep() {
    let p = setup("two-parts");
    choose(&p.va.0, &[("", "-"), ("Uni", "tdif"), ("Shared", "tdif")]);
    choose(&p.vb.0, &[("", "-"), ("Home", "tdif"), ("Shared", "tdif")]);
    write(&p.va.0, "Uni/Cells.md", "cells");
    write(&p.va.0, "Shared/Both.md", "from alice");
    write(&p.vb.0, "Home/Shopping.md", "milk");
    write(&p.vb.0, "Shared/Also.md", "from bob");
    let report = sync(&p);
    assert_eq!((report.sent, report.received, report.changed()), (1, 1, 2));
    assert_eq!(names(&p.va.0), ["Shared/Also.md", "Shared/Both.md", "Uni/Cells.md"]);
    assert_eq!(names(&p.vb.0), ["Home/Shopping.md", "Shared/Also.md", "Shared/Both.md"]);
    assert_eq!(sync(&p).changed(), 0);
    assert_eq!(sync_from_bob(&p).changed(), 0);
}

#[test]
fn a_folder_or_page_with_files_not_here_cannot_be_renamed_moved_or_deleted() {
    let p = setup("rename");
    choose(&p.va.0, &[("Home", "-"), ("Uni", "t")]);
    write(&p.vb.0, "Home/Shopping.md", "milk");
    write(&p.vb.0, "Uni/Cells.md", "cells");
    write(&p.vb.0, "Uni/Cells.canvas.json", "{}");
    write(&p.vb.0, "School/Plan.md", "plan");
    sync(&p);
    fs::create_dir_all(p.va.0.join("Home")).expect("the folder is still listed here");
    let vault = Vault::open(&p.va.0).expect("vault");
    assert_eq!(vault.rename("Home", "House"), Err(VaultError::NotAllHere));
    assert_eq!(vault.move_entry("Home", "School").err(), Some(VaultError::NotAllHere));
    assert_eq!(vault.move_to_trash("Home").err(), Some(VaultError::NotAllHere));
    assert_eq!(vault.rename("Uni/Cells.md", "Cell").err(), Some(VaultError::NotAllHere), "its drawing is not here");
    assert_eq!(vault.rename("School", "Studies"), Ok("Studies".to_string()), "a folder that is all here can be renamed");
    // A device that keeps everything is never stopped.
    let bob_vault = Vault::open(&p.vb.0).expect("vault");
    assert_eq!(bob_vault.rename("Home", "House"), Ok("House".to_string()));
}

#[test]
fn an_older_app_reads_removed_files_as_left_out_and_newer_ones_read_the_choices() {
    let mut manifest = Manifest::default();
    manifest.files.insert("Uni/Cells.md".to_string(), super::manifest::FileState { hash: "a".repeat(64), size: 1, modified: 0 });
    let mut rules = KeepRules::default();
    rules.set("", Some(Kinds::from_letters("t").expect("t"))).expect("set");
    rules.set("Uni", Some(Kinds::ALL)).expect("set");
    rules.linked.insert("attachments/cell.png".to_string());
    let listing = Listing {
        manifest,
        skipped: ["Big.pdf".to_string()].into(),
        not_kept: ["Home/Shopping.md".to_string()].into(),
        rules,
    };
    let body = encode_listing_full(&listing);
    assert_eq!(decode_listing_full(&body).expect("new"), listing);
    // What an app before 0.6 sees (the same reading as its decoder): the removed file is
    // simply one more skipped name, and the choice lines are not paths, so they are dropped.
    let (_, skipped) = decode_listing(&body).expect("old view");
    assert_eq!(skipped.into_iter().collect::<Vec<_>>(), ["Big.pdf", "Home/Shopping.md"]);
    // The decoder of 0.5.x, line for line: the text after the manifest, safe paths only.
    let length: usize = std::str::from_utf8(&body[..8]).expect("digits").parse().expect("length");
    let old_style: Vec<&str> = std::str::from_utf8(&body[8 + length..]).expect("text").lines().filter(|l| super::manifest::safe_path(l)).collect();
    assert_eq!(old_style, ["Big.pdf", "Home/Shopping.md"]);
    // A damaged choice line from another device ends the sync instead of being guessed.
    let mut bad = body.clone();
    bad.extend_from_slice(b"/keep zz Uni\n");
    assert!(decode_listing_full(&bad).is_err());
    let mut escape = body;
    escape.extend_from_slice(b"/keep t ../outside\n");
    assert!(decode_listing_full(&escape).is_err());
}

#[test]
fn folder_colours_from_both_devices_are_kept_after_a_sync_from_either_side() {
    let p = setup("colours");
    let colours = |icons: &str| format!("{{\"format\":1,\"icons\":{{{icons}}}}}");
    write(&p.va.0, ".scalenote/folder-icons.json", &colours(r#""Cytology":{"style":"folder","colour":"blue"},"Histology":{"style":"folder","colour":"green"}"#));
    write(&p.va.0, "Cytology/Lesson 1.md", "cells");
    // Bob's file is newer and has none of Alice's colours: it used to win whole.
    std::thread::sleep(std::time::Duration::from_millis(1100));
    write(&p.vb.0, ".scalenote/folder-icons.json", &colours(r#""Immunology":{"style":"notebook","colour":"red"}"#));
    sync(&p);
    let read = |root: &Path| fs::read_to_string(root.join(".scalenote/folder-icons.json")).expect("colours");
    for root in [&p.va.0, &p.vb.0] {
        let text = read(root);
        for name in ["Cytology", "Histology", "Immunology"] {
            assert!(text.contains(name), "{name} lost: {text}");
        }
    }
    assert_eq!(read(&p.va.0), read(&p.vb.0));
    // Later Bob removes a colour; that removal comes through (the last synced file is known).
    write(&p.vb.0, ".scalenote/folder-icons.json", &colours(r#""Cytology":{"style":"folder","colour":"blue"},"Immunology":{"style":"notebook","colour":"red"}"#));
    sync(&p);
    assert!(!read(&p.va.0).contains("Histology"));
    assert!(read(&p.va.0).contains("Cytology"));
    assert_eq!(sync_from_bob(&p).changed(), 0);
}

#[test]
fn repeated_syncs_that_change_nothing_leave_one_activity_line() {
    use super::service::EventKind;
    let p = setup("quiet");
    write(&p.vb.0, "Note.md", "hello");
    sync(&p);
    sync(&p);
    sync(&p);
    let synced: Vec<usize> = p.alice.status().events.iter().filter(|e| e.kind == EventKind::Synced).map(|e| e.changed).collect();
    assert_eq!(synced, [1, 0], "one line for the sync that changed something, one for the quiet ones");
}

#[test]
fn a_page_that_is_not_here_is_brought_with_its_drawing_and_pictures_and_stays_a_normal_file() {
    let p = setup("fetch");
    choose(&p.va.0, &[("Home", "-")]);
    write(&p.vb.0, "Home/Trip.md", "![](attachments/beach.png)");
    write(&p.vb.0, "Home/Trip.canvas.json", "{}");
    write(&p.vb.0, "attachments/beach.png", "png");
    write(&p.vb.0, "attachments/beach.png.text.json", "{}");
    write(&p.vb.0, "Home/Other.md", "not asked for");
    choose(&p.va.0, &[("attachments", "-")]);
    sync(&p);
    assert!(names(&p.va.0).is_empty(), "nothing of Home or attachments is kept here");
    assert!(keep::not_here(&p.va.0).expect("not here").contains("Home/Trip.md"));
    let mut got = p.alice.fetch_files(&["Home/Trip.md".to_string()]).expect("fetch");
    got.sort();
    assert_eq!(got, ["Home/Trip.canvas.json", "Home/Trip.md", "attachments/beach.png", "attachments/beach.png.text.json"]);
    assert_eq!(fs::read_to_string(p.va.0.join("Home/Trip.md")).expect("page"), "![](attachments/beach.png)");
    assert!(!keep::not_here(&p.va.0).expect("not here").contains("Home/Trip.md"));
    // The page is here now and syncs like any other; nothing is changed on Bob's side.
    assert_eq!(sync(&p).changed(), 0);
    assert_eq!(names(&p.vb.0).len(), 5);
    // Asking for something no device has is refused calmly.
    assert!(p.alice.fetch_files(&["Nowhere.md".to_string()]).is_err());
}

#[test]
fn switching_a_folder_off_frees_what_another_device_has_and_back_on_brings_it_with_the_next_sync() {
    let p = setup("switch");
    write(&p.vb.0, "Home/Shopping.md", "milk");
    sync(&p);
    let freed = keep::set_choice(&p.va.0, "Home", Some("-")).expect("off");
    assert_eq!(freed.removed, ["Home/Shopping.md"]);
    assert_eq!(keep::choices(&p.va.0), [("Home".to_string(), "-".to_string())]);
    assert!(keep::set_choice(&p.va.0, "Home", Some("zz")).is_err());
    keep::set_choice(&p.va.0, "Home", None).expect("back to following the folder above");
    assert!(keep::choices(&p.va.0).is_empty());
    assert_eq!(sync(&p).received, 1);
}

#[test]
fn a_page_changed_on_both_devices_in_different_places_is_joined_and_a_clash_keeps_both() {
    let p = setup("join");
    write(&p.vb.0, "Cells.md", "Cells have a membrane.\nThe nucleus holds DNA.\n");
    sync(&p);
    write(&p.va.0, "Cells.md", "Cells have a thin membrane.\nThe nucleus holds DNA.\n");
    write(&p.vb.0, "Cells.md", "Cells have a membrane.\nThe nucleus holds the DNA.\n");
    let report = sync(&p);
    assert_eq!((report.merged, report.conflicts), (1, 0));
    let joined = "Cells have a thin membrane.\nThe nucleus holds the DNA.\n";
    assert_eq!(fs::read_to_string(p.va.0.join("Cells.md")).expect("alice"), joined);
    assert_eq!(fs::read_to_string(p.vb.0.join("Cells.md")).expect("bob"), joined);
    assert_eq!(names(&p.va.0), ["Cells.md"], "no conflict copy");
    // The joined text is now what both had last: the next edits join against it.
    write(&p.va.0, "Cells.md", "Cells have a thin membrane.\nThe nucleus holds the DNA.\nMitochondria make energy.\n");
    write(&p.vb.0, "Cells.md", "Animal cells have a thin membrane.\nThe nucleus holds the DNA.\n");
    assert_eq!(sync(&p).merged, 1);
    assert_eq!(fs::read_to_string(p.vb.0.join("Cells.md")).expect("bob"), "Animal cells have a thin membrane.\nThe nucleus holds the DNA.\nMitochondria make energy.\n");
    // Both changing the same words still keeps both versions.
    write(&p.va.0, "Cells.md", "Plant cells have a thin membrane.\n");
    std::thread::sleep(std::time::Duration::from_millis(20));
    write(&p.vb.0, "Cells.md", "Animal cells have a wall.\n");
    let report = sync(&p);
    assert_eq!((report.merged, report.conflicts), (0, 1));
    assert_eq!(names(&p.va.0).len(), 2, "the page and its conflict copy");
}

#[test]
fn a_findable_person_is_heard_nearby_and_a_paired_device_takes_the_same_account() {
    let port = std::net::UdpSocket::bind("127.0.0.1:0").expect("free port").local_addr().expect("addr").port();
    let at = std::net::SocketAddr::from(([127, 0, 0, 1], port));
    let route = super::discovery::Route { listen: at, join_group: false, send_to: vec![at], interval: std::time::Duration::from_millis(200) };
    let p = setup_on("people", Some(route));
    assert!(p.alice.set_findable(true).is_err(), "a name is needed first");
    let account = p.alice.set_account_name("  Rowan ").expect("name");
    assert_eq!(account.name, "Rowan");
    // Not findable yet: nobody hears a name.
    assert!(p.bob.people_nearby(std::time::Duration::from_millis(1500)).expect("listen").is_empty());
    p.alice.set_findable(true).expect("findable");
    let heard = p.bob.people_nearby(std::time::Duration::from_millis(2500)).expect("listen");
    assert_eq!(heard.iter().map(|person| person.name.as_str()).collect::<Vec<_>>(), ["Rowan"]);
    assert_eq!(Some(heard[0].account), account.id);
    // After a sync the paired device has the same account, so Rowan no longer counts as someone else.
    write(&p.va.0, "Note.md", "hi");
    sync(&p);
    std::thread::sleep(std::time::Duration::from_millis(300));
    assert_eq!(p.bob.account().id, account.id);
    assert_eq!(p.bob.account().name, "Rowan");
    assert!(p.bob.people_nearby(std::time::Duration::from_millis(2000)).expect("listen").is_empty());
}

#[test]
fn the_list_of_shares_goes_only_to_devices_that_know_it_and_is_merged_share_by_share() {
    use super::account::{Account, ID_LEN};
    use super::shares::{Shares, State, SHARES_FILE};
    let p = setup("shares-file");
    let me = Account { id: Some([1; ID_LEN]), name: "Rowan".to_string(), findable: false };
    let mut list = Shares::default();
    let first = list.offer(&me, &[], "Biology", true, [2; ID_LEN], "Mila").expect("offer");
    list.save(&p.va.0).expect("save");
    // Before the devices have greeted each other, neither knows the other reads the list (an
    // app before 0.6.4 would refuse it), so it stays here.
    sync(&p);
    assert!(!p.vb.0.join(SHARES_FILE).exists(), "not sent to a device that did not say it knows the file");
    // After the sync they said hello (and `shares=1`); now it goes along.
    sync(&p);
    assert_eq!(Shares::load(&p.vb.0).expect("bob's list"), list);
    // Each device changes another share: both changes are kept.
    let mut here = Shares::load(&p.va.0).expect("list");
    here.offer(&me, &[], "Chemistry.md", false, [2; ID_LEN], "Mila").expect("offer");
    here.save(&p.va.0).expect("save");
    let mut there = Shares::load(&p.vb.0).expect("list");
    there.accepted(&first, [2; ID_LEN], &[[9; super::identity::KEY_LEN]]).expect("accepted");
    there.save(&p.vb.0).expect("save");
    sync(&p);
    for root in [&p.va.0, &p.vb.0] {
        let merged = Shares::load(root).expect("merged list");
        assert_eq!(merged.list.len(), 2);
        assert_eq!(merged.list[&first].state, State::Active);
    }
    assert!(names(&p.va.0).is_empty(), "no conflict copies, no pages made");
}

#[test]
fn a_person_nearby_is_invited_accepts_and_a_device_that_will_not_be_found_is_not_invited() {
    use super::shares::State;
    let port = std::net::UdpSocket::bind("127.0.0.1:0").expect("free port").local_addr().expect("addr").port();
    let at = std::net::SocketAddr::from(([127, 0, 0, 1], port));
    let route = super::discovery::Route { listen: at, join_group: false, send_to: vec![at], interval: std::time::Duration::from_millis(200) };
    // Rowan has two paired devices (alice, bob); Mila has one, paired with nothing.
    let p = setup_on("invite", Some(route.clone()));
    let (dm, vm) = (Dir::new("invite-dm"), Dir::new("invite-vm"));
    let mila = Service::with_bind(&dm.0, Identity::generate().expect("identity"), "tablet", true, "127.0.0.1", 0).expect("service");
    mila.set_route(route.clone());
    mila.set_vault(Some(vm.0.clone()));
    assert_eq!(mila.status().listening_port, None, "nothing paired and no name: silent");
    let rowan = p.alice.set_account_name("Rowan").expect("name");
    let me = mila.set_account_name("Mila").expect("name");
    assert!(mila.status().listening_port.is_some(), "a name: listens for invitations");
    mila.set_findable(true).expect("findable");
    write(&p.va.0, "Biology/Cells.md", "cells");
    write(&vm.0, "Shared with me/Rowan/Biology/Old.md", "a folder of that name is already here");

    let heard = p.alice.people_nearby(std::time::Duration::from_millis(2500)).expect("listen");
    let mila_id = heard.iter().find(|person| person.name == "Mila").map(|person| person.account).expect("Mila heard");
    assert_eq!(Some(mila_id), me.id);
    let id = p.alice.share_with("Biology", true, &mila_id).expect("invitation delivered");
    let theirs = mila.shares().expect("list");
    assert_eq!(theirs.list[&id].state, State::Invited);
    assert_eq!(theirs.list[&id].path, "Shared with me/Rowan/Biology 2", "an existing folder is not mixed in");
    let bob_key = super::hex::decode::<{ super::identity::KEY_LEN }>(&p.bob_id).expect("key");
    assert!(theirs.list[&id].people[&rowan.id.expect("id")].keys.contains(&bob_key), "Rowan's other device is named in the share");
    assert_eq!(p.alice.shares().expect("list").list[&id].state, State::Offered);

    assert!(mila.answer_invitation(&id, true).expect("answer"), "Rowan's device heard the answer");
    let mine = mila.shares().expect("list");
    assert_eq!((mine.list[&id].state, mine.list[&id].told), (State::Active, true));
    let owner = p.alice.shares().expect("list");
    assert_eq!(owner.list[&id].state, State::Active);
    assert!(owner.list[&id].people[&mila_id].keys.len() == 1, "Mila's tablet is in the share");
    assert!(mila.answer_invitation(&id, false).is_err(), "answered once");
    // Rowan's other device gets the share with the next syncs of his own devices.
    sync(&p);
    sync(&p);
    assert_eq!(super::shares::Shares::load(&p.vb.0).expect("bob").list[&id].state, State::Active);

    // A second share that Mila declines is forgotten on Rowan's side.
    write(&p.va.0, "Chemistry.md", "atoms");
    let second = p.alice.share_with("Chemistry.md", false, &mila_id).expect("second invitation");
    assert!(mila.answer_invitation(&second, false).expect("answer"));
    assert!(!p.alice.shares().expect("list").list.contains_key(&second));

    // Someone who was findable and then switched it off takes no invitations.
    let (dc, vc) = (Dir::new("invite-dc"), Dir::new("invite-vc"));
    let carol = Service::with_bind(&dc.0, Identity::generate().expect("identity"), "laptop", true, "127.0.0.1", 0).expect("service");
    carol.set_route(route);
    carol.set_vault(Some(vc.0.clone()));
    carol.set_account_name("Carol").expect("name");
    carol.set_findable(true).expect("findable");
    let carol_id = p.alice.people_nearby(std::time::Duration::from_millis(2500)).expect("listen").into_iter().find(|person| person.name == "Carol").map(|person| person.account).expect("Carol heard");
    carol.set_findable(false).expect("not findable");
    assert!(p.alice.share_with("Chemistry.md", false, &carol_id).is_err());
    assert!(carol.shares().expect("list").list.is_empty());
    assert!(!p.alice.shares().expect("list").list.values().any(|s| s.path == "Chemistry.md"), "the undelivered offer is taken back");
}

#[test]
fn invitations_and_answers_from_strangers_that_do_not_fit_are_refused_and_change_nothing() {
    use super::invite::{Answer, Invitation, KIND_INVITE, KIND_INVITE_ANSWER, KIND_INVITE_OK, MAX_PER_MINUTE};
    let (dm, vm) = (Dir::new("stranger-dm"), Dir::new("stranger-vm"));
    let mila = Service::with_bind(&dm.0, Identity::generate().expect("identity"), "tablet", true, "127.0.0.1", 0).expect("service");
    mila.set_vault(Some(vm.0.clone()));
    let me = mila.set_account_name("Mila").expect("name").id.expect("id");
    mila.set_findable(true).expect("findable");
    let port = mila.status().listening_port.expect("listens");
    let stranger = Identity::generate().expect("identity");
    let send = |kind: u8, body: Vec<u8>| -> Option<u8> {
        let stream = std::net::TcpStream::connect(("127.0.0.1", port)).ok()?;
        let mut channel = super::channel::Channel::connect(stream, &stranger).ok()?;
        let mut message = vec![kind];
        message.extend_from_slice(&body);
        channel.send(&message).ok()?;
        channel.recv().ok()?.first().copied()
    };
    let invitation = |to| Invitation { id: [5; 16], item: "Notes".to_string(), folder: true, owner: [9; 16], owner_name: "Eve".to_string(), keys: vec![], to, port: 1 };
    assert_ne!(send(KIND_INVITE, invitation([4; 16]).encode()), Some(KIND_INVITE_OK), "meant for someone else");
    assert_ne!(send(KIND_INVITE, b"{\"item\":\"../../x\"}".to_vec()), Some(KIND_INVITE_OK));
    let answer = Answer { id: [5; 16], account: [9; 16], name: "Eve".to_string(), accept: true, keys: vec![] };
    assert_ne!(send(KIND_INVITE_ANSWER, answer.encode()), Some(KIND_INVITE_OK), "an answer for a share that is not hers");
    assert!(mila.shares().expect("list").list.is_empty());
    // A fitting one is taken, but a flood is cut off.
    assert_eq!(send(KIND_INVITE, invitation(me).encode()), Some(KIND_INVITE_OK));
    for _ in 0..MAX_PER_MINUTE {
        send(KIND_INVITE, invitation(me).encode());
    }
    assert_ne!(send(KIND_INVITE, invitation(me).encode()), Some(KIND_INVITE_OK), "too many in a minute");
    assert_eq!(mila.shares().expect("list").list.len(), 1, "the same invitation is kept once");
    assert!(names(&vm.0).is_empty(), "no file is made by an invitation");
}

/// Rowan (alice and bob, paired) shares the folder `Biology` with Mila (one device, not paired
/// with his), who accepts. Returns the pair, Mila's service and folders, and the share id.
fn shared_biology(label: &str) -> (Pair, Service, Dir, Dir, [u8; 16]) {
    let port = std::net::UdpSocket::bind("127.0.0.1:0").expect("free port").local_addr().expect("addr").port();
    let at = std::net::SocketAddr::from(([127, 0, 0, 1], port));
    let route = super::discovery::Route { listen: at, join_group: false, send_to: vec![at], interval: std::time::Duration::from_millis(200) };
    let p = setup_on(label, Some(route.clone()));
    let (dm, vm) = (Dir::new(&format!("{label}-dm")), Dir::new(&format!("{label}-vm")));
    let mila = Service::with_bind(&dm.0, Identity::generate().expect("identity"), "tablet", true, "127.0.0.1", 0).expect("service");
    mila.set_route(route);
    mila.set_vault(Some(vm.0.clone()));
    p.alice.set_account_name("Rowan").expect("name");
    let mila_id = mila.set_account_name("Mila").expect("name").id.expect("id");
    mila.set_findable(true).expect("findable");
    p.alice.people_nearby(std::time::Duration::from_millis(2000)).expect("listen");
    let id = p.alice.share_with("Biology", true, &mila_id).expect("invite");
    assert!(mila.answer_invitation(&id, true).expect("accept"));
    (p, mila, dm, vm, id)
}

fn ok_with(results: &[super::service::ShareResult], person: &str) -> super::engine::Report {
    let found = results.iter().find(|r| r.person == person).unwrap_or_else(|| panic!("no result for {person}"));
    found.outcome.clone().unwrap_or_else(|code| panic!("share sync with {person}: {code}"))
}

#[test]
fn a_shared_folder_syncs_both_ways_joins_edits_and_never_shows_anything_else() {
    let (p, mila, _dm, vm, id) = shared_biology("share-sync");
    write(&p.va.0, "Biology/Cells.md", "Cells have a membrane.\n![](attachments/cell.png)\nThe nucleus holds DNA.\n");
    write(&p.va.0, "attachments/cell.png", "png");
    write(&p.va.0, "attachments/private.png", "not linked from the share");
    write(&p.va.0, "Diary.md", "private");
    let here = "Shared with me/Rowan/Biology";

    // Mila's tablet starts: it gets the folder and the picture its page links to, nothing else.
    let results = mila.sync_share(&id).expect("sync");
    assert_eq!(ok_with(&results, "Rowan").received, 2);
    assert_eq!(names(&vm.0), ["Shared with me/Rowan/Biology/Cells.md", "attachments/cell.png"]);

    // Both change the page in different places, and Mila adds a page: joined and sent.
    write(&p.va.0, "Biology/Cells.md", "Cells have a thin membrane.\n![](attachments/cell.png)\nThe nucleus holds DNA.\n");
    write(&vm.0, &format!("{here}/Cells.md"), "Cells have a membrane.\n![](attachments/cell.png)\nThe nucleus holds the DNA.\n");
    write(&vm.0, &format!("{here}/Week 2/Tissues.md"), "tissues");
    let report = ok_with(&p.alice.sync_share(&id).expect("sync"), "Mila");
    assert_eq!(report.merged, 1);
    let joined = "Cells have a thin membrane.\n![](attachments/cell.png)\nThe nucleus holds the DNA.\n";
    assert_eq!(fs::read_to_string(p.va.0.join("Biology/Cells.md")).expect("rowan"), joined);
    assert_eq!(fs::read_to_string(vm.0.join(format!("{here}/Cells.md"))).expect("mila"), joined);
    assert_eq!(fs::read_to_string(p.va.0.join("Biology/Week 2/Tissues.md")).expect("new page"), "tissues");

    // Rowan's other device gets the share and its pages from his own sync, then syncs the share
    // with Mila directly.
    sync(&p);
    sync(&p);
    write(&p.vb.0, "Biology/From laptop.md", "hello");
    ok_with(&p.bob.sync_share(&id).expect("sync"), "Mila");
    assert!(vm.0.join(format!("{here}/From laptop.md")).is_file());

    // Removing a page in the share moves it to the other person's trash, never further.
    fs::remove_file(vm.0.join(format!("{here}/Week 2/Tissues.md"))).expect("remove");
    ok_with(&mila.sync_share(&id).expect("sync"), "Rowan");
    let rowan_has: Vec<String> = names(&p.va.0).into_iter().filter(|n| n.contains("Tissues")).collect();
    assert!(rowan_has.is_empty(), "gone from Rowan's folder: {rowan_has:?}");
    assert!(trash_has(&p.va.0) || trash_has(&p.vb.0), "it is in a trash");
    assert!(!vm.0.join("Diary.md").exists() && !vm.0.join("attachments/private.png").exists());
}

#[test]
fn a_share_connection_from_a_stranger_or_for_something_outside_the_share_gets_nothing() {
    use super::exchange::{send_blob, KIND_GET, KIND_FILE, KIND_LIST, KIND_LISTING};
    use super::invite::{KIND_INVITE_OK, KIND_SHARE_OPEN};
    let (p, mila, _dm, _vm, id) = shared_biology("share-strangers");
    write(&p.va.0, "Biology/Cells.md", "cells");
    write(&p.va.0, "Diary.md", "private");
    let port = p.alice.status().listening_port.expect("listens");
    let open = |identity: &Identity| {
        let stream = std::net::TcpStream::connect(("127.0.0.1", port)).expect("connect");
        let mut channel = super::channel::Channel::connect(stream, identity).expect("channel");
        let mut message = vec![KIND_SHARE_OPEN];
        message.extend_from_slice(&id);
        channel.send(&message).expect("send");
        let answer = channel.recv().ok().and_then(|a| a.first().copied());
        (channel, answer)
    };
    let stranger = Identity::generate().expect("identity");
    assert_ne!(open(&stranger).1, Some(KIND_INVITE_OK), "a device not in the share");
    // Mila's own device is let in, but only sees the share.
    let (mut channel, answer) = open(mila.identity_for_tests());
    assert_eq!(answer, Some(KIND_INVITE_OK));
    send_blob(&mut channel, KIND_LIST, &[], &[]).expect("list");
    let listing = super::exchange::recv_blob(&mut channel, super::exchange::MAX_LISTING_BYTES).expect("listing");
    assert_eq!(listing.kind, KIND_LISTING);
    let listing = super::exchange::decode_listing_full(&listing.body).expect("listing");
    assert_eq!(listing.manifest.files.keys().cloned().collect::<Vec<_>>(), ["s/Cells.md"]);
    for asked in ["s/../Diary.md", "Diary.md", "a/../Diary.md", "s/Cells.md/../../Diary.md"] {
        send_blob(&mut channel, KIND_GET, asked.as_bytes(), &[]).expect("get");
        let answer = super::exchange::recv_blob(&mut channel, 1 << 20).expect("answer");
        assert_ne!(answer.kind, KIND_FILE, "{asked}");
    }
    // An unshared id is refused even for Mila's device.
    let mut other = id;
    other[0] ^= 1;
    let stream = std::net::TcpStream::connect(("127.0.0.1", port)).expect("connect");
    let mut channel = super::channel::Channel::connect(stream, mila.identity_for_tests()).expect("channel");
    let mut message = vec![KIND_SHARE_OPEN];
    message.extend_from_slice(&other);
    channel.send(&message).expect("send");
    assert_ne!(channel.recv().ok().and_then(|a| a.first().copied()), Some(KIND_INVITE_OK));
}
