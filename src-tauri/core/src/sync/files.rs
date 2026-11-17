//! Reading, writing and removing single files of the vault for a sync, on this device.
//!
//! Every path here came from another device or from a list made from one, so it is untrusted:
//! it must pass `safe_path`, and no part of it may be a link, so a file can never land outside
//! the vault. Every change says what it expects to find ("this hash" or "nothing"); if the file
//! is something else by now (the person kept typing, or another sync ran) nothing is changed and
//! `Changed` is returned. Writes are atomic (temporary file, then rename). A removal is always a
//! move to the trash.

use super::manifest::{hash_bytes, safe_path, MAX_PATH_BYTES};
use super::{Result, SyncError};
use crate::atomic::write_atomic;
use crate::vault::Vault;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::time::{Duration, UNIX_EPOCH};

/// The biggest file one sync moves. A file is held in memory while it travels, so this is lower
/// than the 256 MB that the list allows; bigger files are reported and left alone.
pub const MAX_TRANSFER_BYTES: u64 = 64 * 1024 * 1024;

/// What a change expects to find at the path right now.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Expect<'a> {
    /// There must be no file.
    Absent,
    /// There must be a file with this content hash.
    Hash(&'a str),
}

impl<'a> Expect<'a> {
    /// The text form used on the wire: `-` for no file, otherwise the hash.
    pub fn to_wire(self) -> &'a str {
        match self {
            Expect::Absent => "-",
            Expect::Hash(hash) => hash,
        }
    }

    pub fn from_wire(text: &'a str) -> Option<Expect<'a>> {
        if text == "-" {
            Some(Expect::Absent)
        } else if text.len() == 64 && text.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)) {
            Some(Expect::Hash(text))
        } else {
            None
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Done {
    /// The change was made (or there was nothing left to do).
    Applied,
    /// The file was not what the change expected; nothing was touched.
    Changed,
}

/// The place on disk for a path from a list. Refuses anything that is not a safe path and any
/// path that goes through a link.
fn disk_path(root: &Path, relative: &str) -> Result<PathBuf> {
    if !safe_path(relative) || relative.len() > MAX_PATH_BYTES {
        return Err(SyncError::Refused("path not allowed"));
    }
    let mut path = root.to_path_buf();
    for part in relative.split('/') {
        path.push(part);
        // A part that exists must be a real folder (or, last, a real file), never a link.
        match fs::symlink_metadata(&path) {
            Ok(meta) if meta.file_type().is_symlink() => return Err(SyncError::Refused("path goes through a link")),
            Ok(_) | Err(_) => {}
        }
    }
    Ok(path)
}

fn state_of(path: &Path) -> Result<Option<fs::Metadata>> {
    match fs::symlink_metadata(path) {
        Ok(meta) if meta.is_file() => Ok(Some(meta)),
        Ok(_) => Err(SyncError::Refused("not an ordinary file")),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.into()),
    }
}

/// The content hash of the file at `relative`, or `None` when there is none.
pub fn current_hash(root: &Path, relative: &str) -> Result<Option<String>> {
    let path = disk_path(root, relative)?;
    match state_of(&path)? {
        None => Ok(None),
        Some(meta) if meta.len() > MAX_TRANSFER_BYTES => Err(SyncError::Refused("file too big")),
        Some(_) => Ok(Some(hash_bytes(&fs::read(&path)?))),
    }
}

fn matches(found: &Option<String>, expect: Expect) -> bool {
    match (found, expect) {
        (None, Expect::Absent) => true,
        (Some(hash), Expect::Hash(wanted)) => hash == wanted,
        _ => false,
    }
}

/// Reads a file, but only if it still has the hash the list said. `None` when it is gone or
/// has changed.
pub fn read_expected(root: &Path, relative: &str, hash: &str) -> Result<Option<Vec<u8>>> {
    let path = disk_path(root, relative)?;
    let Some(meta) = state_of(&path)? else { return Ok(None) };
    if meta.len() > MAX_TRANSFER_BYTES {
        return Err(SyncError::Refused("file too big"));
    }
    let bytes = fs::read(&path)?;
    Ok((hash_bytes(&bytes) == hash).then_some(bytes))
}

/// Whether another name in the same folder differs from `name` only by upper/lower case.
fn case_clash(parent: &Path, name: &str) -> bool {
    let Ok(entries) = fs::read_dir(parent) else { return false };
    let lower = name.to_lowercase();
    entries.flatten().any(|e| e.file_name().to_str().is_some_and(|other| other != name && other.to_lowercase() == lower))
}

/// Writes `bytes` to `relative`, if the file is what `expect` says. `modified` (seconds since
/// 1970) is given to the new file so both sides agree on how old it is.
pub fn put(root: &Path, relative: &str, expect: Expect, bytes: &[u8], modified: Option<u64>) -> Result<Done> {
    if bytes.len() as u64 > MAX_TRANSFER_BYTES {
        return Err(SyncError::Refused("file too big"));
    }
    let path = disk_path(root, relative)?;
    if !matches(&current_hash(root, relative)?, expect) {
        return Ok(Done::Changed);
    }
    let parent = path.parent().ok_or(SyncError::Refused("path not allowed"))?;
    if expect == Expect::Absent {
        let name = path.file_name().and_then(|n| n.to_str()).ok_or(SyncError::Refused("path not allowed"))?;
        if case_clash(parent, name) {
            return Err(SyncError::Refused("name differs only by case"));
        }
    }
    fs::create_dir_all(parent)?;
    write_atomic(&path, bytes)?;
    if let Some(seconds) = modified.filter(|s| *s > 0) {
        // Best effort: if the time cannot be set, the file simply keeps today's time.
        if let Ok(file) = fs::OpenOptions::new().write(true).open(&path) {
            let _ = file.set_modified(UNIX_EPOCH + Duration::from_secs(seconds));
        }
    }
    Ok(Done::Applied)
}

/// Moves the file at `relative` to the trash, if it is what `expect` says. A file that is
/// already gone counts as done.
pub fn remove(root: &Path, relative: &str, expected_hash: &str) -> Result<Done> {
    match current_hash(root, relative)? {
        None => Ok(Done::Applied),
        Some(hash) if hash == expected_hash => {
            let vault = Vault::open(root).map_err(|_| SyncError::Refused("not a vault"))?;
            vault.move_file_to_trash(relative).map_err(|_| SyncError::Refused("could not move to the trash"))?;
            Ok(Done::Applied)
        }
        Some(_) => Ok(Done::Changed),
    }
}
