//! Safe file writing.
//!
//! A note is never overwritten in place. The new content goes to a temporary file in
//! the same folder, is flushed to disk, and only then renamed over the old file. A
//! rename is all-or-nothing, so if the app is killed at any moment the note on disk is
//! either the complete old version or the complete new version, never a mix.

use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, SystemTime};

/// Temporary files end with this, so leftovers from a crash can be recognised.
pub const TEMP_SUFFIX: &str = ".sn-tmp";

static COUNTER: AtomicU64 = AtomicU64::new(0);

fn temp_path_for(target: &Path) -> PathBuf {
    let dir = target.parent().unwrap_or_else(|| Path::new("."));
    let name = target
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "note".to_string());
    // Process id plus a counter keeps two writers from ever picking the same name.
    let n = COUNTER.fetch_add(1, Ordering::Relaxed);
    dir.join(format!(".{name}.{}.{n}{TEMP_SUFFIX}", std::process::id()))
}

/// Writes `bytes` to `target` so that a crash can never leave a half-written file.
pub fn write_atomic(target: &Path, bytes: &[u8]) -> io::Result<()> {
    let tmp = temp_path_for(target);
    let result = write_then_rename(&tmp, target, bytes);
    if result.is_err() {
        // Best effort: a failed write should not leave clutter behind.
        let _ = fs::remove_file(&tmp);
    } else {
        sync_directory(target.parent());
    }
    result
}

fn write_then_rename(tmp: &Path, target: &Path, bytes: &[u8]) -> io::Result<()> {
    let mut file = OpenOptions::new().write(true).create_new(true).open(tmp)?;
    file.write_all(bytes)?;
    // Without this the data can still be in the operating system's memory when the
    // rename happens, and a power cut could leave an empty file.
    file.sync_all()?;
    drop(file);
    if let Ok(meta) = fs::metadata(target) {
        // Keep the file's permissions, so a replaced note does not change who can read it.
        let _ = fs::set_permissions(tmp, meta.permissions());
    }
    fs::rename(tmp, target)
}

/// Makes the rename itself durable. Only Unix systems allow opening a folder to flush it.
fn sync_directory(dir: Option<&Path>) {
    #[cfg(unix)]
    if let Some(dir) = dir {
        if let Ok(handle) = fs::File::open(dir) {
            let _ = handle.sync_all();
        }
    }
    #[cfg(not(unix))]
    let _ = dir;
}

/// Removes temporary files left by a killed app. Files younger than `min_age` are kept,
/// because another running instance may still be using them. Returns how many were removed.
pub fn remove_stale_temp_files(dir: &Path, min_age: Duration) -> usize {
    let mut removed = 0;
    let Ok(entries) = fs::read_dir(dir) else {
        return 0;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        if file_type.is_symlink() {
            continue;
        }
        if file_type.is_dir() {
            removed += remove_stale_temp_files(&path, min_age);
            continue;
        }
        let is_temp = path
            .file_name()
            .map(|n| n.to_string_lossy().ends_with(TEMP_SUFFIX))
            .unwrap_or(false);
        if !is_temp {
            continue;
        }
        let old_enough = entry
            .metadata()
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| SystemTime::now().duration_since(t).ok())
            .map(|age| age >= min_age)
            .unwrap_or(true);
        if old_enough && fs::remove_file(&path).is_ok() {
            removed += 1;
        }
    }
    removed
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("sn-atomic-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).expect("create scratch dir");
        dir
    }

    #[test]
    fn replaces_content_and_leaves_no_temp_file() {
        let dir = scratch("replace");
        let file = dir.join("a.md");
        fs::write(&file, "old").expect("seed");
        write_atomic(&file, b"new").expect("write");
        assert_eq!(fs::read_to_string(&file).expect("read"), "new");
        let names: Vec<_> = fs::read_dir(&dir)
            .expect("list")
            .map(|e| e.expect("entry").file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(names, vec!["a.md".to_string()]);
    }

    #[test]
    fn failed_write_leaves_nothing_behind() {
        let dir = scratch("fail");
        let file = dir.join("missing-folder").join("a.md");
        assert!(write_atomic(&file, b"x").is_err());
        assert!(!dir.join("missing-folder").exists());
    }

    #[test]
    fn stale_temp_files_are_removed_but_notes_are_not() {
        let dir = scratch("stale");
        fs::write(dir.join("keep.md"), "note").expect("seed");
        fs::write(dir.join(".keep.md.1.1.sn-tmp"), "half").expect("seed temp");
        let removed = remove_stale_temp_files(&dir, Duration::ZERO);
        assert_eq!(removed, 1);
        assert!(dir.join("keep.md").exists());
    }

    #[test]
    fn recent_temp_files_are_kept() {
        let dir = scratch("recent");
        fs::write(dir.join(".a.md.1.1.sn-tmp"), "half").expect("seed temp");
        assert_eq!(remove_stale_temp_files(&dir, Duration::from_secs(3600)), 0);
    }
}
