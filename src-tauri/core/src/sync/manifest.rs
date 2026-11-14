//! What every file of a vault looked like: the list that two devices compare.
//!
//! A manifest is a list of `path -> (content hash, size, time changed)`. Two copies of a vault
//! are the same when their lists have the same hashes; the plan (plan.rs) says what to do when
//! they are not. Only the hash and size decide whether content is the same; the time is only
//! used to say which of two different versions is the newer one.
//!
//! What goes in the list: every ordinary file in the visible folders (pages, pictures, PDFs,
//! drawings) and the one small settings file of the notes (`.scalenote/folder-icons.json`).
//! What does not: the trash, the page history, other hidden folders, temporary files of a write
//! that was cut off, and links (a link could lead out of the vault, so it is never followed).
//! A file that is left out because it is too big, unreadable or has a name another system cannot
//! hold is reported in `skipped`, so the sync can say so and never treat it as deleted.
//!
//! The list can be written as text and read back. What is read is untrusted (it comes from
//! another device): its size, the number of lines, every path and every hash are checked.

use super::{Result, SyncError};
use crate::atomic::TEMP_SUFFIX;
use crate::foldericons::SETTINGS_DIR;
use crate::names::RESERVED;
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::fs;
use std::io;
use std::path::Path;
use std::time::UNIX_EPOCH;

/// The most files one sync takes on. A vault with more is refused instead of half synced.
pub const MAX_FILES: usize = 200_000;
/// The biggest single file a sync moves. Bigger files are left alone and reported.
pub const MAX_FILE_BYTES: u64 = 256 * 1024 * 1024;
/// Longest path (in bytes) and longest single name (in bytes) that is accepted.
pub const MAX_PATH_BYTES: usize = 1024;
pub const MAX_NAME_BYTES: usize = 255;
/// How many folders deep the walk goes.
pub const MAX_DEPTH: usize = 32;
/// The most text a manifest read from elsewhere may have.
pub const MAX_MANIFEST_BYTES: usize = 64 * 1024 * 1024;

const HEADER: &str = "scalenote-manifest 1";
/// The one hidden file that is synced: the colours and icons of folders and pages.
const SETTINGS_FILE: &str = ".scalenote/folder-icons.json";

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FileState {
    /// SHA-256 of the content, as 64 lower case hex digits.
    pub hash: String,
    pub size: u64,
    /// Seconds since 1970 when the file was last changed (0 when unknown).
    pub modified: u64,
}

impl FileState {
    /// Whether two files have the same content. The time is not looked at.
    pub fn same_content(&self, other: &FileState) -> bool {
        self.hash == other.hash && self.size == other.size
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Manifest {
    pub files: BTreeMap<String, FileState>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SkipReason {
    /// A link or something that is not an ordinary file.
    NotAFile,
    TooBig,
    Unreadable,
    /// The name has characters or a shape that Windows, Android or Linux cannot all hold.
    NotPortable,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Skip {
    pub path: String,
    pub reason: SkipReason,
}

pub struct Scan {
    pub manifest: Manifest,
    pub skipped: Vec<Skip>,
}

/// Whether one name (a file or a folder) is something every system can hold.
pub fn portable_name(name: &str) -> bool {
    if name.is_empty() || name.len() > MAX_NAME_BYTES || name == "." || name == ".." {
        return false;
    }
    if name.chars().any(|c| c.is_control() || "<>:\"/\\|?*".contains(c)) {
        return false;
    }
    if name.ends_with('.') || name.ends_with(' ') {
        return false;
    }
    let stem = name.split('.').next().unwrap_or("").to_uppercase();
    !RESERVED.contains(&stem.as_str())
}

/// Whether `path` (with `/` between folders) is a path that may be in a manifest: relative,
/// made only of portable names, not hidden (except the one settings file), not too long.
pub fn safe_path(path: &str) -> bool {
    if path.is_empty() || path.len() > MAX_PATH_BYTES || path.starts_with('/') {
        return false;
    }
    if path == SETTINGS_FILE {
        return true;
    }
    let mut depth = 0;
    for part in path.split('/') {
        depth += 1;
        if depth > MAX_DEPTH || !portable_name(part) || part.starts_with('.') || part.ends_with(TEMP_SUFFIX) {
            return false;
        }
    }
    true
}

fn hash_file(path: &Path) -> io::Result<String> {
    let mut file = fs::File::open(path)?;
    let mut hasher = Sha256::new();
    io::copy(&mut file, &mut hasher)?;
    Ok(to_hex(&hasher.finalize()))
}

/// The hash of some bytes, as the manifest writes it.
pub fn hash_bytes(bytes: &[u8]) -> String {
    to_hex(&Sha256::digest(bytes))
}

fn to_hex(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push_str(&format!("{byte:02x}"));
    }
    out
}

fn is_hash(text: &str) -> bool {
    text.len() == 64 && text.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

fn modified_seconds(meta: &fs::Metadata) -> u64 {
    meta.modified().ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map_or(0, |d| d.as_secs())
}

impl Manifest {
    /// Looks at every file of the vault at `root`. A folder that cannot be read is an error;
    /// a single file that cannot be used is listed in `skipped`.
    pub fn scan(root: &Path) -> Result<Scan> {
        let mut manifest = Manifest::default();
        let mut skipped = Vec::new();
        let mut stack = vec![(root.to_path_buf(), String::new(), 0usize)];
        while let Some((dir, prefix, depth)) = stack.pop() {
            for entry in fs::read_dir(&dir)? {
                let entry = entry?;
                let os_name = entry.file_name();
                let Some(name) = os_name.to_str() else {
                    skipped.push(Skip { path: format!("{prefix}{}", os_name.to_string_lossy()), reason: SkipReason::NotPortable });
                    continue;
                };
                let relative = format!("{prefix}{name}");
                // Hidden things and leftovers of a cut-off write are not part of a vault's notes.
                if name.ends_with(TEMP_SUFFIX) {
                    continue;
                }
                let meta = match fs::symlink_metadata(entry.path()) {
                    Ok(meta) => meta,
                    Err(_) => {
                        skipped.push(Skip { path: relative, reason: SkipReason::Unreadable });
                        continue;
                    }
                };
                if name.starts_with('.') {
                    if name == SETTINGS_DIR && meta.is_dir() && prefix.is_empty() {
                        let settings = entry.path().join("folder-icons.json");
                        if let Ok(file_meta) = fs::symlink_metadata(&settings) {
                            if file_meta.is_file() {
                                Self::add(&mut manifest, &mut skipped, SETTINGS_FILE.to_string(), &settings, &file_meta)?;
                            }
                        }
                    }
                    continue;
                }
                if meta.file_type().is_symlink() {
                    skipped.push(Skip { path: relative, reason: SkipReason::NotAFile });
                } else if meta.is_dir() {
                    if !portable_name(name) || depth + 1 > MAX_DEPTH {
                        skipped.push(Skip { path: relative, reason: SkipReason::NotPortable });
                    } else {
                        stack.push((entry.path(), format!("{relative}/"), depth + 1));
                    }
                } else if meta.is_file() {
                    Self::add(&mut manifest, &mut skipped, relative, &entry.path(), &meta)?;
                } else {
                    skipped.push(Skip { path: relative, reason: SkipReason::NotAFile });
                }
            }
        }
        skipped.sort_by(|a, b| a.path.cmp(&b.path));
        Ok(Scan { manifest, skipped })
    }

    fn add(manifest: &mut Manifest, skipped: &mut Vec<Skip>, relative: String, path: &Path, meta: &fs::Metadata) -> Result<()> {
        if !safe_path(&relative) {
            skipped.push(Skip { path: relative, reason: SkipReason::NotPortable });
            return Ok(());
        }
        if meta.len() > MAX_FILE_BYTES {
            skipped.push(Skip { path: relative, reason: SkipReason::TooBig });
            return Ok(());
        }
        if manifest.files.len() >= MAX_FILES {
            return Err(SyncError::TooManyFiles);
        }
        match hash_file(path) {
            Ok(hash) => {
                manifest.files.insert(relative, FileState { hash, size: meta.len(), modified: modified_seconds(meta) });
            }
            Err(_) => skipped.push(Skip { path: relative, reason: SkipReason::Unreadable }),
        }
        Ok(())
    }

    /// The list as text: a header line, then `hash size modified path` for every file.
    pub fn to_text(&self) -> String {
        let mut out = String::from(HEADER);
        out.push('\n');
        for (path, state) in &self.files {
            out.push_str(&format!("{} {} {} {path}\n", state.hash, state.size, state.modified));
        }
        out
    }

    /// Reads a list back. Anything that is not exactly what `to_text` writes is refused.
    pub fn from_text(text: &str) -> Result<Manifest> {
        if text.len() > MAX_MANIFEST_BYTES {
            return Err(SyncError::Damaged("manifest too big"));
        }
        let mut lines = text.split('\n');
        if lines.next() != Some(HEADER) {
            return Err(SyncError::Damaged("manifest header"));
        }
        let mut files = BTreeMap::new();
        let mut rest: Vec<&str> = lines.collect();
        // The text ends with a newline, so the last piece is empty.
        if rest.pop() != Some("") {
            return Err(SyncError::Damaged("manifest end"));
        }
        for line in rest {
            let mut parts = line.splitn(4, ' ');
            let (Some(hash), Some(size), Some(modified), Some(path)) = (parts.next(), parts.next(), parts.next(), parts.next()) else {
                return Err(SyncError::Damaged("manifest line"));
            };
            let (Ok(size), Ok(modified)) = (size.parse::<u64>(), modified.parse::<u64>()) else {
                return Err(SyncError::Damaged("manifest number"));
            };
            if !is_hash(hash) || !safe_path(path) || size > MAX_FILE_BYTES {
                return Err(SyncError::Damaged("manifest entry"));
            }
            if files.len() >= MAX_FILES {
                return Err(SyncError::TooManyFiles);
            }
            if files.insert(path.to_string(), FileState { hash: hash.to_string(), size, modified }).is_some() {
                return Err(SyncError::Damaged("manifest repeats a path"));
            }
        }
        Ok(Manifest { files })
    }
}
