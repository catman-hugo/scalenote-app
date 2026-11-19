//! Which notes folder on this device each paired device belongs to.
//!
//! Pairing is between devices, but a device can have several notes folders (and a home server
//! several vaults). Without this, a sync used whatever folder happened to be open, so a phone
//! paired with two server vaults could copy one folder's pages into the other. Now each paired
//! device is tied to one folder here: it is set when pairing (to the folder open then) or, for a
//! pairing made before this existed, at its first finished sync. A sync with a device tied to
//! another folder is refused on both sides, and the app says which folder to open.
//!
//! The file holds full paths on this device only; it is never synced. Format:
//!   scalenote-folders 1
//!   <device key in hex> <folder path>
//! It is read as untrusted input like the trust list. A damaged file is treated as empty and
//! rewritten at the next change: the devices then fall back to being tied at their next sync,
//! and a first sync in a folder still shows what it would change and waits for a yes.

use super::hex;
use super::identity::KEY_LEN;
use super::trust::MAX_PEERS;
use super::Result;
use crate::atomic::write_atomic;
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

const HEADER: &str = "scalenote-folders 1";
const MAX_FILE_BYTES: u64 = 512 * 1024;
const MAX_PATH_BYTES: usize = 4096;

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct FolderBook {
    folders: BTreeMap<[u8; KEY_LEN], PathBuf>,
}

impl FolderBook {
    pub fn folder_of(&self, key: &[u8; KEY_LEN]) -> Option<&Path> {
        self.folders.get(key).map(PathBuf::as_path)
    }

    /// Ties a device to a folder (replacing an earlier one). A path that cannot be written on one
    /// line is not kept; the device then stays untied, which is the old behaviour.
    pub fn tie(&mut self, key: [u8; KEY_LEN], folder: &Path) -> bool {
        let Some(text) = folder.to_str() else { return false };
        if text.is_empty() || text.len() > MAX_PATH_BYTES || text.contains(['\n', '\r']) {
            return false;
        }
        if !self.folders.contains_key(&key) && self.folders.len() >= MAX_PEERS {
            return false;
        }
        self.folders.insert(key, folder.to_path_buf());
        true
    }

    pub fn untie(&mut self, key: &[u8; KEY_LEN]) -> bool {
        self.folders.remove(key).is_some()
    }

    /// Whether a sync with `key` may use `root`: it is tied to that folder, or not tied at all.
    pub fn allows(&self, key: &[u8; KEY_LEN], root: &Path) -> bool {
        self.folder_of(key).map_or(true, |tied| same_folder(tied, root))
    }

    pub fn to_text(&self) -> String {
        let mut out = format!("{HEADER}\n");
        for (key, folder) in &self.folders {
            if let Some(text) = folder.to_str() {
                out.push_str(&format!("{} {}\n", hex::encode(key), text));
            }
        }
        out
    }

    pub fn from_text(text: &str) -> Option<FolderBook> {
        let mut lines = text.lines();
        if lines.next() != Some(HEADER) {
            return None;
        }
        let mut book = FolderBook::default();
        for line in lines {
            let (key, folder) = line.split_once(' ')?;
            let key = hex::decode::<KEY_LEN>(key)?;
            if !book.tie(key, Path::new(folder)) {
                return None;
            }
        }
        Some(book)
    }

    pub fn load(path: &Path) -> FolderBook {
        match fs::metadata(path) {
            Ok(meta) if meta.is_file() && meta.len() <= MAX_FILE_BYTES => fs::read_to_string(path).ok().and_then(|text| FolderBook::from_text(&text)).unwrap_or_default(),
            _ => FolderBook::default(),
        }
    }

    pub fn save(&self, path: &Path) -> Result<()> {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        write_atomic(path, self.to_text().as_bytes())?;
        Ok(())
    }
}

/// Two paths name the same folder: equal as written, or the same after resolving links and `..`
/// (when both exist).
pub fn same_folder(a: &Path, b: &Path) -> bool {
    if a == b {
        return true;
    }
    match (fs::canonicalize(a), fs::canonicalize(b)) {
        (Ok(a), Ok(b)) => a == b,
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_device_is_tied_to_one_folder_and_only_that_folder_is_allowed() {
        let mut book = FolderBook::default();
        let (alice, bob) = ([1u8; KEY_LEN], [2u8; KEY_LEN]);
        assert!(book.allows(&alice, Path::new("/notes/school")), "untied: the old behaviour");
        assert!(book.tie(alice, Path::new("/notes/school")));
        assert!(book.allows(&alice, Path::new("/notes/school")));
        assert!(!book.allows(&alice, Path::new("/notes/personal")));
        assert!(book.allows(&bob, Path::new("/notes/personal")));
        assert!(book.tie(alice, Path::new("/notes/personal")), "moving it to another folder");
        assert!(book.allows(&alice, Path::new("/notes/personal")));
        assert!(!book.allows(&alice, Path::new("/notes/school")));
        assert!(book.untie(&alice));
        assert!(!book.untie(&alice));
    }

    #[test]
    fn the_list_is_read_back_and_bad_files_or_paths_are_not_trusted() {
        let mut book = FolderBook::default();
        book.tie([1u8; KEY_LEN], Path::new("/home/alice/Notes with spaces"));
        book.tie([2u8; KEY_LEN], Path::new("C:\\Users\\bob\\Notes"));
        assert_eq!(FolderBook::from_text(&book.to_text()), Some(book.clone()));
        assert!(!book.tie([3u8; KEY_LEN], Path::new("/a\nb")), "no line breaks");
        assert!(!book.tie([3u8; KEY_LEN], Path::new("")));
        assert!(!book.tie([3u8; KEY_LEN], Path::new(&"x".repeat(MAX_PATH_BYTES + 1))));
        for bad in ["", "scalenote-folders 2\n", "scalenote-folders 1\nzz /a\n", "scalenote-folders 1\nnospace\n"] {
            assert_eq!(FolderBook::from_text(bad), None, "{bad:?}");
        }
        let mut full = FolderBook::default();
        for i in 0..MAX_PEERS {
            assert!(full.tie([i as u8; KEY_LEN], Path::new("/n")));
        }
        assert!(!full.tie([255u8; KEY_LEN], Path::new("/n")), "no more than the paired devices allowed");
    }

    #[test]
    fn the_same_folder_is_recognised_through_a_link_or_dots() {
        let dir = std::env::temp_dir().join(format!("sn-folders-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(dir.join("Notes")).expect("dir");
        assert!(same_folder(&dir.join("Notes"), &dir.join("Notes").join("..").join("Notes")));
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(dir.join("Notes"), dir.join("link")).expect("link");
            assert!(same_folder(&dir.join("Notes"), &dir.join("link")));
        }
        assert!(!same_folder(&dir.join("Notes"), &dir.join("Other")));
        let _ = fs::remove_dir_all(&dir);
    }
}
