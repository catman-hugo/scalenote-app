//! Tests for finding and settling conflict copies, on real folders.

use super::conflicts::{list, parse, settle, Keep};
use super::files::Done;
use super::plan::conflict_name;
use std::collections::BTreeSet;
use std::fs;
use std::path::{Path, PathBuf};

struct Dir(PathBuf);

impl Dir {
    fn new(label: &str) -> Dir {
        let path = std::env::temp_dir().join(format!("sn-conflicts-{label}-{}", std::process::id()));
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

fn write(root: &Path, relative: &str, text: &str) {
    let path = root.join(relative);
    fs::create_dir_all(path.parent().expect("parent")).expect("folders");
    fs::write(path, text).expect("write");
}

#[test]
fn names_made_by_the_planner_are_read_back_and_others_are_not() {
    let mut taken = BTreeSet::new();
    for path in ["Plan.md", "School/Week 1.md", "Photo.png", "No extension", "a.b.c.md"] {
        let copy = conflict_name(path, "alice-phone", "2026-11-17", &taken);
        let (original, device, date) = parse(&copy).unwrap_or_else(|| panic!("{copy} should be read"));
        assert_eq!((original.as_str(), device.as_str(), date.as_str()), (path, "alice-phone", "2026-11-17"));
        taken.insert(copy.to_lowercase());
    }
    // A second copy on the same day gets a number and is still read.
    let again = conflict_name("Plan.md", "alice-phone", "2026-11-17", &taken);
    assert!(again.contains("2026-11-17 2"));
    assert_eq!(parse(&again).map(|p| p.0), Some("Plan.md".to_string()));
    for not in ["Plan.md", "Plan (conflict).md", "Plan (conflict alice).md", "Plan (conflict alice 2026-1-17).md", "Plan (conflict al ice 2026-11-17).md", " (conflict alice 2026-11-17).md", "Plan (conflict alice 2026-11-17 x).md", "Plan (conflict alice 2026-11-17)x.md"] {
        assert!(parse(not).is_none(), "{not} is not a conflict copy");
    }
}

#[test]
fn the_list_finds_copies_in_folders_and_marks_pages() {
    let dir = Dir::new("list");
    write(&dir.0, "School/Plan.md", "mine");
    write(&dir.0, "School/Plan (conflict bob 2026-11-17).md", "theirs");
    write(&dir.0, "Scan (conflict bob 2026-11-17).pdf", "pdf");
    write(&dir.0, "Ordinary.md", "x");
    let found = list(&dir.0).expect("list");
    assert_eq!(found.len(), 2);
    let page = found.iter().find(|c| c.copy.ends_with(".md")).expect("page copy");
    assert_eq!((page.original.as_str(), page.device.as_str(), page.is_page), ("School/Plan.md", "bob", true));
    assert!(!found.iter().find(|c| c.copy.ends_with(".pdf")).expect("pdf copy").is_page);
}

#[test]
fn keeping_the_page_trashes_the_copy_and_keeping_the_copy_trashes_the_old_page() {
    let dir = Dir::new("settle");
    write(&dir.0, "A.md", "page now");
    write(&dir.0, "A (conflict bob 2026-11-17).md", "older copy");
    assert_eq!(settle(&dir.0, "A (conflict bob 2026-11-17).md", Keep::Page).expect("keep page"), Done::Applied);
    assert_eq!(fs::read_to_string(dir.0.join("A.md")).expect("read"), "page now");
    assert!(!dir.0.join("A (conflict bob 2026-11-17).md").exists());
    let vault = crate::vault::Vault::open(&dir.0).expect("vault");
    assert_eq!(vault.trash_list().expect("trash").len(), 1, "the copy is in the trash, not gone");

    write(&dir.0, "B.md", "page now");
    write(&dir.0, "B (conflict bob 2026-11-17).md", "text of the copy");
    assert_eq!(settle(&dir.0, "B (conflict bob 2026-11-17).md", Keep::Copy).expect("keep copy"), Done::Applied);
    assert_eq!(fs::read_to_string(dir.0.join("B.md")).expect("read"), "text of the copy");
    assert!(!dir.0.join("B (conflict bob 2026-11-17).md").exists());
    let trash = vault.trash_list().expect("trash");
    assert_eq!(trash.len(), 3, "both of B's old files can still be restored: {trash:?}");
    assert!(trash.iter().any(|t| t.name == "B.md"), "the old page text is in the trash");
}

#[test]
fn a_page_that_was_deleted_takes_the_copy_as_its_text_and_a_missing_copy_changes_nothing() {
    let dir = Dir::new("gone");
    write(&dir.0, "C (conflict bob 2026-11-17).md", "all that is left");
    assert_eq!(settle(&dir.0, "C (conflict bob 2026-11-17).md", Keep::Copy).expect("settle"), Done::Applied);
    assert_eq!(fs::read_to_string(dir.0.join("C.md")).expect("read"), "all that is left");
    assert_eq!(settle(&dir.0, "C (conflict bob 2026-11-17).md", Keep::Page).expect("again"), Done::Changed);
    assert!(settle(&dir.0, "C.md", Keep::Page).is_err(), "only copies can be settled");
    assert!(settle(&dir.0, "../C (conflict bob 2026-11-17).md", Keep::Page).is_err(), "no path out of the vault");
}
