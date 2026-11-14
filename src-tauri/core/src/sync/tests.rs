//! Tests for the sync rules. They use real folders on disk and the real scan, planner and
//! settings code (no copies of the logic).

use super::manifest::{portable_name, safe_path, MAX_PATH_BYTES};
use super::*;
use std::collections::BTreeSet;
use std::fs;
use std::path::{Path, PathBuf};

struct Dir(PathBuf);

impl Dir {
    fn new(label: &str) -> Dir {
        let path = std::env::temp_dir().join(format!("sn-sync-{label}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&path);
        fs::create_dir_all(&path).expect("make test dir");
        Dir(path)
    }
    fn put(&self, relative: &str, text: &str) {
        let path = self.0.join(relative);
        fs::create_dir_all(path.parent().expect("parent")).expect("make folders");
        fs::write(path, text).expect("write file");
    }
    fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for Dir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn scan(dir: &Dir) -> Scan {
    Manifest::scan(dir.path()).expect("scan")
}

fn skipped_set(scan: &Scan) -> BTreeSet<String> {
    scan.skipped.iter().map(|s| s.path.clone()).collect()
}

fn state(hash_of: &str, modified: u64) -> FileState {
    FileState { hash: manifest::hash_bytes(hash_of.as_bytes()), size: hash_of.len() as u64, modified }
}

fn manifest_of(files: &[(&str, &str, u64)]) -> Manifest {
    let mut m = Manifest::default();
    for (path, content, modified) in files {
        m.files.insert(path.to_string(), state(content, *modified));
    }
    m
}

fn plan_for(base: &Manifest, local: &Manifest, remote: &Manifest) -> Plan {
    let none = BTreeSet::new();
    make_plan(&PlanInput { base, local, remote, local_skipped: &none, remote_skipped: &none, device: "alice", date: "2026-11-14" })
}

// ---- scanning real folders ----

#[test]
fn scan_lists_files_with_hashes_and_ignores_trash_hidden_and_temp_files() {
    let dir = Dir::new("scan");
    dir.put("Note.md", "hello");
    dir.put("Folder/Sub/Deep.md", "deep");
    dir.put(".trash/Old.md", "gone");
    dir.put(".history/x.md", "old version");
    dir.put("Half.md.sn-tmp", "cut off write");
    dir.put(".scalenote/folder-icons.json", "{}");
    dir.put(".scalenote/other.json", "{}");
    let scan = scan(&dir);
    let paths: Vec<&str> = scan.manifest.files.keys().map(String::as_str).collect();
    assert_eq!(paths, vec![".scalenote/folder-icons.json", "Folder/Sub/Deep.md", "Note.md"]);
    assert_eq!(scan.manifest.files["Note.md"].hash, manifest::hash_bytes(b"hello"));
    assert_eq!(scan.manifest.files["Note.md"].size, 5);
    assert!(scan.skipped.is_empty());
}

#[test]
fn scan_of_an_empty_vault_is_empty() {
    let dir = Dir::new("empty");
    let scan = scan(&dir);
    assert!(scan.manifest.files.is_empty() && scan.skipped.is_empty());
}

#[cfg(unix)]
#[test]
fn scan_never_follows_links_and_reports_them() {
    let dir = Dir::new("links");
    let outside = Dir::new("links-outside");
    outside.put("secret.md", "not part of the vault");
    dir.put("Real.md", "real");
    std::os::unix::fs::symlink(outside.path().join("secret.md"), dir.path().join("Link.md")).expect("link");
    std::os::unix::fs::symlink(outside.path(), dir.path().join("LinkedFolder")).expect("link folder");
    let scan = scan(&dir);
    assert_eq!(scan.manifest.files.keys().collect::<Vec<_>>(), vec!["Real.md"]);
    let skipped = skipped_set(&scan);
    assert!(skipped.contains("Link.md") && skipped.contains("LinkedFolder"));
    assert!(scan.skipped.iter().all(|s| s.reason == SkipReason::NotAFile));
}

// Windows refuses to create these names at all, so the scan is only tried on a system that can
// hold them (a vault from Linux or Android can contain them). The rule itself is checked everywhere.
#[cfg(unix)]
#[test]
fn scan_skips_names_other_systems_cannot_hold() {
    let dir = Dir::new("names");
    dir.put("Fine.md", "ok");
    dir.put("what?.md", "question mark");
    dir.put("CON.md", "reserved on Windows");
    dir.put("ends with dot.", "trailing dot");
    let scan = scan(&dir);
    assert_eq!(scan.manifest.files.keys().collect::<Vec<_>>(), vec!["Fine.md"]);
    assert_eq!(scan.skipped.len(), 3);
    assert!(scan.skipped.iter().all(|s| s.reason == SkipReason::NotPortable));
}

#[test]
fn names_other_systems_cannot_hold_are_not_portable() {
    for bad in ["what?.md", "CON.md", "con.txt", "ends with dot.", "ends with space ", "a:b", "tab\there", ""] {
        assert!(!portable_name(bad), "{bad:?}");
    }
    // Linux cannot even create a name this long, so the rule is checked directly.
    assert!(!portable_name(&format!("{}.md", "x".repeat(300))));
    assert!(portable_name("Fine.md") && portable_name("Café 日本.md"));
}

#[test]
fn scan_skips_folders_that_are_too_deep() {
    let dir = Dir::new("deep");
    let deep = vec!["d"; manifest::MAX_DEPTH + 2].join("/");
    dir.put(&format!("{deep}/Note.md"), "too deep");
    dir.put("Top.md", "top");
    let scan = scan(&dir);
    assert_eq!(scan.manifest.files.keys().collect::<Vec<_>>(), vec!["Top.md"]);
    assert!(!scan.skipped.is_empty());
}

#[test]
fn a_killed_write_leaves_only_a_temp_file_that_scan_ignores() {
    let dir = Dir::new("killed");
    dir.put("Note.md", "complete");
    dir.put("Note.md.sn-tmp", "half of a new versi");
    let scan = scan(&dir);
    assert_eq!(scan.manifest.files["Note.md"].hash, manifest::hash_bytes(b"complete"));
    assert_eq!(scan.manifest.files.len(), 1);
}

#[test]
fn renamed_folder_looks_like_delete_plus_add_and_loses_nothing() {
    let before = Dir::new("rename-a");
    before.put("Old/Note.md", "text");
    let base = scan(&before).manifest;
    let after = Dir::new("rename-b");
    after.put("New/Note.md", "text");
    let local = scan(&after).manifest;
    // The other side still has the old folder untouched.
    let plan = plan_for(&base, &local, &base);
    let summary = plan.summary();
    assert_eq!((summary.push, summary.delete_remote, summary.conflicts), (1, 1, 0));
    assert!(plan.actions.contains(&Action::Push { path: "New/Note.md".into() }));
    assert!(plan.actions.contains(&Action::DeleteRemote { path: "Old/Note.md".into() }));
}

// ---- manifest text format ----

#[test]
fn manifest_text_round_trips() {
    let dir = Dir::new("roundtrip");
    dir.put("A.md", "a");
    dir.put("Folder/With space.md", "b");
    let original = scan(&dir).manifest;
    let text = original.to_text();
    assert_eq!(Manifest::from_text(&text).expect("read back"), original);
}

#[test]
fn manifest_text_refuses_anything_odd() {
    let good_hash = manifest::hash_bytes(b"x");
    let line = |hash: &str, size: &str, modified: &str, path: &str| format!("scalenote-manifest 1\n{hash} {size} {modified} {path}\n");
    assert!(Manifest::from_text(&line(&good_hash, "1", "0", "A.md")).is_ok());
    assert!(Manifest::from_text("").is_err());
    assert!(Manifest::from_text("scalenote-manifest 2\n").is_err());
    assert!(Manifest::from_text("scalenote-manifest 1").is_err(), "must end with a newline");
    assert!(Manifest::from_text(&line("zz", "1", "0", "A.md")).is_err(), "bad hash");
    assert!(Manifest::from_text(&line(&good_hash.to_uppercase(), "1", "0", "A.md")).is_err(), "upper case hash");
    assert!(Manifest::from_text(&line(&good_hash, "-1", "0", "A.md")).is_err(), "negative size");
    assert!(Manifest::from_text(&line(&good_hash, "1", "x", "A.md")).is_err(), "bad time");
    assert!(Manifest::from_text(&line(&good_hash, "99999999999", "0", "A.md")).is_err(), "bigger than any file");
    assert!(Manifest::from_text(&line(&good_hash, "1", "0", "../Evil.md")).is_err(), "path leaves the vault");
    assert!(Manifest::from_text(&line(&good_hash, "1", "0", "/abs.md")).is_err(), "absolute path");
    assert!(Manifest::from_text(&line(&good_hash, "1", "0", "a\\b.md")).is_err(), "backslash");
    assert!(Manifest::from_text(&line(&good_hash, "1", "0", ".trash/x.md")).is_err(), "hidden folder");
    assert!(Manifest::from_text(&line(&good_hash, "1", "0", "A.md.sn-tmp")).is_err(), "temp file");
    assert!(Manifest::from_text(&line(&good_hash, "1", "0", "A.md")).is_ok());
    let twice = format!("scalenote-manifest 1\n{good_hash} 1 0 A.md\n{good_hash} 1 0 A.md\n");
    assert!(Manifest::from_text(&twice).is_err(), "same path twice");
}

#[test]
fn manifest_text_refuses_huge_input_without_reading_it_all() {
    let huge = "x".repeat(manifest::MAX_MANIFEST_BYTES + 1);
    assert!(Manifest::from_text(&huge).is_err());
}

#[test]
fn path_rules() {
    assert!(safe_path("Folder/Note.md") && safe_path(".scalenote/folder-icons.json"));
    assert!(!safe_path("") && !safe_path("a//b.md") && !safe_path("a/./b.md") && !safe_path("a/../b.md"));
    assert!(!safe_path(&"a".repeat(MAX_PATH_BYTES + 1)));
    assert!(!safe_path(".scalenote/other.json"));
    assert!(portable_name("Note ü 日本.md") && !portable_name("a:b") && !portable_name("tab\there") && !portable_name("nul.txt"));
}

// ---- the planner ----

#[test]
fn change_on_one_side_goes_to_the_other() {
    let base = manifest_of(&[("A.md", "one", 10), ("B.md", "one", 10)]);
    let local = manifest_of(&[("A.md", "two", 20), ("B.md", "one", 10)]);
    let remote = manifest_of(&[("A.md", "one", 10), ("B.md", "three", 30)]);
    let plan = plan_for(&base, &local, &remote);
    assert_eq!(plan.actions, vec![Action::Push { path: "A.md".into() }, Action::Pull { path: "B.md".into() }]);
}

#[test]
fn identical_sides_need_nothing_even_if_times_differ() {
    let base = manifest_of(&[("A.md", "same", 10)]);
    let local = manifest_of(&[("A.md", "same", 99)]);
    let remote = manifest_of(&[("A.md", "same", 50)]);
    assert!(plan_for(&base, &local, &remote).summary().is_empty());
}

#[test]
fn change_on_both_sides_keeps_both_versions_and_the_newer_keeps_the_name() {
    let base = manifest_of(&[("Folder/Note.md", "start", 10)]);
    let local = manifest_of(&[("Folder/Note.md", "mine", 20)]);
    let remote = manifest_of(&[("Folder/Note.md", "theirs", 30)]);
    let plan = plan_for(&base, &local, &remote);
    assert_eq!(
        plan.actions,
        vec![Action::Conflict { path: "Folder/Note.md".into(), copy: "Folder/Note (conflict alice 2026-11-14).md".into(), winner: Side::Remote }]
    );
    // When the local one is newer (or the times are equal) it keeps the name.
    let local_newer = manifest_of(&[("Folder/Note.md", "mine", 40)]);
    match &plan_for(&base, &local_newer, &remote).actions[0] {
        Action::Conflict { winner, .. } => assert_eq!(*winner, Side::Local),
        other => panic!("expected a conflict, got {other:?}"),
    }
}

#[test]
fn same_file_made_on_both_sides_before_the_first_sync_is_a_conflict_not_an_overwrite() {
    let empty = Manifest::default();
    let local = manifest_of(&[("A.md", "mine", 1)]);
    let remote = manifest_of(&[("A.md", "theirs", 2)]);
    assert_eq!(plan_for(&empty, &local, &remote).summary().conflicts, 1);
    let same = manifest_of(&[("A.md", "mine", 2)]);
    assert!(plan_for(&empty, &local, &same).summary().is_empty());
}

#[test]
fn first_sync_never_deletes_anything() {
    let empty = Manifest::default();
    let local = manifest_of(&[("Only-here.md", "a", 1)]);
    let remote = manifest_of(&[("Only-there.md", "b", 1)]);
    let plan = plan_for(&empty, &local, &remote);
    assert_eq!(plan.actions, vec![Action::Push { path: "Only-here.md".into() }, Action::Pull { path: "Only-there.md".into() }]);
    assert_eq!(plan.summary().delete_local + plan.summary().delete_remote, 0);
}

#[test]
fn delete_on_one_side_deletes_on_the_other_only_when_it_was_not_edited() {
    let base = manifest_of(&[("Gone.md", "x", 1), ("Edited.md", "x", 1)]);
    // Remote deleted both files; here one of them was edited.
    let local = manifest_of(&[("Gone.md", "x", 1), ("Edited.md", "edited", 5)]);
    let remote = Manifest::default();
    let plan = plan_for(&base, &local, &remote);
    assert_eq!(plan.actions, vec![Action::Push { path: "Edited.md".into() }, Action::DeleteLocal { path: "Gone.md".into() }]);
    // The same the other way round.
    let plan = plan_for(&base, &remote, &local);
    assert_eq!(plan.actions, vec![Action::Pull { path: "Edited.md".into() }, Action::DeleteRemote { path: "Gone.md".into() }]);
}

#[test]
fn deleted_on_both_sides_needs_nothing() {
    let base = manifest_of(&[("A.md", "x", 1)]);
    let none = Manifest::default();
    assert!(plan_for(&base, &none, &none).summary().is_empty());
}

#[test]
fn skipped_files_are_never_treated_as_deleted_or_copied() {
    // `Big.pdf` was synced before, is now left out of the local list (too big) and so looks
    // missing; `Link.md` exists only on the remote side but is a link here.
    let base = manifest_of(&[("Big.pdf", "x", 1), ("Plain.md", "p", 1)]);
    let local = manifest_of(&[("Plain.md", "p", 1)]);
    let remote = manifest_of(&[("Big.pdf", "x", 1), ("Plain.md", "p", 1), ("Link.md", "l", 1)]);
    let local_skipped: BTreeSet<String> = ["Big.pdf".to_string(), "Link.md".to_string()].into();
    let none = BTreeSet::new();
    let plan = make_plan(&PlanInput { base: &base, local: &local, remote: &remote, local_skipped: &local_skipped, remote_skipped: &none, device: "alice", date: "2026-11-14" });
    assert!(plan.summary().is_empty(), "{plan:?}");
}

#[test]
fn names_that_differ_only_by_case_are_reported_not_created_side_by_side() {
    let empty = Manifest::default();
    let local = manifest_of(&[("Note.md", "a", 1)]);
    let remote = manifest_of(&[("note.md", "b", 1)]);
    let plan = plan_for(&empty, &local, &remote);
    assert!(plan.actions.is_empty());
    assert_eq!(plan.clashes.len(), 2);
    assert_eq!(plan.summary().clashes, 2);
}

#[test]
fn conflict_names_keep_folder_and_extension_and_never_reuse_a_name() {
    let mut taken: BTreeSet<String> = BTreeSet::new();
    let first = conflict_name("A/B/Note.md", "alice", "2026-11-14", &taken);
    assert_eq!(first, "A/B/Note (conflict alice 2026-11-14).md");
    taken.insert(first.to_lowercase());
    let second = conflict_name("A/B/Note.md", "alice", "2026-11-14", &taken);
    assert_eq!(second, "A/B/Note (conflict alice 2026-11-14 2).md");
    assert_eq!(conflict_name("Plain", "bob", "2026-11-14", &BTreeSet::new()), "Plain (conflict bob 2026-11-14)");
}

#[test]
fn conflict_name_for_a_huge_file_name_still_fits() {
    let path = format!("{}.md", "n".repeat(250));
    let name = conflict_name(&path, "alice", "2026-11-14", &BTreeSet::new());
    assert!(name.len() <= manifest::MAX_NAME_BYTES, "{}", name.len());
    assert!(name.ends_with("(conflict alice 2026-11-14).md") && safe_path(&name));
}

#[test]
fn two_conflicts_in_one_plan_get_different_copy_names() {
    let base = manifest_of(&[("A.md", "x", 1), ("a-copy.md", "y", 1)]);
    let local = manifest_of(&[("A.md", "l", 2)]);
    let remote = manifest_of(&[("A.md", "r", 3)]);
    let both = manifest_of(&[("A.md", "x", 1), ("A (conflict alice 2026-11-14).md", "taken", 1)]);
    let plan = plan_for(&both, &local, &remote);
    match &plan.actions[0] {
        Action::Conflict { copy, .. } => assert_eq!(copy, "A (conflict alice 2026-11-14 2).md"),
        other => panic!("{other:?}"),
    }
    let _ = base;
}

#[test]
fn full_round_trip_on_real_folders_changes_nothing_when_nothing_changed() {
    let here = Dir::new("same-a");
    let there = Dir::new("same-b");
    for dir in [&here, &there] {
        dir.put("Note.md", "same text");
        dir.put("Folder/Pic.png", "png bytes");
    }
    let (a, b) = (scan(&here), scan(&there));
    let plan = plan_for(&a.manifest, &a.manifest, &b.manifest);
    assert!(plan.summary().is_empty());
}

// ---- device settings ----

#[test]
fn device_settings_are_made_once_with_sync_on() {
    let dir = Dir::new("device");
    let first = device::load(dir.path()).expect("load");
    assert!(first.created && first.settings.enabled);
    assert_eq!(first.settings.id.len(), 32);
    let second = device::load(dir.path()).expect("load again");
    assert!(!second.created);
    assert_eq!(second.settings, first.settings);
}

#[test]
fn two_devices_get_different_ids() {
    let (a, b) = (Dir::new("id-a"), Dir::new("id-b"));
    assert_ne!(device::load(a.path()).expect("a").settings.id, device::load(b.path()).expect("b").settings.id);
}

#[test]
fn device_name_and_switch_are_saved_and_the_name_is_cleaned() {
    let dir = Dir::new("device-update");
    let updated = device::update(dir.path(), Some("  Alice's Phone / 2 "), Some(false)).expect("update");
    assert_eq!(updated.name, "Alices-Phone-2");
    assert!(!updated.enabled);
    let again = device::load(dir.path()).expect("load").settings;
    assert_eq!(again, updated);
    // Changing only the switch keeps the name and the id.
    let back = device::update(dir.path(), None, Some(true)).expect("update");
    assert!(back.enabled && back.name == "Alices-Phone-2" && back.id == updated.id);
}

#[test]
fn device_names_are_always_safe_for_file_names() {
    assert_eq!(device::clean_name(""), "this-device");
    assert_eq!(device::clean_name("../../etc"), "etc");
    assert_eq!(device::clean_name("a:b*c?"), "abc");
    assert_eq!(device::clean_name(&"x".repeat(500)).chars().count(), device::MAX_DEVICE_NAME_CHARS);
    assert!(portable_name(&device::clean_name("???")));
}

#[test]
fn damaged_device_file_is_replaced_not_trusted() {
    let dir = Dir::new("device-damaged");
    fs::write(dir.path().join("sync-device.txt"), "garbage").expect("write");
    let loaded = device::load(dir.path()).expect("load");
    assert!(loaded.created && loaded.settings.enabled);
    // A huge file is not read at all.
    fs::write(dir.path().join("sync-device.txt"), "x".repeat(100_000)).expect("write");
    assert!(device::load(dir.path()).expect("load").created);
    // A hand-edited name with odd characters is cleaned on the way in.
    let id = "0123456789abcdef0123456789abcdef";
    fs::write(dir.path().join("sync-device.txt"), format!("scalenote-device 1\nid {id}\nname ../x\nenabled true\n")).expect("write");
    assert_eq!(device::load(dir.path()).expect("load").settings.name, "x");
}
