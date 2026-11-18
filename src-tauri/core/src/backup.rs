//! Backups of a vault: a plain copy of every note and file into a folder next to the vault, and
//! putting them back.
//!
//! A backup is an ordinary folder you can open with any program; nothing is packed or encoded.
//! It is made in a folder named after the vault with " backups" added, one folder per backup, named
//! by the time it was made (UTC). The vault is never changed by making a backup, and a backup is
//! never changed after it is made.
//!
//! Restoring never deletes anything. A file that is missing in the vault is put back. A file that
//! differs is replaced, and the version that was there is first kept under
//! `.scalenote/before-restore/<time>/` inside the vault, so a restore can itself be undone by hand.
//! Files made after the backup stay where they are.

use crate::atomic::write_atomic;
use crate::logger::format_utc;
use crate::obsidian::reserve_folder;
use crate::vault::{Result, Vault, VaultError, MAX_TREE_DEPTH, MAX_TREE_ENTRIES};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

/// A file bigger than this is left out of a backup and counted, like in the Obsidian copy.
const MAX_FILE_BYTES: u64 = 256 * 1024 * 1024;
/// How many backups are listed; older ones stay on disk, only the list is cut.
const MAX_LISTED: usize = 50;
pub const BEFORE_RESTORE_DIR: &str = ".scalenote/before-restore";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BackupInfo {
    /// The folder's name; this is what `restore` is given back.
    pub name: String,
    /// When it was made, UTC, `2026-11-18 12:45:10`.
    pub when: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BackupReport {
    pub info: BackupInfo,
    pub files: usize,
    /// Left out: too big or not readable.
    pub skipped: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct RestoreReport {
    /// Files that were missing and are back.
    pub added: usize,
    /// Files that differed and were replaced (the old version is kept, see the module notes).
    pub replaced: usize,
    pub unchanged: usize,
    pub skipped: usize,
}

struct Counts {
    files: usize,
    skipped: usize,
    entries: usize,
}

fn base_name(vault: &Vault) -> String {
    vault.root().file_name().map(|n| n.to_string_lossy().into_owned()).filter(|n| !n.is_empty()).unwrap_or_else(|| "ScaleNote".to_string())
}

/// The folder that holds the backups of this vault (it may not exist yet).
pub fn backups_dir(vault: &Vault) -> Result<PathBuf> {
    let parent = vault.root().parent().ok_or(VaultError::InvalidPath)?;
    Ok(parent.join(format!("{} backups", base_name(vault))))
}

fn now_seconds() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_secs())
}

/// `2026-11-18T12:45:10Z` as a name that is safe on every system: `2026-11-18 12-45-10`.
fn stamp_name(seconds: u64) -> String {
    format_utc(seconds).trim_end_matches('Z').replace('T', " ").replace(':', "-")
}

fn name_to_when(name: &str) -> Option<String> {
    // Names are made here: `YYYY-MM-DD HH-MM-SS`, possibly followed by " 2", " 3" when taken.
    let bytes = name.as_bytes();
    if name.len() < 19 || !bytes[..19].iter().enumerate().all(|(i, b)| match i {
        4 | 7 => *b == b'-',
        10 => *b == b' ',
        13 | 16 => *b == b'-',
        _ => b.is_ascii_digit(),
    }) {
        return None;
    }
    if name.len() > 19 && !name[19..].starts_with(' ') {
        return None;
    }
    let (date, time) = (&name[..10], name[11..19].replace('-', ":"));
    Some(format!("{date} {time}"))
}

/// Copies the vault into a new folder inside the backups folder. Hidden entries (the app's own
/// cache, `.git`, half-written temporary files) and links are left out, like in the Obsidian copy.
pub fn make(vault: &Vault) -> Result<BackupReport> {
    make_at(vault, now_seconds())
}

pub(crate) fn make_at(vault: &Vault, seconds: u64) -> Result<BackupReport> {
    let dir = backups_dir(vault)?;
    fs::create_dir_all(&dir)?;
    let dest = reserve_folder(&dir, &stamp_name(seconds))?;
    let mut counts = Counts { files: 0, skipped: 0, entries: 0 };
    if let Err(error) = copy_tree(vault.root(), &dest, 0, &mut counts) {
        // The folder was made by this call and holds only what this call wrote.
        let _ = fs::remove_dir_all(&dest);
        return Err(error);
    }
    let name = dest.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let when = name_to_when(&name).unwrap_or_default();
    Ok(BackupReport { info: BackupInfo { name, when }, files: counts.files, skipped: counts.skipped })
}

fn copy_tree(from: &Path, to: &Path, depth: usize, counts: &mut Counts) -> Result<()> {
    if depth >= MAX_TREE_DEPTH {
        counts.skipped += 1;
        return Ok(());
    }
    for entry in fs::read_dir(from)?.flatten() {
        if counts.entries >= MAX_TREE_ENTRIES {
            counts.skipped += 1;
            return Ok(());
        }
        let Ok(kind) = entry.file_type() else {
            counts.skipped += 1;
            continue;
        };
        let Some(name) = entry.file_name().to_str().map(str::to_owned) else {
            counts.skipped += 1;
            continue;
        };
        if name.starts_with('.') || kind.is_symlink() {
            continue;
        }
        counts.entries += 1;
        let (source, target) = (entry.path(), to.join(&name));
        if kind.is_dir() {
            fs::create_dir(&target)?;
            copy_tree(&source, &target, depth + 1, counts)?;
        } else if kind.is_file() {
            match read_small(&source) {
                Some(bytes) => {
                    write_atomic(&target, &bytes)?;
                    counts.files += 1;
                }
                None => counts.skipped += 1,
            }
        }
    }
    Ok(())
}

fn read_small(path: &Path) -> Option<Vec<u8>> {
    let size = fs::metadata(path).ok()?.len();
    if size > MAX_FILE_BYTES {
        return None;
    }
    fs::read(path).ok()
}

/// The backups of this vault, newest first. Folders that are not ours (a name that is not a time) are ignored.
pub fn list(vault: &Vault) -> Result<Vec<BackupInfo>> {
    let dir = backups_dir(vault)?;
    let Ok(entries) = fs::read_dir(&dir) else { return Ok(Vec::new()) };
    let mut found: Vec<BackupInfo> = entries
        .flatten()
        .filter(|e| e.file_type().is_ok_and(|t| t.is_dir()))
        .filter_map(|e| {
            let name = e.file_name().to_str()?.to_string();
            let when = name_to_when(&name)?;
            Some(BackupInfo { name, when })
        })
        .collect();
    found.sort_by(|a, b| b.name.cmp(&a.name));
    found.truncate(MAX_LISTED);
    Ok(found)
}

/// Puts a backup back into the vault. `name` must be one of `list`'s names; nothing else is accepted,
/// so a made-up path cannot reach outside the backups folder.
pub fn restore(vault: &Vault, name: &str) -> Result<RestoreReport> {
    restore_at(vault, name, now_seconds())
}

pub(crate) fn restore_at(vault: &Vault, name: &str, seconds: u64) -> Result<RestoreReport> {
    let chosen = list(vault)?.into_iter().find(|b| b.name == name).ok_or(VaultError::NotFound)?;
    let source = backups_dir(vault)?.join(&chosen.name);
    let kept = vault.root().join(BEFORE_RESTORE_DIR).join(stamp_name(seconds));
    let mut report = RestoreReport::default();
    let mut entries = 0;
    restore_tree(&source, vault.root(), &kept, Path::new(""), 0, &mut report, &mut entries)?;
    Ok(report)
}

fn restore_tree(from: &Path, to: &Path, kept: &Path, relative: &Path, depth: usize, report: &mut RestoreReport, entries: &mut usize) -> Result<()> {
    if depth >= MAX_TREE_DEPTH {
        report.skipped += 1;
        return Ok(());
    }
    for entry in fs::read_dir(from)?.flatten() {
        if *entries >= MAX_TREE_ENTRIES {
            report.skipped += 1;
            return Ok(());
        }
        let Ok(kind) = entry.file_type() else {
            report.skipped += 1;
            continue;
        };
        let Some(name) = entry.file_name().to_str().map(str::to_owned) else {
            report.skipped += 1;
            continue;
        };
        if name.starts_with('.') || kind.is_symlink() {
            continue;
        }
        *entries += 1;
        let (source, target, rel) = (entry.path(), to.join(&name), relative.join(&name));
        if kind.is_dir() {
            // A name taken by a file in the vault is not touched; its contents are skipped.
            if target.exists() && !target.is_dir() {
                report.skipped += 1;
                continue;
            }
            fs::create_dir_all(&target)?;
            restore_tree(&source, &target, kept, &rel, depth + 1, report, entries)?;
        } else if kind.is_file() {
            let Some(wanted) = read_small(&source) else {
                report.skipped += 1;
                continue;
            };
            match fs::symlink_metadata(&target) {
                Err(_) => {
                    write_atomic(&target, &wanted)?;
                    report.added += 1;
                }
                Ok(meta) if meta.is_file() => {
                    let current = read_small(&target);
                    if current.as_deref() == Some(wanted.as_slice()) {
                        report.unchanged += 1;
                    } else {
                        // The version that is there is kept before it is replaced.
                        match current {
                            Some(bytes) => {
                                let safe = kept.join(&rel);
                                if let Some(parent) = safe.parent() {
                                    fs::create_dir_all(parent)?;
                                }
                                write_atomic(&safe, &bytes)?;
                            }
                            None => {
                                report.skipped += 1;
                                continue;
                            }
                        }
                        write_atomic(&target, &wanted)?;
                        report.replaced += 1;
                    }
                }
                Ok(_) => report.skipped += 1,
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Dir(PathBuf);
    impl Dir {
        fn new(label: &str) -> Dir {
            let path = std::env::temp_dir().join(format!("sn-backup-{label}-{}", std::process::id()));
            let _ = fs::remove_dir_all(&path);
            fs::create_dir_all(path.join("Notes")).expect("vault");
            Dir(path)
        }
        fn vault(&self) -> Vault {
            Vault::open(&self.0.join("Notes")).expect("open")
        }
    }
    impl Drop for Dir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn put(dir: &Dir, relative: &str, text: &str) {
        let path = dir.0.join("Notes").join(relative);
        fs::create_dir_all(path.parent().expect("parent")).expect("dirs");
        fs::write(path, text).expect("write");
    }

    fn get(dir: &Dir, relative: &str) -> String {
        fs::read_to_string(dir.0.join("Notes").join(relative)).unwrap_or_else(|_| "<missing>".into())
    }

    #[test]
    fn a_backup_is_an_exact_plain_copy_next_to_the_vault_and_the_vault_is_not_changed() {
        let d = Dir::new("make");
        put(&d, "A.md", "one\n");
        put(&d, "School/B.md", "two\n");
        put(&d, "attachments/p.bin", "\u{1}\u{2}");
        put(&d, ".hidden/x.md", "never copied\n");
        let report = make_at(&d.vault(), 1_700_000_000).expect("backup");
        assert_eq!(report.files, 3);
        assert_eq!(report.info.name, "2023-11-14 22-13-20");
        assert_eq!(report.info.when, "2023-11-14 22:13:20");
        let folder = d.0.join("Notes backups").join(&report.info.name);
        assert_eq!(fs::read_to_string(folder.join("School/B.md")).expect("copy"), "two\n");
        assert!(!folder.join(".hidden").exists());
        assert_eq!(get(&d, "A.md"), "one\n");
        // Two backups in the same second never share a folder.
        let again = make_at(&d.vault(), 1_700_000_000).expect("second");
        assert_eq!(again.info.name, "2023-11-14 22-13-20 2");
    }

    #[test]
    fn backups_are_listed_newest_first_and_foreign_folders_are_ignored() {
        let d = Dir::new("list");
        put(&d, "A.md", "x\n");
        assert!(list(&d.vault()).expect("none").is_empty());
        make_at(&d.vault(), 1_700_000_000).expect("1");
        make_at(&d.vault(), 1_700_100_000).expect("2");
        fs::create_dir_all(d.0.join("Notes backups/holiday photos")).expect("foreign");
        fs::write(d.0.join("Notes backups/2023-01-01 00-00-00"), "a file, not a folder").expect("file");
        let names: Vec<_> = list(&d.vault()).expect("list").into_iter().map(|b| b.name).collect();
        assert_eq!(names, vec!["2023-11-16 02-00-00", "2023-11-14 22-13-20"]);
    }

    #[test]
    fn restoring_puts_back_what_is_missing_keeps_the_replaced_version_and_deletes_nothing() {
        let d = Dir::new("restore");
        put(&d, "A.md", "original a\n");
        put(&d, "B.md", "original b\n");
        put(&d, "same.md", "same\n");
        let backup = make_at(&d.vault(), 1_700_000_000).expect("backup");
        fs::remove_file(d.0.join("Notes/A.md")).expect("lost");
        put(&d, "B.md", "edited later\n");
        put(&d, "New.md", "made after the backup\n");
        let report = restore_at(&d.vault(), &backup.info.name, 1_700_050_000).expect("restore");
        assert_eq!(report, RestoreReport { added: 1, replaced: 1, unchanged: 1, skipped: 0 });
        assert_eq!(get(&d, "A.md"), "original a\n");
        assert_eq!(get(&d, "B.md"), "original b\n");
        assert_eq!(get(&d, "New.md"), "made after the backup\n", "files made later stay");
        let kept = d.0.join("Notes").join(BEFORE_RESTORE_DIR).join("2023-11-15 12-06-40/B.md");
        assert_eq!(fs::read_to_string(kept).expect("old version kept"), "edited later\n");
        // Restoring twice changes nothing more.
        let again = restore_at(&d.vault(), &backup.info.name, 1_700_060_000).expect("again");
        assert_eq!(again, RestoreReport { added: 0, replaced: 0, unchanged: 3, skipped: 0 });
    }

    #[test]
    fn only_a_listed_backup_can_be_restored_never_a_made_up_path() {
        let d = Dir::new("names");
        put(&d, "A.md", "x\n");
        fs::create_dir_all(d.0.join("Elsewhere")).expect("dir");
        fs::write(d.0.join("Elsewhere/Evil.md"), "evil\n").expect("file");
        for bad in ["../Elsewhere", "", "..", "/etc", "2023-11-14 22-13-20", "a/b", "\0"] {
            assert_eq!(restore_at(&d.vault(), bad, 1).expect_err(bad), VaultError::NotFound, "{bad:?}");
        }
        assert!(!d.0.join("Notes/Evil.md").exists());
    }

    #[test]
    fn a_name_in_the_vault_that_is_a_folder_where_the_backup_has_a_file_is_left_alone() {
        let d = Dir::new("clash");
        put(&d, "Thing", "a file in the backup\n");
        let backup = make_at(&d.vault(), 1_700_000_000).expect("backup");
        fs::remove_file(d.0.join("Notes/Thing")).expect("remove");
        fs::create_dir_all(d.0.join("Notes/Thing")).expect("folder now");
        put(&d, "Thing/inside.md", "keep\n");
        let report = restore_at(&d.vault(), &backup.info.name, 1_700_000_100).expect("restore");
        assert_eq!(report.skipped, 1);
        assert_eq!(get(&d, "Thing/inside.md"), "keep\n");
    }
}
