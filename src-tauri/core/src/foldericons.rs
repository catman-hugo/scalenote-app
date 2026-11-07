//! The look of folders (icon style and colour), kept in one small hidden file in the vault.
//!
//! `.scalenote/folder-icons.json` sits at the top of the vault. A hidden folder is not listed as
//! a page folder, Obsidian ignores it, and the note files are never touched, so choosing a colour
//! cannot damage a note. Because it is a plain file inside the vault it is synced and copied with
//! the rest of the vault.
//!
//! As with the drawing of a page, this file only stores the text the interface gives it. What
//! is inside is checked by the interface when it is read, because the file may have come from
//! another device or another program. Here the rules are: a size limit, an exact-version check
//! so two writers cannot overwrite each other, and an atomic write.

use crate::atomic::write_atomic;
use crate::vault::{NoteContent, NoteVersion, Result, Vault, VaultError};
use std::fs;
use std::io;
use std::path::PathBuf;

/// Plenty for thousands of folders, small enough that a damaged or hostile file is harmless.
pub const MAX_FOLDER_ICONS_BYTES: u64 = 256 * 1024;

/// Hidden folder at the top of the vault that holds ScaleNote's own small settings files.
pub const SETTINGS_DIR: &str = ".scalenote";
const FILE_NAME: &str = "folder-icons.json";

impl Vault {
    fn folder_icons_path(&self) -> PathBuf {
        self.root().join(SETTINGS_DIR).join(FILE_NAME)
    }

    /// The folder icon file, or `None` when nothing has been chosen yet.
    pub fn read_folder_icons(&self) -> Result<Option<NoteContent>> {
        let path = self.folder_icons_path();
        let meta = match fs::symlink_metadata(&path) {
            Ok(meta) => meta,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(error.into()),
        };
        // A link is never followed: it could lead out of the vault.
        if !meta.is_file() {
            return Err(VaultError::NotANote);
        }
        if meta.len() > MAX_FOLDER_ICONS_BYTES {
            return Err(VaultError::TooLarge);
        }
        let bytes = fs::read(&path)?;
        let version = NoteVersion::of(&bytes);
        let text = String::from_utf8(bytes).map_err(|_| VaultError::NotUtf8)?;
        Ok(Some(NoteContent { text, version }))
    }

    /// Saves the file. `expected` is the version last read, or `None` when there was no file.
    pub fn write_folder_icons(&self, text: &str, expected: Option<NoteVersion>) -> Result<NoteVersion> {
        let path = self.folder_icons_path();
        if text.len() as u64 > MAX_FOLDER_ICONS_BYTES {
            return Err(VaultError::TooLarge);
        }
        match (fs::symlink_metadata(&path), expected) {
            (Ok(meta), Some(expected)) => {
                if !meta.is_file() || meta.len() > MAX_FOLDER_ICONS_BYTES || NoteVersion::of(&fs::read(&path)?) != expected {
                    return Err(VaultError::Conflict);
                }
            }
            (Ok(_), None) => return Err(VaultError::Conflict),
            (Err(error), Some(_)) if error.kind() == io::ErrorKind::NotFound => return Err(VaultError::Conflict),
            (Err(error), None) if error.kind() == io::ErrorKind::NotFound => self.make_settings_dir()?,
            (Err(error), _) => return Err(error.into()),
        }
        write_atomic(&path, text.as_bytes())?;
        Ok(NoteVersion::of(text.as_bytes()))
    }

    /// Creates the hidden folder, but never writes through a link in its place.
    fn make_settings_dir(&self) -> Result<()> {
        let dir = self.root().join(SETTINGS_DIR);
        match fs::symlink_metadata(&dir) {
            Ok(meta) if meta.is_dir() => Ok(()),
            Ok(_) => Err(VaultError::NotADirectory),
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(fs::create_dir(&dir)?),
            Err(error) => Err(error.into()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn vault(name: &str) -> (PathBuf, Vault) {
        let dir = std::env::temp_dir().join(format!("sn-icons-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(dir.join("School")).expect("dirs");
        let vault = Vault::open(&dir).expect("open");
        (dir, vault)
    }

    #[test]
    fn nothing_is_there_until_something_is_chosen() {
        let (dir, vault) = vault("none");
        assert!(vault.read_folder_icons().expect("read").is_none());
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn the_file_is_written_read_and_replaced_with_the_version_check() {
        let (dir, vault) = vault("basic");
        let v1 = vault.write_folder_icons("{\"a\":1}", None).expect("first");
        assert!(dir.join(SETTINGS_DIR).join(FILE_NAME).is_file());
        assert_eq!(vault.read_folder_icons().expect("read").expect("some").text, "{\"a\":1}");
        let v2 = vault.write_folder_icons("{\"a\":2}", Some(v1)).expect("second");
        assert_eq!(vault.write_folder_icons("{\"a\":3}", Some(v1)), Err(VaultError::Conflict));
        assert_eq!(vault.write_folder_icons("{\"a\":3}", None), Err(VaultError::Conflict));
        assert!(vault.write_folder_icons("{\"a\":3}", Some(v2)).is_ok());
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn a_missing_file_with_an_expected_version_is_a_conflict() {
        let (dir, vault) = vault("gone");
        let version = NoteVersion::of(b"x");
        assert_eq!(vault.write_folder_icons("{}", Some(version)), Err(VaultError::Conflict));
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn the_hidden_folder_never_shows_up_as_a_page_folder() {
        let (dir, vault) = vault("hidden");
        vault.write_folder_icons("{}", None).expect("write");
        let tree = vault.tree().expect("tree");
        assert!(tree.entries.iter().all(|entry| !entry.path.contains(SETTINGS_DIR)));
        assert!(tree.entries.iter().any(|entry| entry.path == "School"));
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn too_large_and_not_text_are_refused() {
        let (dir, vault) = vault("limits");
        let big = "x".repeat(MAX_FOLDER_ICONS_BYTES as usize + 1);
        assert_eq!(vault.write_folder_icons(&big, None), Err(VaultError::TooLarge));
        fs::create_dir_all(dir.join(SETTINGS_DIR)).expect("dir");
        fs::write(dir.join(SETTINGS_DIR).join(FILE_NAME), [0xff, 0xfe, 0xfd]).expect("bytes");
        assert_eq!(vault.read_folder_icons(), Err(VaultError::NotUtf8));
        fs::write(dir.join(SETTINGS_DIR).join(FILE_NAME), big).expect("big");
        assert_eq!(vault.read_folder_icons(), Err(VaultError::TooLarge));
        let _ = fs::remove_dir_all(dir);
    }

    #[cfg(unix)]
    #[test]
    fn a_link_in_place_of_the_file_or_folder_is_not_followed() {
        let (dir, vault) = vault("links");
        let outside = std::env::temp_dir().join(format!("sn-icons-outside-{}", std::process::id()));
        let _ = fs::remove_dir_all(&outside);
        fs::create_dir_all(&outside).expect("outside");
        std::os::unix::fs::symlink(&outside, dir.join(SETTINGS_DIR)).expect("link dir");
        assert!(vault.write_folder_icons("{}", None).is_err());
        assert!(!outside.join(FILE_NAME).exists());
        let _ = fs::remove_dir_all(&outside);
        let _ = fs::remove_dir_all(dir);
    }
}
