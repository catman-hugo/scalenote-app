//! A vault is a normal folder. Notes are `.md` files in it.
//!
//! Everything that touches the folder goes through `Vault`, which refuses any path that
//! would leave the folder, writes safely, and notices when a file was changed by another
//! program while the app had it open.

use crate::atomic::{remove_stale_temp_files, write_atomic};
use crate::names::sanitize_name;
use std::fmt;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::time::Duration;

/// Largest note we open or save. Anything bigger is almost certainly not a hand-written
/// note, and reading it whole could freeze the app.
pub const MAX_NOTE_BYTES: u64 = 8 * 1024 * 1024;
/// Limits so a huge or looping folder cannot freeze the sidebar.
pub const MAX_TREE_ENTRIES: usize = 300_000;
pub const MAX_TREE_DEPTH: usize = 40;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum VaultError {
    NotFound,
    NotADirectory,
    InvalidPath,
    NotANote,
    TooLarge,
    NotUtf8,
    /// The file on disk is not the version the caller started from.
    Conflict,
    AlreadyExists,
    /// A file that is not one of the allowed picture types.
    UnsupportedType,
    /// Anything else the operating system reported. The text is for the log only.
    Io(String),
}

impl VaultError {
    /// A short stable code. The interface turns it into a sentence from the language file.
    pub fn code(&self) -> &'static str {
        match self {
            VaultError::NotFound => "not_found",
            VaultError::NotADirectory => "not_a_directory",
            VaultError::InvalidPath => "invalid_path",
            VaultError::NotANote => "not_a_note",
            VaultError::TooLarge => "too_large",
            VaultError::NotUtf8 => "not_utf8",
            VaultError::Conflict => "conflict",
            VaultError::AlreadyExists => "already_exists",
            VaultError::UnsupportedType => "unsupported_type",
            VaultError::Io(_) => "io",
        }
    }
}

impl fmt::Display for VaultError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            VaultError::Io(detail) => write!(f, "io: {detail}"),
            other => write!(f, "{}", other.code()),
        }
    }
}

impl From<io::Error> for VaultError {
    fn from(error: io::Error) -> Self {
        match error.kind() {
            io::ErrorKind::NotFound => VaultError::NotFound,
            io::ErrorKind::AlreadyExists => VaultError::AlreadyExists,
            _ => VaultError::Io(error.to_string()),
        }
    }
}

pub type Result<T> = std::result::Result<T, VaultError>;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EntryKind {
    Folder,
    Note,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Entry {
    /// Path inside the vault, always with `/` as the separator.
    pub path: String,
    pub name: String,
    pub kind: EntryKind,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Tree {
    pub entries: Vec<Entry>,
    /// True when the limits cut the listing short.
    pub truncated: bool,
}

/// Identifies the exact content of a note, so the app can tell whether the file changed
/// on disk since it was read. It is a content fingerprint, not a security measure.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct NoteVersion {
    pub len: u64,
    pub hash: u64,
}

impl NoteVersion {
    pub fn of(bytes: &[u8]) -> NoteVersion {
        // FNV-1a: simple, fast and the same on every platform.
        let mut hash: u64 = 0xcbf29ce484222325;
        for byte in bytes {
            hash ^= u64::from(*byte);
            hash = hash.wrapping_mul(0x100000001b3);
        }
        NoteVersion { len: bytes.len() as u64, hash }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NoteContent {
    pub text: String,
    pub version: NoteVersion,
}

pub struct Vault {
    /// Canonical (symlinks resolved) path of the vault folder.
    root: PathBuf,
}

impl Vault {
    /// Opens an existing folder as a vault.
    pub fn open(root: &Path) -> Result<Vault> {
        let canonical = fs::canonicalize(root)?;
        if !canonical.is_dir() {
            return Err(VaultError::NotADirectory);
        }
        Ok(Vault { root: canonical })
    }

    /// Opens the folder, creating it first when it does not exist.
    pub fn open_or_create(root: &Path) -> Result<Vault> {
        if !root.exists() {
            fs::create_dir_all(root)?;
        }
        Vault::open(root)
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    /// Removes leftovers from an earlier crash. Called once when a vault is opened.
    pub fn clean_up_leftovers(&self) -> usize {
        remove_stale_temp_files(&self.root, Duration::from_secs(60))
    }

    /// Turns a vault-relative path such as `School/Week 1.md` into a real path,
    /// refusing anything that could point outside the vault.
    pub(crate) fn resolve(&self, relative: &str) -> Result<PathBuf> {
        if relative.is_empty() {
            return Ok(self.root.clone());
        }
        if relative.contains('\0') || relative.contains('\\') || relative.starts_with('/') {
            return Err(VaultError::InvalidPath);
        }
        let mut path = self.root.clone();
        for part in relative.split('/') {
            let bad = part.is_empty() || part == "." || part == ".." || part.starts_with('.');
            #[cfg(windows)]
            let bad = bad || part.contains(':');
            if bad {
                return Err(VaultError::InvalidPath);
            }
            path.push(part);
        }
        self.ensure_inside(&path)?;
        Ok(path)
    }

    /// A symlink inside the vault could point anywhere. Resolve the nearest part of the
    /// path that exists and make sure it is still inside the vault.
    pub(crate) fn ensure_inside(&self, path: &Path) -> Result<()> {
        let mut probe = path.to_path_buf();
        loop {
            if probe.exists() {
                let canonical = fs::canonicalize(&probe)?;
                return if canonical.starts_with(&self.root) {
                    Ok(())
                } else {
                    Err(VaultError::InvalidPath)
                };
            }
            if !probe.pop() {
                return Err(VaultError::InvalidPath);
            }
        }
    }

    fn relative_string(&self, path: &Path) -> Option<String> {
        let relative = path.strip_prefix(&self.root).ok()?;
        let parts: Option<Vec<&str>> = relative.components().map(|c| c.as_os_str().to_str()).collect();
        Some(parts?.join("/"))
    }

    /// Lists every folder and note, depth first, folders before notes, names in a
    /// case-insensitive order. Hidden entries (starting with a dot) are skipped, so
    /// `.obsidian`, `.git` and our own cache folder never show up. Other file types are
    /// ignored but never touched.
    pub fn tree(&self) -> Result<Tree> {
        let mut entries = Vec::new();
        let mut truncated = false;
        self.walk(&self.root, 0, &mut entries, &mut truncated);
        Ok(Tree { entries, truncated })
    }

    fn walk(&self, dir: &Path, depth: usize, out: &mut Vec<Entry>, truncated: &mut bool) {
        if depth >= MAX_TREE_DEPTH {
            *truncated = true;
            return;
        }
        let Ok(read) = fs::read_dir(dir) else {
            return;
        };
        let mut folders: Vec<(String, PathBuf)> = Vec::new();
        let mut notes: Vec<(String, PathBuf)> = Vec::new();
        for entry in read.flatten() {
            let Ok(file_type) = entry.file_type() else {
                continue;
            };
            let Some(name) = entry.file_name().to_str().map(str::to_owned) else {
                continue;
            };
            if name.starts_with('.') {
                continue;
            }
            // The folder that holds pictures is not a place for notes, so it is not listed.
            if depth == 0 && name == crate::attachments::ATTACHMENT_DIR && file_type.is_dir() {
                continue;
            }
            // Symlinked folders are skipped so a loop can never hang the listing.
            if file_type.is_dir() {
                folders.push((name, entry.path()));
            } else if file_type.is_file() && has_md_extension(&name) {
                notes.push((name, entry.path()));
            }
        }
        folders.sort_by_key(|(name, _)| name.to_lowercase());
        notes.sort_by_key(|(name, _)| name.to_lowercase());

        for (name, path) in folders {
            if out.len() >= MAX_TREE_ENTRIES {
                *truncated = true;
                return;
            }
            let Some(relative) = self.relative_string(&path) else {
                continue;
            };
            out.push(Entry { path: relative, name, kind: EntryKind::Folder });
            self.walk(&path, depth + 1, out, truncated);
        }
        for (name, path) in notes {
            if out.len() >= MAX_TREE_ENTRIES {
                *truncated = true;
                return;
            }
            let Some(relative) = self.relative_string(&path) else {
                continue;
            };
            out.push(Entry { path: relative, name, kind: EntryKind::Note });
        }
    }

    pub fn read_note(&self, relative: &str) -> Result<NoteContent> {
        let path = self.note_path(relative)?;
        let meta = fs::metadata(&path)?;
        if !meta.is_file() {
            return Err(VaultError::NotANote);
        }
        if meta.len() > MAX_NOTE_BYTES {
            return Err(VaultError::TooLarge);
        }
        let bytes = fs::read(&path)?;
        let version = NoteVersion::of(&bytes);
        // A note that is not valid UTF-8 is refused instead of being converted. Saving a
        // converted copy back would silently change the file.
        let text = String::from_utf8(bytes).map_err(|_| VaultError::NotUtf8)?;
        Ok(NoteContent { text, version })
    }

    /// Saves a note safely.
    ///
    /// `expected` is the version the caller last read. If the file on disk is different,
    /// somebody else changed it and nothing is written: the file on disk wins, and the
    /// caller decides what to tell the user. For a new file pass `None`.
    ///
    /// There is a tiny gap between this check and the rename in which another program
    /// could still write. That is accepted: closing it would need file locks, which do
    /// not work across the file systems and sync tools people use with a vault.
    pub fn write_note(
        &self,
        relative: &str,
        text: &str,
        expected: Option<NoteVersion>,
    ) -> Result<NoteVersion> {
        let path = self.note_path(relative)?;
        if text.len() as u64 > MAX_NOTE_BYTES {
            return Err(VaultError::TooLarge);
        }
        match (fs::read(&path), expected) {
            (Ok(current), Some(expected)) => {
                if NoteVersion::of(&current) != expected {
                    return Err(VaultError::Conflict);
                }
            }
            (Ok(_), None) => return Err(VaultError::Conflict),
            (Err(error), Some(_)) if error.kind() == io::ErrorKind::NotFound => {
                return Err(VaultError::Conflict);
            }
            (Err(error), None) if error.kind() == io::ErrorKind::NotFound => {}
            (Err(error), _) => return Err(error.into()),
        }
        write_atomic(&path, text.as_bytes())?;
        Ok(NoteVersion::of(text.as_bytes()))
    }

    /// Creates an empty note named after `title` inside `parent`. If the name is taken a
    /// number is added. Returns the path of the new note.
    pub fn create_note(&self, parent: &str, title: &str) -> Result<String> {
        let dir = self.folder_path(parent)?;
        let stem = sanitize_name(title, "Untitled");
        for attempt in 1..=1000 {
            let name = numbered(&stem, attempt);
            let path = dir.join(format!("{name}.md"));
            // create_new fails if the name exists, so two creations can never collide.
            match fs::OpenOptions::new().write(true).create_new(true).open(&path) {
                Ok(_) => return self.relative_for_new(&path),
                Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
                Err(error) => return Err(error.into()),
            }
        }
        Err(VaultError::AlreadyExists)
    }

    pub fn create_folder(&self, parent: &str, name: &str) -> Result<String> {
        let dir = self.folder_path(parent)?;
        let stem = sanitize_name(name, "New folder");
        for attempt in 1..=1000 {
            let path = dir.join(numbered(&stem, attempt));
            match fs::create_dir(&path) {
                Ok(()) => return self.relative_for_new(&path),
                Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
                Err(error) => return Err(error.into()),
            }
        }
        Err(VaultError::AlreadyExists)
    }

    /// Renames a note or folder, keeping it in the same place. Never replaces anything.
    pub fn rename(&self, relative: &str, new_name: &str) -> Result<String> {
        if relative.is_empty() {
            return Err(VaultError::InvalidPath);
        }
        let path = self.resolve(relative)?;
        if !path.exists() {
            return Err(VaultError::NotFound);
        }
        let is_note = path.is_file();
        if is_note && !has_md_extension(relative) {
            return Err(VaultError::NotANote);
        }
        let stem = sanitize_name(new_name.trim_end_matches(".md"), "Untitled");
        let file_name = if is_note { format!("{stem}.md") } else { stem };
        let parent = path.parent().ok_or(VaultError::InvalidPath)?;
        let target = parent.join(file_name);
        if target == path {
            return self.relative_for_new(&path);
        }
        if target.exists() {
            return Err(VaultError::AlreadyExists);
        }
        fs::rename(&path, &target)?;
        self.relative_for_new(&target)
    }

    /// Moves a note or a folder (with everything in it) into another folder, keeping its
    /// name. `new_parent` is the target folder, or "" for the top of the vault. Never
    /// replaces anything, and a folder cannot be moved into itself or into one of its own
    /// subfolders. Moving something to the place it already is changes nothing.
    pub fn move_entry(&self, relative: &str, new_parent: &str) -> Result<String> {
        if relative.is_empty() {
            return Err(VaultError::InvalidPath);
        }
        let path = self.resolve(relative)?;
        if !path.exists() {
            return Err(VaultError::NotFound);
        }
        let is_note = path.is_file();
        if is_note && !has_md_extension(relative) {
            return Err(VaultError::NotANote);
        }
        // Compared as text on purpose: the target is checked to be inside the vault by
        // `folder_path`, and a folder is only "inside itself" if its own path leads to it.
        let inside_itself = new_parent == relative || new_parent.starts_with(&format!("{relative}/"));
        if !is_note && inside_itself {
            return Err(VaultError::InvalidPath);
        }
        let target_folder = self.folder_path(new_parent)?;
        let file_name = path.file_name().ok_or(VaultError::InvalidPath)?;
        let target = target_folder.join(file_name);
        if target == path {
            return self.relative_for_new(&path);
        }
        if target.exists() {
            return Err(VaultError::AlreadyExists);
        }
        fs::rename(&path, &target)?;
        self.relative_for_new(&target)
    }

    fn note_path(&self, relative: &str) -> Result<PathBuf> {
        if relative.is_empty() || !has_md_extension(relative) {
            return Err(VaultError::NotANote);
        }
        self.resolve(relative)
    }

    fn folder_path(&self, relative: &str) -> Result<PathBuf> {
        let path = self.resolve(relative)?;
        if !path.is_dir() {
            return Err(VaultError::NotADirectory);
        }
        Ok(path)
    }

    fn relative_for_new(&self, path: &Path) -> Result<String> {
        self.relative_string(path).ok_or(VaultError::InvalidPath)
    }
}

fn numbered(stem: &str, attempt: usize) -> String {
    if attempt == 1 {
        stem.to_string()
    } else {
        format!("{stem} {attempt}")
    }
}

/// Works on bytes, not on a slice of the text: slicing a name that ends in a multi-byte
/// character (for example "aéé") at a fixed offset would panic.
pub(crate) fn has_md_extension(name: &str) -> bool {
    let bytes = name.as_bytes();
    bytes.len() > 3 && bytes[bytes.len() - 3..].eq_ignore_ascii_case(b".md")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("sn-vault-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).expect("create scratch dir");
        dir
    }

    #[test]
    fn md_extension_check_is_case_insensitive_and_needs_a_name() {
        assert!(has_md_extension("a.md"));
        assert!(has_md_extension("A.MD"));
        assert!(!has_md_extension(".md"));
        assert!(!has_md_extension("a.txt"));
        assert!(!has_md_extension("md"));
    }

    #[test]
    fn numbering_adds_a_suffix_from_the_second_try() {
        assert_eq!(numbered("Note", 1), "Note");
        assert_eq!(numbered("Note", 2), "Note 2");
    }

    #[test]
    fn same_content_gives_same_version_and_changes_give_a_new_one() {
        let a = NoteVersion::of(b"hello");
        assert_eq!(a, NoteVersion::of(b"hello"));
        assert_ne!(a, NoteVersion::of(b"hellp"));
        assert_ne!(NoteVersion::of(b""), NoteVersion::of(b"\0"));
    }

    #[test]
    fn opening_a_missing_folder_fails_and_open_or_create_makes_it() {
        let dir = scratch("open");
        let missing = dir.join("new-vault");
        assert_eq!(Vault::open(&missing).err(), Some(VaultError::NotFound));
        assert!(Vault::open_or_create(&missing).is_ok());
        assert!(missing.is_dir());
    }
}
