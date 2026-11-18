//! A cheap way to notice that something in a vault changed, without reading any file.
//!
//! The signature is one number made from the name, size and time of every visible file and
//! folder. When it differs from the last one, something changed: a page was saved by another
//! program, or a sync wrote files. The app asks for it every few seconds and refreshes the page
//! list when it moved; sync uses it to skip a round when nothing changed here. It looks at
//! names and times only, so it stays fast on a big vault; it ignores hidden folders (the trash,
//! history and sync's own files), links, and the temporary files of a write in progress.

use crate::atomic::TEMP_SUFFIX;
use super::manifest::{MAX_DEPTH, MAX_FILES};
use std::collections::hash_map::DefaultHasher;
use std::fs;
use std::hash::{Hash, Hasher};
use std::path::Path;
use std::time::UNIX_EPOCH;

/// One number for the current state of the vault at `root`. A vault that cannot be read gives 0.
pub fn signature(root: &Path) -> u64 {
    let mut entries: Vec<(String, u64, u128)> = Vec::new();
    let mut stack = vec![(root.to_path_buf(), String::new(), 0usize)];
    while let Some((dir, prefix, depth)) = stack.pop() {
        let Ok(read) = fs::read_dir(&dir) else { continue };
        for entry in read.flatten() {
            let Some(name) = entry.file_name().to_str().map(str::to_owned) else { continue };
            if name.starts_with('.') || name.ends_with(TEMP_SUFFIX) {
                continue;
            }
            let Ok(meta) = fs::symlink_metadata(entry.path()) else { continue };
            let relative = format!("{prefix}{name}");
            if meta.is_dir() && depth < MAX_DEPTH {
                stack.push((entry.path(), format!("{relative}/"), depth + 1));
                entries.push((relative, 0, 0));
            } else if meta.is_file() {
                let modified = meta.modified().ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map_or(0, |d| d.as_nanos());
                entries.push((relative, meta.len(), modified));
            }
            if entries.len() >= MAX_FILES {
                break;
            }
        }
    }
    // The order of a folder listing is not fixed; sorting makes the number depend on content only.
    entries.sort();
    let mut hasher = DefaultHasher::new();
    entries.hash(&mut hasher);
    hasher.finish()
}
