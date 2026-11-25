//! The text of each page as both devices had it after their last sync (0.6.4).
//!
//! Joining two edits of a page (textmerge.rs) needs the version they started from. The saved list
//! of a sync (`sync-base-<device>.txt`) only holds each file's fingerprint, so after each sync the
//! pages both devices have the same are also copied here, per paired device:
//! `.scalenote/sync-text-<device>/<path of the page>`. Only pages (`.md`) up to the merge limit
//! are kept, and a copy is only written when the page changed since the last sync. Hidden folders
//! are never synced and Obsidian does not show them.

use super::manifest::{safe_path, Manifest};
use super::Result;
use crate::atomic::write_atomic;
use crate::textmerge::MAX_MERGE_BYTES;
use std::fs;
use std::path::{Path, PathBuf};

fn dir(root: &Path, peer_hex: &str) -> PathBuf {
    root.join(".scalenote").join(format!("sync-text-{peer_hex}"))
}

fn is_page(path: &str, size: u64) -> bool {
    path.ends_with(".md") && size as usize <= MAX_MERGE_BYTES && safe_path(path)
}

/// The text of `path` as both devices had it after their last sync, if it was kept.
pub fn read(root: &Path, peer_hex: &str, path: &str) -> Option<String> {
    if !safe_path(path) {
        return None;
    }
    let file = dir(root, peer_hex).join(path);
    let meta = fs::symlink_metadata(&file).ok()?;
    if !meta.is_file() || meta.len() as usize > MAX_MERGE_BYTES {
        return None;
    }
    fs::read_to_string(file).ok()
}

/// After a sync: keeps a copy of every page in `same` (the files both devices now have alike)
/// that changed since `before` (the saved list of the sync before), and removes the copies of
/// pages that are no longer alike. A page that changed on disk in the meantime is skipped; it is
/// simply not joined next time.
pub fn update(root: &Path, peer_hex: &str, before: Option<&Manifest>, same: &Manifest) -> Result<()> {
    let base = dir(root, peer_hex);
    for (path, state) in &same.files {
        if !is_page(path, state.size) {
            continue;
        }
        let copy = base.join(path);
        let unchanged = before.and_then(|b| b.files.get(path)).is_some_and(|b| b.hash == state.hash);
        if unchanged && copy.is_file() {
            continue;
        }
        if super::files::current_hash(root, path)?.as_deref() != Some(state.hash.as_str()) {
            continue;
        }
        let Ok(bytes) = fs::read(root.join(path)) else { continue };
        if let Some(parent) = copy.parent() {
            fs::create_dir_all(parent)?;
        }
        write_atomic(&copy, &bytes)?;
    }
    if let Some(before) = before {
        for path in before.files.keys().filter(|p| p.ends_with(".md") && !same.files.contains_key(*p) && safe_path(p)) {
            let _ = fs::remove_file(base.join(path));
        }
    }
    Ok(())
}

/// Removes every kept text for a device (when it is removed).
pub fn forget(root: &Path, peer_hex: &str) {
    let _ = fs::remove_dir_all(dir(root, peer_hex));
}
