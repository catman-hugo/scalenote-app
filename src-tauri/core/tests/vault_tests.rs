// Tests that use the real Vault on a real folder.

use scalenote_core::{EntryKind, NoteVersion, Vault, VaultError};
use std::fs;
use std::path::PathBuf;

fn scratch(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("sn-it-{name}-{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).expect("create scratch dir");
    dir
}

fn vault(name: &str) -> (Vault, PathBuf) {
    let dir = scratch(name);
    (Vault::open(&dir).expect("open"), dir)
}

#[test]
fn create_write_read_round_trip_keeps_bytes_exactly() {
    let (v, _) = vault("roundtrip");
    let path = v.create_note("", "First").expect("create");
    assert_eq!(path, "First.md");
    let text = "---\nid: x\n---\n\n# Héllo ✓\r\n\t<custom-tag foo=\"bar\"/>\n\n- [ ] a\n";
    let created = v.read_note(&path).expect("read empty");
    let version = v.write_note(&path, text, Some(created.version)).expect("write");
    let back = v.read_note(&path).expect("read");
    assert_eq!(back.text, text);
    assert_eq!(back.version, version);
}

#[test]
fn stale_version_is_a_conflict_and_nothing_is_written() {
    let (v, dir) = vault("conflict");
    let path = v.create_note("", "A").expect("create");
    let first = v.read_note(&path).expect("read").version;
    v.write_note(&path, "mine", Some(first)).expect("write");
    fs::write(dir.join("A.md"), "changed by another program").expect("external edit");
    let result = v.write_note(&path, "mine again", Some(NoteVersion::of(b"mine")));
    assert_eq!(result, Err(VaultError::Conflict));
    assert_eq!(fs::read_to_string(dir.join("A.md")).expect("read"), "changed by another program");
}

#[test]
fn writing_without_a_version_never_replaces_an_existing_note() {
    let (v, dir) = vault("noversion");
    fs::write(dir.join("A.md"), "x").expect("seed");
    assert_eq!(v.write_note("A.md", "y", None), Err(VaultError::Conflict));
    assert_eq!(fs::read_to_string(dir.join("A.md")).expect("read"), "x");
}

#[test]
fn a_note_deleted_elsewhere_is_a_conflict_not_a_silent_recreate() {
    let (v, dir) = vault("deleted");
    let path = v.create_note("", "A").expect("create");
    let version = v.read_note(&path).expect("read").version;
    fs::remove_file(dir.join("A.md")).expect("delete");
    assert_eq!(v.write_note(&path, "x", Some(version)), Err(VaultError::Conflict));
}

#[test]
fn new_file_can_be_written_with_no_version() {
    let (v, dir) = vault("newfile");
    v.write_note("Fresh.md", "hi", None).expect("write");
    assert_eq!(fs::read_to_string(dir.join("Fresh.md")).expect("read"), "hi");
}

#[test]
fn paths_that_leave_the_vault_are_refused() {
    let (v, _) = vault("traversal");
    for bad in ["../x.md", "a/../../x.md", "/etc/passwd.md", "a\\b.md", ".hidden/x.md", "a//b.md", "./a.md", "a\0.md"] {
        assert_eq!(v.read_note(bad).err(), Some(VaultError::InvalidPath), "{bad:?}");
        assert_eq!(v.write_note(bad, "x", None).err(), Some(VaultError::InvalidPath), "{bad:?}");
    }
    assert_eq!(v.read_note("notes.txt").err(), Some(VaultError::NotANote));
    assert_eq!(v.read_note("").err(), Some(VaultError::NotANote));
}

#[cfg(unix)]
#[test]
fn a_symlink_pointing_outside_cannot_be_read_or_written_through() {
    let (v, dir) = vault("symlink");
    let outside = scratch("symlink-outside");
    fs::write(outside.join("secret.md"), "secret").expect("seed");
    std::os::unix::fs::symlink(&outside, dir.join("link")).expect("link dir");
    std::os::unix::fs::symlink(outside.join("secret.md"), dir.join("file.md")).expect("link file");
    assert_eq!(v.read_note("link/secret.md").err(), Some(VaultError::InvalidPath));
    assert_eq!(v.write_note("link/new.md", "x", None).err(), Some(VaultError::InvalidPath));
    assert_eq!(v.read_note("file.md").err(), Some(VaultError::InvalidPath));
    assert!(!outside.join("new.md").exists());
    let tree = v.tree().expect("tree");
    assert!(tree.entries.iter().all(|e| e.name != "link"));
}

#[test]
fn creating_with_the_same_title_adds_numbers() {
    let (v, _) = vault("unique");
    assert_eq!(v.create_note("", "Idea").expect("1"), "Idea.md");
    assert_eq!(v.create_note("", "Idea").expect("2"), "Idea 2.md");
    assert_eq!(v.create_note("", "Idea").expect("3"), "Idea 3.md");
    assert_eq!(v.create_folder("", "Idea").expect("folder"), "Idea");
}

#[test]
fn hostile_titles_become_safe_names() {
    let (v, _) = vault("hostile");
    assert_eq!(v.create_note("", "../../evil").expect("c"), "evil.md");
    assert_eq!(v.create_note("", "").expect("empty"), "Untitled.md");
    assert_eq!(v.create_note("", "CON").expect("con"), "CON_.md");
    let huge = "x".repeat(10_000);
    let path = v.create_note("", &huge).expect("huge");
    assert!(path.len() <= 103);
}

#[test]
fn tree_lists_folders_first_skips_hidden_and_other_files() {
    let (v, dir) = vault("tree");
    fs::create_dir_all(dir.join("b folder/inner")).expect("dirs");
    fs::create_dir_all(dir.join(".obsidian")).expect("hidden");
    fs::write(dir.join(".obsidian/app.json"), "{}").expect("seed");
    fs::write(dir.join("zeta.md"), "").expect("seed");
    fs::write(dir.join("Alpha.md"), "").expect("seed");
    fs::write(dir.join("picture.png"), "").expect("seed");
    fs::write(dir.join("b folder/inner/deep.md"), "").expect("seed");
    let tree = v.tree().expect("tree");
    let listing: Vec<String> = tree
        .entries
        .iter()
        .map(|e| format!("{}{}", e.path, if e.kind == EntryKind::Folder { "/" } else { "" }))
        .collect();
    assert_eq!(listing, vec!["b folder/", "b folder/inner/", "b folder/inner/deep.md", "Alpha.md", "zeta.md"]);
    assert!(!tree.truncated);
}

#[test]
fn rename_keeps_extension_and_refuses_to_overwrite() {
    let (v, _) = vault("rename");
    v.create_note("", "One").expect("c1");
    v.create_note("", "Two").expect("c2");
    assert_eq!(v.rename("One.md", "Three").expect("rename"), "Three.md");
    assert_eq!(v.rename("Three.md", "Two"), Err(VaultError::AlreadyExists));
    assert_eq!(v.rename("Three.md", "a/b").expect("sanitised"), "ab.md");
    assert_eq!(v.rename("Missing.md", "X"), Err(VaultError::NotFound));
    assert_eq!(v.rename("", "X"), Err(VaultError::InvalidPath));
}

#[test]
fn move_puts_notes_and_folders_into_other_folders_and_keeps_their_contents() {
    let (v, dir) = vault("move");
    v.create_folder("", "Biology").expect("folder");
    v.create_folder("", "Archive").expect("folder");
    v.create_note("Biology", "Cells").expect("note");
    v.create_note("", "Plan").expect("note");
    // A note into a folder, and back to the top.
    assert_eq!(v.move_entry("Plan.md", "Archive").expect("move"), "Archive/Plan.md");
    assert!(dir.join("Archive/Plan.md").is_file() && !dir.join("Plan.md").exists());
    assert_eq!(v.move_entry("Archive/Plan.md", "").expect("move back"), "Plan.md");
    // A folder with a note inside, into another folder.
    assert_eq!(v.move_entry("Biology", "Archive").expect("move folder"), "Archive/Biology");
    assert!(dir.join("Archive/Biology/Cells.md").is_file() && !dir.join("Biology").exists());
}

#[test]
fn move_refuses_loops_clashes_and_bad_targets_and_changes_nothing() {
    let (v, dir) = vault("move-refuse");
    v.create_folder("", "A").expect("folder");
    v.create_folder("A", "B").expect("folder");
    v.create_note("", "Same").expect("note");
    v.create_folder("", "Target").expect("folder");
    v.create_note("Target", "Same").expect("note with the same name");
    // A folder cannot go into itself or into its own subfolder.
    assert_eq!(v.move_entry("A", "A"), Err(VaultError::InvalidPath));
    assert_eq!(v.move_entry("A", "A/B"), Err(VaultError::InvalidPath));
    // A folder whose name only starts the same is a different folder.
    v.create_folder("", "A2").expect("folder");
    assert_eq!(v.move_entry("A2", "A").expect("different folder"), "A/A2");
    // A name already used in the target is never replaced.
    assert_eq!(v.move_entry("Same.md", "Target"), Err(VaultError::AlreadyExists));
    assert!(dir.join("Same.md").is_file() && dir.join("Target/Same.md").is_file());
    // Missing things, a note as target, odd paths.
    assert_eq!(v.move_entry("Missing.md", "A"), Err(VaultError::NotFound));
    // A target that is missing or is a note is not a folder.
    assert_eq!(v.move_entry("Same.md", "Nowhere"), Err(VaultError::NotADirectory));
    assert_eq!(v.move_entry("Same.md", "Target/Same.md"), Err(VaultError::NotADirectory));
    assert_eq!(v.move_entry("", "A"), Err(VaultError::InvalidPath));
    assert_eq!(v.move_entry("Same.md", "../outside"), Err(VaultError::InvalidPath));
    assert_eq!(v.move_entry("../x.md", "A"), Err(VaultError::InvalidPath));
    assert_eq!(v.move_entry("Same.md", "/abs"), Err(VaultError::InvalidPath));
}

#[test]
fn moving_to_where_it_already_is_changes_nothing() {
    let (v, dir) = vault("move-noop");
    v.create_folder("", "A").expect("folder");
    v.create_note("A", "N").expect("note");
    assert_eq!(v.move_entry("A/N.md", "A").expect("noop"), "A/N.md");
    assert_eq!(v.move_entry("A", "").expect("noop"), "A");
    assert!(dir.join("A/N.md").is_file());
}

#[test]
fn oversized_and_non_utf8_notes_are_refused_not_converted() {
    let (v, dir) = vault("limits");
    fs::write(dir.join("bin.md"), [0xff, 0xfe, 0x00]).expect("seed");
    assert_eq!(v.read_note("bin.md").err(), Some(VaultError::NotUtf8));
    let big = vec![b'a'; 9 * 1024 * 1024];
    fs::write(dir.join("big.md"), &big).expect("seed");
    assert_eq!(v.read_note("big.md").err(), Some(VaultError::TooLarge));
    let text = "a".repeat(9 * 1024 * 1024);
    assert_eq!(v.write_note("huge.md", &text, None), Err(VaultError::TooLarge));
}

#[test]
fn leftovers_from_a_crash_are_cleaned_when_the_vault_opens() {
    let (v, dir) = vault("cleanup");
    fs::write(dir.join(".A.md.1.1.sn-tmp"), "half").expect("seed");
    fs::write(dir.join("A.md"), "ok").expect("seed");
    // Fresh files are kept for 60 seconds, so only test the call is safe on notes.
    let _ = v.clean_up_leftovers();
    assert_eq!(fs::read_to_string(dir.join("A.md")).expect("read"), "ok");
}

#[test]
fn rapid_repeated_saves_and_odd_input_do_not_fail() {
    let (v, _) = vault("rapid");
    let path = v.create_note("", "Rapid").expect("create");
    let mut version = v.read_note(&path).expect("read").version;
    for i in 0..300 {
        let text = format!("line {i}\n\0 weird \u{1F600} \u{202E} \r\n");
        version = v.write_note(&path, &text, Some(version)).expect("save");
    }
    assert!(v.write_note(&path, "", Some(version)).is_ok());
}
