//! Finding the copies that a sync made when two devices changed the same page, and settling them.
//!
//! A copy is named `Page (conflict alice 2026-11-17).md` (a number is added when the name was
//! taken). Reviewing one means looking at the page and its copy side by side and keeping one of
//! them. Both choices are ordinary changes: the one that is not kept goes to the trash (so it
//! can still be restored), and the next sync carries the result to the other devices like any
//! other edit. Nothing is ever merged or guessed.

use super::device::clean_name;
use super::files::{self, Done, Expect};
use super::manifest::{safe_path, Manifest};
use super::{Result, SyncError};
use crate::vault::Vault;
use std::path::Path;

const MARK: &str = " (conflict ";

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ConflictItem {
    /// The copy, for example `School/Plan (conflict alice 2026-11-17).md`.
    pub copy: String,
    /// The page it belongs to, `School/Plan.md`. It may no longer exist.
    pub original: String,
    /// Which device made the older version, as written in the name.
    pub device: String,
    pub date: String,
    /// Only pages can be shown side by side; other files are kept or dropped as a whole.
    pub is_page: bool,
}

/// Splits a copy's path into the original's path, the device and the date; `None` for any other
/// path.
pub fn parse(copy: &str) -> Option<(String, String, String)> {
    let (folder, file) = match copy.rfind('/') {
        Some(i) => (&copy[..=i], &copy[i + 1..]),
        None => ("", copy),
    };
    let (stem, extension) = match file.rfind('.') {
        Some(i) if i > 0 => (&file[..i], &file[i..]),
        _ => (file, ""),
    };
    let stem = stem.strip_suffix(')')?;
    let at = stem.rfind(MARK)?;
    let label = &stem[at + MARK.len()..];
    let mut parts = label.split(' ');
    let (device, date) = (parts.next()?, parts.next()?);
    let number_ok = parts.next().map_or(true, |n| n.bytes().all(|b| b.is_ascii_digit()) && !n.is_empty());
    let date_ok = date.len() == 10 && date.bytes().enumerate().all(|(i, b)| if i == 4 || i == 7 { b == b'-' } else { b.is_ascii_digit() });
    if parts.next().is_some() || !number_ok || !date_ok || device.is_empty() || clean_name(device) != device || at == 0 {
        return None;
    }
    Some((format!("{folder}{}{extension}", &stem[..at]), device.to_string(), date.to_string()))
}

/// Every copy in the vault, oldest name first. Only visible files that a sync could have made.
pub fn list(root: &Path) -> Result<Vec<ConflictItem>> {
    // Only the names are needed: this runs whenever the page list changes (for the count next
    // to the sync status), so it must not read every file in the vault.
    let mut items = Vec::new();
    for path in &Manifest::names(root)? {
        if let Some((original, device, date)) = parse(path) {
            if safe_path(&original) {
                items.push(ConflictItem { is_page: path.to_lowercase().ends_with(".md"), copy: path.clone(), original, device, date });
            }
        }
    }
    Ok(items)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Keep {
    /// Keep the page as it is now; the copy goes to the trash.
    Page,
    /// Make the copy's text the page; the old page goes to the trash.
    Copy,
}

/// Settles one copy. Both files are checked again right now, so something edited since the
/// screen was drawn is not lost: nothing is changed and `Changed` is returned.
pub fn settle(root: &Path, copy: &str, keep: Keep) -> Result<Done> {
    let (original, _, _) = parse(copy).ok_or(SyncError::Refused("not a conflict copy"))?;
    let vault = Vault::open(root).map_err(|_| SyncError::Refused("not a vault"))?;
    let Some(copy_hash) = files::current_hash(root, copy)? else { return Ok(Done::Changed) };
    let trash = |path: &str| vault.move_file_to_trash(path).map(|_| ()).map_err(|_| SyncError::Refused("could not move to the trash"));
    if keep == Keep::Copy {
        let Some(bytes) = files::read_expected(root, copy, &copy_hash)? else { return Ok(Done::Changed) };
        // The page as it is now goes to the trash first, so its text can still be restored;
        // only then does the copy's text take its name. A stop between the two steps leaves
        // the copy where it is and the old page in the trash.
        if files::current_hash(root, &original)?.is_some() {
            trash(&original)?;
        }
        if files::put(root, &original, Expect::Absent, &bytes, None)? == Done::Changed {
            return Ok(Done::Changed);
        }
    }
    trash(copy)?;
    Ok(Done::Applied)
}
