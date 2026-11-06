//! The drawing of a page, kept in a file next to the page.
//!
//! `Plan.md` has its strokes in `Plan.canvas.json`. The markdown stays clean (Obsidian does not
//! know the drawing is there), and the drawing is a plain file that can be copied, synced and
//! backed up like any other. The page list shows only `.md` files, so the sidecar never appears
//! as a page of its own.
//!
//! This file only stores the text the interface gives it. What is inside (strokes, colours) is
//! checked by the interface when it is read, because the text came from a file and is untrusted
//! there; here the rules are the same as for a note: a size limit, an exact-version check so two
//! writers cannot overwrite each other, and an atomic write.
//!
//! A sidecar follows its page: renaming, moving, deleting and restoring a page carries it along
//! (see `rename`, `move_entry` and the trash).

use crate::atomic::write_atomic;
use crate::vault::{has_md_extension, NoteContent, NoteVersion, Result, Vault, VaultError};
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

/// A drawing may be bigger than a note (a few thousand strokes of many points), but not without
/// limit.
pub const MAX_CANVAS_BYTES: u64 = 32 * 1024 * 1024;

/// `dir/Plan.md` -> `dir/Plan.canvas.json`. `None` for a path that is not a note.
pub(crate) fn sidecar_of(note: &Path) -> Option<PathBuf> {
    let name = note.file_name()?.to_str()?;
    if !has_md_extension(name) {
        return None;
    }
    Some(note.with_file_name(format!("{}.canvas.json", &name[..name.len() - 3])))
}

impl Vault {
    fn canvas_path(&self, relative: &str) -> Result<PathBuf> {
        let note = self.note_path(relative)?;
        sidecar_of(&note).ok_or(VaultError::NotANote)
    }

    /// The drawing of a page, or `None` when the page has none yet. The page itself must exist.
    pub fn read_canvas(&self, relative: &str) -> Result<Option<NoteContent>> {
        let path = self.canvas_path(relative)?;
        if !self.note_path(relative)?.is_file() {
            return Err(VaultError::NotFound);
        }
        let meta = match fs::symlink_metadata(&path) {
            Ok(meta) => meta,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(error.into()),
        };
        // A link is never followed: it could lead out of the vault.
        if !meta.is_file() {
            return Err(VaultError::NotANote);
        }
        if meta.len() > MAX_CANVAS_BYTES {
            return Err(VaultError::TooLarge);
        }
        let bytes = fs::read(&path)?;
        let version = NoteVersion::of(&bytes);
        let text = String::from_utf8(bytes).map_err(|_| VaultError::NotUtf8)?;
        Ok(Some(NoteContent { text, version }))
    }

    /// Saves the drawing of a page. `expected` is the version last read, or `None` when the page
    /// had no drawing. A different file on disk is a conflict and nothing is written.
    pub fn write_canvas(&self, relative: &str, text: &str, expected: Option<NoteVersion>) -> Result<NoteVersion> {
        let path = self.canvas_path(relative)?;
        if !self.note_path(relative)?.is_file() {
            return Err(VaultError::NotFound);
        }
        if text.len() as u64 > MAX_CANVAS_BYTES {
            return Err(VaultError::TooLarge);
        }
        match (fs::symlink_metadata(&path), expected) {
            (Ok(meta), Some(expected)) => {
                if !meta.is_file() || meta.len() > MAX_CANVAS_BYTES || NoteVersion::of(&fs::read(&path)?) != expected {
                    return Err(VaultError::Conflict);
                }
            }
            (Ok(_), None) => return Err(VaultError::Conflict),
            (Err(error), Some(_)) if error.kind() == io::ErrorKind::NotFound => return Err(VaultError::Conflict),
            (Err(error), None) if error.kind() == io::ErrorKind::NotFound => {}
            (Err(error), _) => return Err(error.into()),
        }
        write_atomic(&path, text.as_bytes())?;
        Ok(NoteVersion::of(text.as_bytes()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn vault(name: &str) -> (PathBuf, Vault) {
        let dir = std::env::temp_dir().join(format!("sn-canvas-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(dir.join("sub")).expect("dirs");
        let vault = Vault::open(&dir).expect("open");
        (dir, vault)
    }

    #[test]
    fn the_sidecar_is_named_after_the_page() {
        assert_eq!(sidecar_of(Path::new("/v/sub/Plan.md")), Some(PathBuf::from("/v/sub/Plan.canvas.json")));
        assert_eq!(sidecar_of(Path::new("/v/Plan.txt")), None);
    }

    #[test]
    fn a_drawing_is_written_read_and_replaced_with_the_version_check() {
        let (dir, vault) = vault("basic");
        fs::write(dir.join("sub").join("A.md"), "x\n").expect("page");
        assert!(vault.read_canvas("sub/A.md").expect("read").is_none());
        let v1 = vault.write_canvas("sub/A.md", "{\"a\":1}", None).expect("first");
        assert_eq!(vault.read_canvas("sub/A.md").expect("read").expect("some").text, "{\"a\":1}");
        // The old version no longer matches after a change.
        let v2 = vault.write_canvas("sub/A.md", "{\"a\":2}", Some(v1)).expect("second");
        assert_eq!(vault.write_canvas("sub/A.md", "{\"a\":3}", Some(v1)), Err(VaultError::Conflict));
        assert_eq!(vault.write_canvas("sub/A.md", "{\"a\":3}", None), Err(VaultError::Conflict));
        assert!(vault.write_canvas("sub/A.md", "{\"a\":3}", Some(v2)).is_ok());
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn only_existing_pages_have_a_drawing_and_paths_cannot_leave_the_vault() {
        let (dir, vault) = vault("paths");
        assert_eq!(vault.read_canvas("missing.md"), Err(VaultError::NotFound));
        assert_eq!(vault.write_canvas("missing.md", "{}", None), Err(VaultError::NotFound));
        assert!(vault.read_canvas("../x.md").is_err());
        assert!(vault.write_canvas("notes.txt", "{}", None).is_err());
        assert!(vault.write_canvas("", "{}", None).is_err());
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn too_large_and_not_text_are_refused() {
        let (dir, vault) = vault("limits");
        fs::write(dir.join("A.md"), "x\n").expect("page");
        let big = "x".repeat(MAX_CANVAS_BYTES as usize + 1);
        assert_eq!(vault.write_canvas("A.md", &big, None), Err(VaultError::TooLarge));
        fs::write(dir.join("A.canvas.json"), [0xffu8, 0xfe]).expect("binary");
        assert_eq!(vault.read_canvas("A.md"), Err(VaultError::NotUtf8));
        let _ = fs::remove_dir_all(dir);
    }

    #[cfg(unix)]
    #[test]
    fn a_link_in_place_of_the_sidecar_is_not_followed() {
        let (dir, vault) = vault("link");
        fs::write(dir.join("A.md"), "x\n").expect("page");
        let outside = dir.parent().expect("parent").join(format!("sn-canvas-outside-{}.json", std::process::id()));
        fs::write(&outside, "secret").expect("outside");
        std::os::unix::fs::symlink(&outside, dir.join("A.canvas.json")).expect("link");
        assert!(vault.read_canvas("A.md").is_err());
        assert!(vault.write_canvas("A.md", "{}", None).is_err());
        assert_eq!(fs::read_to_string(&outside).expect("still"), "secret");
        let _ = fs::remove_file(outside);
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn renaming_and_moving_a_page_carry_its_drawing_and_never_replace_one() {
        let (dir, vault) = vault("follow");
        fs::write(dir.join("A.md"), "x\n").expect("page");
        fs::write(dir.join("A.canvas.json"), "{\"d\":1}").expect("drawing");
        let renamed = vault.rename("A.md", "B").expect("rename");
        assert_eq!(renamed, "B.md");
        assert!(!dir.join("A.canvas.json").exists());
        assert_eq!(fs::read_to_string(dir.join("B.canvas.json")).expect("moved"), "{\"d\":1}");
        let moved = vault.move_entry("B.md", "sub").expect("move");
        assert_eq!(moved, "sub/B.md");
        assert_eq!(fs::read_to_string(dir.join("sub").join("B.canvas.json")).expect("moved"), "{\"d\":1}");
        // A stale drawing under the new name stops the rename and nothing moves.
        fs::write(dir.join("C.md"), "x\n").expect("page");
        fs::write(dir.join("C.canvas.json"), "{\"d\":2}").expect("drawing");
        fs::write(dir.join("sub").join("Z.canvas.json"), "stale").expect("stale");
        assert_eq!(vault.rename("sub/B.md", "Z"), Err(VaultError::AlreadyExists));
        assert!(dir.join("sub").join("B.md").exists() && dir.join("sub").join("B.canvas.json").exists());
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn deleting_and_restoring_a_page_carry_its_drawing() {
        let (dir, vault) = vault("trash");
        fs::write(dir.join("A.md"), "x\n").expect("page");
        fs::write(dir.join("A.canvas.json"), "{\"d\":1}").expect("drawing");
        let item = vault.move_to_trash("A.md").expect("trash");
        assert!(!dir.join("A.canvas.json").exists() && !dir.join("A.md").exists());
        // The page is back under a new name because the old one is taken; the drawing follows.
        fs::write(dir.join("A.md"), "new\n").expect("new page");
        let back = vault.restore_from_trash(&item.id).expect("restore");
        assert_eq!(back, "A (restored).md");
        assert_eq!(fs::read_to_string(dir.join("A (restored).canvas.json")).expect("drawing back"), "{\"d\":1}");
        assert!(!dir.join("A.canvas.json").exists());
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn a_folder_carries_the_drawings_inside_it() {
        let (dir, vault) = vault("folder");
        fs::write(dir.join("sub").join("A.md"), "x\n").expect("page");
        fs::write(dir.join("sub").join("A.canvas.json"), "{}").expect("drawing");
        let item = vault.move_to_trash("sub").expect("trash");
        let back = vault.restore_from_trash(&item.id).expect("restore");
        assert_eq!(back, "sub");
        assert!(dir.join("sub").join("A.canvas.json").exists());
        let _ = fs::remove_dir_all(dir);
    }
}
