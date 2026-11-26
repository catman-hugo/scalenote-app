//! Syncing folders themselves, not only the files in them (0.6.7).
//!
//! Before this, a sync only listed files. Two things went wrong because of that: a new empty
//! folder never reached the other device (there was no file to send), and a folder moved or
//! deleted on one device stayed behind, empty, on the other (its files moved away, the folder
//! did not).
//!
//! How it works, and why:
//! - Both devices list every visible folder, empty or not (`Scan::folders`), next to their files.
//!   Apps before this send no folder list; with them nothing happens to folders, as before.
//! - Like files, folders are compared with what both had the last time they matched (the "base",
//!   kept per device in `.scalenote/sync-folders-<device>.txt`). A folder on one side only is new
//!   there (make it on the other side) when it is not in the base, and was removed on the other
//!   side when it is. The folders that held files in the base count as in the base too, so the
//!   first sync with this version already knows most of them.
//! - Removing a folder is only ever done when the folder is empty at that moment, after the
//!   files of the sync have been moved. A folder never takes a file with it: if something was
//!   added to it on the other device in the meantime, it stays, and its files bring it back here.
//!   So the worst a mistake here can do is leave or make an empty folder.
//! - Folders are made before the files of the next sync arrive and removed deepest first, so a
//!   folder inside a removed folder goes first.

use super::manifest::{safe_path, Manifest};
use super::Result;
use crate::atomic::write_atomic;
use std::collections::BTreeSet;
use std::fs;
use std::path::{Path, PathBuf};

const HEADER: &str = "scalenote-folder-base 1";
/// The most folders a saved base or a listing may name (the same limit as for files).
pub const MAX_FOLDERS: usize = super::manifest::MAX_FILES;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum FolderAction {
    /// New on the other device: make it here.
    MakeHere(String),
    /// New here: make it on the other device.
    MakeThere(String),
    /// Removed on the other device: remove it here, if it is empty.
    RemoveHere(String),
    /// Removed here: remove it on the other device, if it is empty there.
    RemoveThere(String),
}

/// The folders both devices had last time: the saved list, plus every folder that held a file
/// both had (so a first sync with this version already knows them).
pub fn known(saved: Option<BTreeSet<String>>, base_files: &Manifest) -> BTreeSet<String> {
    let mut known = saved.unwrap_or_default();
    for path in base_files.files.keys() {
        let mut rest = path.as_str();
        while let Some(at) = rest.rfind('/') {
            rest = &rest[..at];
            if !safe_path(rest) || !known.insert(rest.to_string()) {
                break;
            }
        }
    }
    known
}

fn depth(path: &str) -> usize {
    path.matches('/').count()
}

/// What to do with folders. Makes come first, shallowest first; removes after, deepest first.
pub fn plan(base: &BTreeSet<String>, here: &BTreeSet<String>, there: &BTreeSet<String>) -> Vec<FolderAction> {
    let lower = |set: &BTreeSet<String>| set.iter().map(|p| p.to_lowercase()).collect::<BTreeSet<_>>();
    let (here_lower, there_lower) = (lower(here), lower(there));
    let mut makes = Vec::new();
    let mut removes = Vec::new();
    for path in here.union(there) {
        match (here.contains(path), there.contains(path), base.contains(path)) {
            (true, false, false) if !there_lower.contains(&path.to_lowercase()) => makes.push(FolderAction::MakeThere(path.clone())),
            (false, true, false) if !here_lower.contains(&path.to_lowercase()) => makes.push(FolderAction::MakeHere(path.clone())),
            (true, false, true) => removes.push(FolderAction::RemoveHere(path.clone())),
            (false, true, true) => removes.push(FolderAction::RemoveThere(path.clone())),
            _ => {}
        }
    }
    let path_of = |action: &FolderAction| match action {
        FolderAction::MakeHere(p) | FolderAction::MakeThere(p) | FolderAction::RemoveHere(p) | FolderAction::RemoveThere(p) => p.clone(),
    };
    makes.sort_by_key(|a| (depth(&path_of(a)), path_of(a)));
    removes.sort_by_key(|a| (std::cmp::Reverse(depth(&path_of(a))), path_of(a)));
    makes.extend(removes);
    makes
}

fn base_path(root: &Path, tag: &str) -> PathBuf {
    root.join(".scalenote").join(format!("sync-folders-{tag}.txt"))
}

/// The saved list for the device with this tag, or none (never saved, or damaged: then the
/// folders of the base files are all that is known, which never removes more).
pub fn load(root: &Path, tag: &str) -> Option<BTreeSet<String>> {
    let text = fs::read_to_string(base_path(root, tag)).ok()?;
    let mut lines = text.lines();
    if lines.next() != Some(HEADER) {
        return None;
    }
    let mut set = BTreeSet::new();
    for line in lines {
        if !safe_path(line) || set.len() >= MAX_FOLDERS {
            return None;
        }
        set.insert(line.to_string());
    }
    Some(set)
}

pub fn save(root: &Path, tag: &str, folders: &BTreeSet<String>) -> Result<()> {
    let mut text = String::from(HEADER);
    text.push('\n');
    for folder in folders {
        text.push_str(folder);
        text.push('\n');
    }
    let path = base_path(root, tag);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    write_atomic(&path, text.as_bytes())?;
    Ok(())
}

pub fn forget(root: &Path, tag: &str) {
    let _ = fs::remove_file(base_path(root, tag));
}

#[cfg(test)]
mod tests {
    use super::*;

    fn set(items: &[&str]) -> BTreeSet<String> {
        items.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn new_folders_are_made_and_removed_ones_removed() {
        let base = set(&["Old", "Kept"]);
        let here = set(&["Kept", "New here", "Year 2", "Year 2/Empty"]);
        let there = set(&["Old", "Kept", "From there"]);
        assert_eq!(
            plan(&base, &here, &there),
            vec![
                FolderAction::MakeHere("From there".into()),
                FolderAction::MakeThere("New here".into()),
                FolderAction::MakeThere("Year 2".into()),
                FolderAction::MakeThere("Year 2/Empty".into()),
                FolderAction::RemoveThere("Old".into()),
            ]
        );
    }

    #[test]
    fn removes_go_deepest_first_and_nothing_happens_without_a_difference() {
        let base = set(&["A", "A/B", "A/B/C"]);
        assert_eq!(plan(&base, &set(&[]), &base), vec![FolderAction::RemoveThere("A/B/C".into()), FolderAction::RemoveThere("A/B".into()), FolderAction::RemoveThere("A".into())]);
        assert!(plan(&base, &base, &base).is_empty());
        assert!(plan(&set(&[]), &set(&[]), &set(&[])).is_empty());
    }

    #[test]
    fn a_folder_differing_only_by_case_is_not_made_next_to_another() {
        assert!(plan(&set(&[]), &set(&["Notes"]), &set(&["notes"])).is_empty());
    }

    #[test]
    fn folders_of_base_files_count_as_known() {
        let mut files = Manifest::default();
        let state = super::super::manifest::FileState { hash: "0".repeat(64), size: 0, modified: 0 };
        files.files.insert("Year 2/LSINTT02/Cytology/Cells.md".into(), state.clone());
        files.files.insert("Top.md".into(), state.clone());
        files.files.insert(".scalenote/folder-icons.json".into(), state);
        assert_eq!(known(Some(set(&["Empty"])), &files), set(&["Empty", "Year 2", "Year 2/LSINTT02", "Year 2/LSINTT02/Cytology"]));
        assert_eq!(known(None, &Manifest::default()), set(&[]));
    }

    #[test]
    fn the_saved_list_reads_back_and_a_damaged_one_is_ignored() {
        let dir = std::env::temp_dir().join(format!("scalenote-foldersync-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).expect("dir");
        let folders = set(&["A", "A/B c"]);
        save(&dir, "0011223344556677", &folders).expect("save");
        assert_eq!(load(&dir, "0011223344556677"), Some(folders));
        fs::write(base_path(&dir, "0011223344556677"), "scalenote-folder-base 1\n../out\n").expect("write");
        assert_eq!(load(&dir, "0011223344556677"), None);
        forget(&dir, "0011223344556677");
        assert_eq!(load(&dir, "0011223344556677"), None);
        let _ = fs::remove_dir_all(&dir);
    }
}
