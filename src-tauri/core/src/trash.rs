//! Delete without losing anything: a deleted page or folder is moved into a hidden `.trash`
//! folder inside the vault, together with a note of where it came from, and can be put back.
//! Only "delete forever" and "empty trash" remove files, and the interface asks first.
//!
//! Layout, all plain files so nothing here needs a program to read it:
//!
//! ```text
//! .trash/<id>/item      the page or folder, with its original content
//! .trash/<id>/name      its original file name
//! .trash/<id>/from      the folder it was in ("" for the top of the vault)
//! .trash/<id>/deleted   seconds since 1970, as text
//! .trash/<id>/canvas    the page's drawing (`Name.canvas.json`), when it had one
//! ```
//!
//! `<id>` is made of digits and "-" only, and every id that comes in from outside is checked
//! against that, so an id can never point out of the trash folder. Hidden folders are not
//! listed in the page list, not searched and not copied to Obsidian, so the trash stays out
//! of the way.

use crate::atomic::write_atomic;
use crate::vault::{has_md_extension, Result, Vault, VaultError};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

pub const TRASH_DIR: &str = ".trash";
const ITEM: &str = "item";
const CANVAS: &str = "canvas";
/// How many items one listing returns. More than this and the oldest are left out of the
/// list (they stay on disk).
const MAX_LISTED: usize = 10_000;
/// How many id numbers are tried when two deletions happen in the same millisecond.
const MAX_ID_TRIES: u32 = 1_000;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TrashItem {
    pub id: String,
    /// The original file name, for example `Week 1.md` or `School`.
    pub name: String,
    /// The folder it was deleted from, "" for the top of the vault.
    pub from: String,
    pub is_folder: bool,
    /// Seconds since 1970.
    pub deleted_at: u64,
}

fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 40 && id.bytes().all(|b| b.is_ascii_digit() || b == b'-')
}

/// A name read back from the trash is checked like any name from outside: it must be a plain
/// file name, because it is joined to a folder path when the item is restored.
fn valid_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 255
        && name != "."
        && name != ".."
        && !name.starts_with('.')
        && !name.contains(['/', '\\', '\0'])
}

fn read_text(path: &Path) -> Option<String> {
    let text = fs::read_to_string(path).ok()?;
    Some(text.trim_end_matches(['\n', '\r']).to_string())
}

impl Vault {
    fn trash_root(&self) -> PathBuf {
        self.root().join(TRASH_DIR)
    }

    fn item_dir(&self, id: &str) -> Result<PathBuf> {
        if !valid_id(id) {
            return Err(VaultError::InvalidPath);
        }
        Ok(self.trash_root().join(id))
    }

    /// Moves a page or a folder (with everything in it) into the trash. The vault top and
    /// anything outside the vault are refused.
    pub fn move_to_trash(&self, relative: &str) -> Result<TrashItem> {
        if relative.is_empty() {
            return Err(VaultError::InvalidPath);
        }
        let path = self.resolve(relative)?;
        let meta = fs::symlink_metadata(&path)?;
        let is_folder = meta.is_dir();
        let name = path.file_name().and_then(|n| n.to_str()).ok_or(VaultError::InvalidPath)?.to_string();
        if !is_folder && !(meta.is_file() && has_md_extension(&name)) {
            return Err(VaultError::NotANote);
        }
        let from = match relative.rfind('/') {
            Some(at) => relative[..at].to_string(),
            None => String::new(),
        };
        let deleted_at = now_seconds();
        let (id, dir) = self.reserve_item_dir()?;
        let result = (|| -> Result<()> {
            // The note of where it came from is written first: if anything fails after this,
            // the folder is removed again and the page has not moved.
            write_atomic(&dir.join("name"), name.as_bytes())?;
            write_atomic(&dir.join("from"), from.as_bytes())?;
            write_atomic(&dir.join("deleted"), deleted_at.to_string().as_bytes())?;
            fs::rename(&path, dir.join(ITEM))?;
            // The drawing of a page goes with it. If it cannot move, the page is put back.
            if let Some(sidecar) = crate::canvas::sidecar_of(&path).filter(|s| !is_folder && s.is_file()) {
                if let Err(error) = fs::rename(&sidecar, dir.join(CANVAS)) {
                    let _ = fs::rename(dir.join(ITEM), &path);
                    return Err(error.into());
                }
            }
            Ok(())
        })();
        if let Err(error) = result {
            let _ = fs::remove_dir_all(&dir);
            return Err(error);
        }
        Ok(TrashItem { id, name, from, is_folder, deleted_at })
    }

    /// Takes the next free id: `create_dir` fails if the name exists, so choosing the id and
    /// claiming it is one step.
    fn reserve_item_dir(&self) -> Result<(String, PathBuf)> {
        let root = self.trash_root();
        fs::create_dir_all(&root)?;
        let stamp = now_millis();
        for attempt in 0..MAX_ID_TRIES {
            let id = format!("{stamp}-{attempt}");
            let dir = root.join(&id);
            match fs::create_dir(&dir) {
                Ok(()) => return Ok((id, dir)),
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(error) => return Err(VaultError::from(error)),
            }
        }
        Err(VaultError::AlreadyExists)
    }

    /// Everything in the trash, newest first. A folder without its item (an interrupted
    /// delete) is not listed.
    pub fn trash_list(&self) -> Result<Vec<TrashItem>> {
        let root = self.trash_root();
        let Ok(read) = fs::read_dir(&root) else {
            return Ok(Vec::new());
        };
        let mut items = Vec::new();
        for entry in read.flatten() {
            let Some(id) = entry.file_name().to_str().map(str::to_owned) else {
                continue;
            };
            if !valid_id(&id) {
                continue;
            }
            let dir = entry.path();
            let Ok(item_meta) = fs::symlink_metadata(dir.join(ITEM)) else {
                continue;
            };
            let name = read_text(&dir.join("name")).filter(|n| valid_name(n));
            items.push(TrashItem {
                // A missing or odd name is shown as the id so the item can still be seen and removed.
                name: name.unwrap_or_else(|| id.clone()),
                from: read_text(&dir.join("from")).unwrap_or_default(),
                is_folder: item_meta.is_dir(),
                deleted_at: read_text(&dir.join("deleted")).and_then(|t| t.parse().ok()).unwrap_or(0),
                id,
            });
            if items.len() >= MAX_LISTED {
                break;
            }
        }
        items.sort_by(|a, b| b.deleted_at.cmp(&a.deleted_at).then_with(|| b.id.cmp(&a.id)));
        Ok(items)
    }

    /// Puts an item back where it was deleted from, or at the top of the vault when that
    /// folder is gone. If something with the same name is there now, the restored item gets
    /// "(restored)" added to its name; nothing is ever replaced. Returns its new path.
    pub fn restore_from_trash(&self, id: &str) -> Result<String> {
        let dir = self.item_dir(id)?;
        let item = dir.join(ITEM);
        let item_meta = fs::symlink_metadata(&item)?;
        let name = read_text(&dir.join("name")).filter(|n| valid_name(n)).ok_or(VaultError::InvalidPath)?;
        let from = read_text(&dir.join("from")).unwrap_or_default();
        let (parent_relative, parent) = match self.resolve(&from) {
            Ok(path) if path.is_dir() => (from, path),
            _ => (String::new(), self.root().to_path_buf()),
        };
        let target = free_name(&parent, &name, item_meta.is_dir());
        fs::rename(&item, &target)?;
        // The drawing comes back under the name the page has now (never over another drawing).
        let drawing = dir.join(CANVAS);
        let mut drawing_left = false;
        if drawing.is_file() {
            let free = crate::canvas::sidecar_of(&target).filter(|s| !s.exists());
            match free {
                Some(sidecar) => drawing_left = fs::rename(&drawing, sidecar).is_err(),
                // A stale drawing with that name is already there: the trashed one is kept in the
                // trash folder for good measure, and the item folder is not removed.
                None => drawing_left = true,
            }
        }
        if drawing_left {
            return self.restored_path(&target, parent_relative);
        }
        // Only the notes about the item are left now.
        let _ = fs::remove_dir_all(&dir);
        self.restored_path(&target, parent_relative)
    }

    fn restored_path(&self, target: &Path, parent_relative: String) -> Result<String> {
        let file_name = target.file_name().and_then(|n| n.to_str()).ok_or(VaultError::InvalidPath)?;
        Ok(if parent_relative.is_empty() { file_name.to_string() } else { format!("{parent_relative}/{file_name}") })
    }

    /// Removes one item for good.
    pub fn delete_forever(&self, id: &str) -> Result<()> {
        let dir = self.item_dir(id)?;
        if !dir.is_dir() {
            return Err(VaultError::NotFound);
        }
        fs::remove_dir_all(&dir)?;
        Ok(())
    }

    /// Removes everything in the trash for good. Returns how many items there were.
    pub fn empty_trash(&self) -> Result<usize> {
        let mut count = 0;
        for item in self.trash_list()? {
            self.delete_forever(&item.id)?;
            count += 1;
        }
        Ok(count)
    }
}

/// `name`, or `name (restored)`, `name (restored 2)` and so on, until nothing of that name
/// exists in `parent`. The extension of a page stays at the end.
fn free_name(parent: &Path, name: &str, is_folder: bool) -> PathBuf {
    let direct = parent.join(name);
    if !direct.exists() {
        return direct;
    }
    let (stem, extension) = match name.rfind('.') {
        Some(at) if !is_folder && at > 0 => (&name[..at], &name[at..]),
        _ => (name, ""),
    };
    for attempt in 1..1000 {
        let label = if attempt == 1 { "restored".to_string() } else { format!("restored {attempt}") };
        let candidate = parent.join(format!("{stem} ({label}){extension}"));
        if !candidate.exists() {
            return candidate;
        }
    }
    direct
}

fn now_millis() -> u128 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0)
}

fn now_seconds() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn vault(name: &str) -> (PathBuf, Vault) {
        let dir = std::env::temp_dir().join(format!("sn-trash-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(dir.join("School")).expect("make folders");
        fs::write(dir.join("a.md"), "alpha\n").expect("a");
        fs::write(dir.join("School").join("b.md"), "bravo\n").expect("b");
        fs::write(dir.join("School").join("notes.txt"), "not a note").expect("txt");
        let vault = Vault::open(&dir).expect("open");
        (dir, vault)
    }

    #[test]
    fn ids_and_names_from_outside_are_checked() {
        assert!(valid_id("1730000000000-0"));
        for bad in ["", "..", "../x", "1/2", "1730000000000-0/..", "abc", &"1".repeat(41), "1 2"] {
            assert!(!valid_id(bad), "{bad}");
        }
        assert!(valid_name("Week 1.md"));
        for bad in ["", ".", "..", ".hidden", "a/b", "a\\b", "a\0b"] {
            assert!(!valid_name(bad), "{bad:?}");
        }
    }

    #[test]
    fn a_deleted_page_moves_to_the_trash_and_leaves_the_list() {
        let (dir, vault) = vault("move");
        let item = vault.move_to_trash("School/b.md").expect("trash");
        assert_eq!((item.name.as_str(), item.from.as_str(), item.is_folder), ("b.md", "School", false));
        assert!(!dir.join("School").join("b.md").exists());
        assert_eq!(fs::read_to_string(dir.join(TRASH_DIR).join(&item.id).join("item")).expect("kept"), "bravo\n");
        let listed: Vec<String> = vault.tree().expect("tree").entries.into_iter().map(|e| e.path).collect();
        assert_eq!(listed, vec!["School", "a.md"], "the trash is not in the page list");
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn a_folder_goes_with_everything_in_it() {
        let (dir, vault) = vault("folder");
        let item = vault.move_to_trash("School").expect("trash");
        assert!(item.is_folder);
        assert!(!dir.join("School").exists());
        let kept = dir.join(TRASH_DIR).join(&item.id).join("item");
        assert_eq!(fs::read_to_string(kept.join("b.md")).expect("b"), "bravo\n");
        assert_eq!(fs::read_to_string(kept.join("notes.txt")).expect("txt"), "not a note", "other files go along");
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn restore_puts_it_back_with_the_same_content() {
        let (dir, vault) = vault("restore");
        let item = vault.move_to_trash("School/b.md").expect("trash");
        assert_eq!(vault.restore_from_trash(&item.id).expect("restore"), "School/b.md");
        assert_eq!(fs::read_to_string(dir.join("School").join("b.md")).expect("b"), "bravo\n");
        assert!(vault.trash_list().expect("list").is_empty());
        assert!(!dir.join(TRASH_DIR).join(&item.id).exists(), "the notes about it are gone too");
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn restore_never_replaces_and_falls_back_to_the_top() {
        let (dir, vault) = vault("conflict");
        let first = vault.move_to_trash("a.md").expect("trash");
        fs::write(dir.join("a.md"), "a new page with the same name\n").expect("new a");
        assert_eq!(vault.restore_from_trash(&first.id).expect("restore"), "a (restored).md");
        assert_eq!(fs::read_to_string(dir.join("a.md")).expect("a"), "a new page with the same name\n");
        assert_eq!(fs::read_to_string(dir.join("a (restored).md")).expect("restored"), "alpha\n");
        // The folder it came from is gone: it comes back at the top.
        let page = vault.move_to_trash("School/b.md").expect("trash b");
        vault.move_to_trash("School").expect("trash folder");
        assert_eq!(vault.restore_from_trash(&page.id).expect("restore b"), "b.md");
        assert_eq!(fs::read_to_string(dir.join("b.md")).expect("b"), "bravo\n");
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn two_deletions_at_once_get_different_ids_and_the_list_is_newest_first() {
        let (dir, vault) = vault("ids");
        let first = vault.move_to_trash("a.md").expect("first");
        let second = vault.move_to_trash("School/b.md").expect("second");
        assert_ne!(first.id, second.id);
        let ids: Vec<String> = vault.trash_list().expect("list").into_iter().map(|i| i.id).collect();
        assert_eq!(ids, vec![second.id, first.id]);
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn delete_forever_and_empty_remove_only_what_was_chosen() {
        let (dir, vault) = vault("forever");
        let a = vault.move_to_trash("a.md").expect("a");
        let b = vault.move_to_trash("School/b.md").expect("b");
        vault.delete_forever(&a.id).expect("forever");
        assert!(!dir.join(TRASH_DIR).join(&a.id).exists());
        assert_eq!(vault.trash_list().expect("list").len(), 1);
        assert_eq!(vault.delete_forever(&a.id).err(), Some(VaultError::NotFound));
        assert_eq!(vault.empty_trash().expect("empty"), 1);
        assert!(vault.trash_list().expect("list").is_empty());
        assert!(!dir.join(TRASH_DIR).join(&b.id).exists());
        assert!(dir.join("School").is_dir(), "the rest of the vault is untouched");
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn things_that_must_not_be_deleted_are_refused() {
        let (dir, vault) = vault("refuse");
        for bad in ["", "../x.md", "/etc/passwd", ".trash", ".trash/1-0", "School/notes.txt", "missing.md", "a.md/.."] {
            assert!(vault.move_to_trash(bad).is_err(), "{bad:?}");
        }
        for bad in ["../x", "..", "", "1/2", "abc"] {
            assert!(vault.restore_from_trash(bad).is_err(), "{bad:?}");
            assert!(vault.delete_forever(bad).is_err(), "{bad:?}");
        }
        assert!(dir.join("a.md").exists() && dir.join("School").join("notes.txt").exists());
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn a_damaged_trash_entry_cannot_be_used_to_reach_other_files() {
        let (dir, vault) = vault("damaged");
        let item = vault.move_to_trash("a.md").expect("trash");
        let entry = dir.join(TRASH_DIR).join(&item.id);
        fs::write(entry.join("name"), "../escape.md").expect("bad name");
        assert_eq!(vault.restore_from_trash(&item.id).err(), Some(VaultError::InvalidPath));
        assert_eq!(vault.trash_list().expect("list")[0].name, item.id, "shown by id");
        fs::write(entry.join("name"), "a.md").expect("good name");
        fs::write(entry.join("from"), "../../elsewhere").expect("bad from");
        assert_eq!(vault.restore_from_trash(&item.id).expect("falls back to the top"), "a.md");
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn an_interrupted_delete_is_not_listed_and_names_with_accents_work() {
        let (dir, vault) = vault("interrupted");
        // A folder without its item is what a crash half way through would leave.
        fs::create_dir_all(dir.join(TRASH_DIR).join("1730000000000-0")).expect("empty entry");
        assert!(vault.trash_list().expect("list").is_empty());
        fs::write(dir.join("aéé.md"), "x").expect("accents");
        fs::write(dir.join("aéé"), "no extension").expect("no extension");
        assert_eq!(vault.move_to_trash("aéé").err(), Some(VaultError::NotANote));
        let item = vault.move_to_trash("aéé.md").expect("accented name");
        assert_eq!(vault.restore_from_trash(&item.id).expect("restore"), "aéé.md");
        let _ = fs::remove_dir_all(dir);
    }

    #[cfg(unix)]
    #[test]
    fn a_link_to_a_folder_outside_is_never_followed() {
        let (dir, vault) = vault("link");
        let outside = std::env::temp_dir().join(format!("sn-trash-outside-{}", std::process::id()));
        let _ = fs::remove_dir_all(&outside);
        fs::create_dir_all(&outside).expect("outside");
        fs::write(outside.join("keep.md"), "keep").expect("keep");
        std::os::unix::fs::symlink(&outside, dir.join("School").join("link")).expect("link");
        let item = vault.move_to_trash("School").expect("trash");
        vault.delete_forever(&item.id).expect("forever");
        assert_eq!(fs::read_to_string(outside.join("keep.md")).expect("still there"), "keep");
        let _ = fs::remove_dir_all(dir);
        let _ = fs::remove_dir_all(outside);
    }
}
