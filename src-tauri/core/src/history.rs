//! Page history: older versions of a page, kept automatically so a bad edit, a bad paste or a
//! bad sync can be undone, long after the editor's own Undo is gone.
//!
//! Every time a save is about to replace a page's content, the content that is being replaced is
//! copied into a hidden `.history` folder in the vault, unless the last copy of that page is
//! less than five minutes old. So a copy is made at the first edit after a pause, and then about
//! every five minutes of continuous work, which is "at sensible moments" without a timer.
//!
//! ```text
//! .history/<key>/<milliseconds since 1970>.md     one older version, as plain text
//! ```
//!
//! `<key>` is the page's own `id:` property when it has one (the app writes one on the first
//! save), so the history follows the page when it is renamed or moved. A page without an id (a
//! file that was only ever edited in another program) uses a fingerprint of its path, and loses
//! its history if it is renamed before it gets an id.
//!
//! Old versions are thinned out: all of the last day, one per day for a month, one per month for
//! a year, nothing older, never more than 100 per page and 32 MiB per page, and 256 MiB for the
//! whole folder. Hidden folders are not listed in the page list, not searched and not copied to
//! Obsidian, so the history stays out of the way, like the trash.
//!
//! A failed copy never stops a save: the note matters more than its history.

use crate::atomic::write_atomic;
use crate::tags::front_lines;
use crate::vault::{NoteVersion, Result, Vault, VaultError, MAX_NOTE_BYTES};
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

pub const HISTORY_DIR: &str = ".history";

const MINUTE: u64 = 60_000;
const DAY: u64 = 24 * 60 * MINUTE;
/// A new copy of a page is made only when the last one is at least this old.
const MIN_GAP: u64 = 5 * MINUTE;
const KEEP_ALL_FOR: u64 = DAY;
const KEEP_DAILY_FOR: u64 = 30 * DAY;
const KEEP_MONTHLY_FOR: u64 = 365 * DAY;
const MAX_VERSIONS: usize = 100;
const MAX_PAGE_BYTES: u64 = 32 * 1024 * 1024;
const MAX_TOTAL_BYTES: u64 = 256 * 1024 * 1024;
/// The whole folder is measured once in this many copies, because measuring walks every file.
const TOTAL_CHECK_EVERY: usize = 50;
/// A listing returns at most this many versions.
const MAX_LISTED: usize = 500;
/// A folder with more entries than this is not walked completely when measuring the total.
const MAX_WALKED: usize = 200_000;

static COPIES_MADE: AtomicUsize = AtomicUsize::new(0);

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HistoryEntry {
    /// The name of the copy: milliseconds since 1970, as digits. Passed back to read it.
    pub id: String,
    /// Seconds since 1970.
    pub time: u64,
    pub size: u64,
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

/// The value of the `id:` property of a page, when it is a plain short word.
fn front_id(text: &str) -> Option<String> {
    let lines = front_lines(text)?;
    let value = lines.iter().find_map(|line| line.trim_end_matches(['\r', '\n']).strip_prefix("id:"))?;
    let id = value.trim().trim_matches(['"', '\'']);
    let ok = !id.is_empty() && id.len() <= 64 && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_');
    ok.then(|| id.to_string())
}

/// The folder name a page's history is kept under. It is made only of letters, digits, "-" and
/// "_", so it can never point out of the history folder.
fn page_key(relative: &str, text: &str) -> String {
    match front_id(text) {
        Some(id) => format!("i-{id}"),
        None => {
            let print = NoteVersion::of(relative.as_bytes());
            format!("p-{:016x}{:x}", print.hash, print.len)
        }
    }
}

fn valid_copy_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 20 && id.bytes().all(|b| b.is_ascii_digit())
}

/// Which copies (given as `(time in ms, size)`) to delete so that what is left follows the
/// thinning rules. Pure, so the rules are tested without touching files or the clock.
fn copies_to_delete(copies: &[(u64, u64)], now: u64) -> Vec<u64> {
    let mut kept: Vec<(u64, u64)> = Vec::new();
    let mut seen_buckets = HashSet::new();
    let mut newest_first = copies.to_vec();
    newest_first.sort_by(|a, b| b.0.cmp(&a.0));
    for &(time, size) in &newest_first {
        let age = now.saturating_sub(time);
        let keep = if age <= KEEP_ALL_FOR {
            true
        } else if age <= KEEP_DAILY_FOR {
            seen_buckets.insert((0u8, time / DAY))
        } else if age <= KEEP_MONTHLY_FOR {
            seen_buckets.insert((1u8, time / (30 * DAY)))
        } else {
            false
        };
        if keep {
            kept.push((time, size));
        }
    }
    // The newest are kept first when there are too many or too many bytes.
    let mut bytes = 0u64;
    let mut survivors = HashSet::new();
    for (index, &(time, size)) in kept.iter().enumerate() {
        bytes = bytes.saturating_add(size);
        if index < MAX_VERSIONS && (bytes <= MAX_PAGE_BYTES || index == 0) {
            survivors.insert(time);
        }
    }
    newest_first.iter().map(|c| c.0).filter(|time| !survivors.contains(time)).collect()
}

fn copy_path(dir: &Path, ms: u64) -> PathBuf {
    dir.join(format!("{ms}.md"))
}

/// The copies in one page's folder as `(time in ms, size)`, skipping anything that is not a copy.
fn read_copies(dir: &Path) -> Vec<(u64, u64)> {
    let Ok(read) = fs::read_dir(dir) else { return Vec::new() };
    let mut out = Vec::new();
    for entry in read.flatten().take(MAX_WALKED) {
        let name = entry.file_name().to_string_lossy().into_owned();
        let Some(id) = name.strip_suffix(".md") else { continue };
        if !valid_copy_id(id) {
            continue;
        }
        let (Ok(ms), Ok(meta)) = (id.parse::<u64>(), entry.metadata()) else { continue };
        if meta.is_file() {
            out.push((ms, meta.len()));
        }
    }
    out
}

impl Vault {
    fn history_root(&self) -> PathBuf {
        self.root().join(HISTORY_DIR)
    }

    /// Called by `write_note` before it replaces `old` with `new`. Makes a copy of `old` when
    /// the rules say so. Never fails the save.
    pub(crate) fn history_before_save(&self, relative: &str, old: &[u8], new: &str) {
        let Ok(old_text) = std::str::from_utf8(old) else { return };
        if old_text == new {
            return;
        }
        let key = page_key(relative, if front_id(new).is_some() { new } else { old_text });
        if let Err(error) = self.history_copy(&key, old, now_ms(), false) {
            if let Ok(mut slot) = self.history_problem.lock() {
                *slot = Some(format!("{error:?}"));
            }
        }
    }

    /// The last failure to keep an older version, once. `None` when there was none.
    pub fn take_history_problem(&self) -> Option<String> {
        self.history_problem.lock().ok().and_then(|mut slot| slot.take())
    }

    /// Copies `old` into the history under `key` at time `now`. Unless `force` is set it does
    /// nothing when the newest copy is less than five minutes old or has the same content.
    fn history_copy(&self, key: &str, old: &[u8], now: u64, force: bool) -> Result<bool> {
        let dir = self.history_root().join(key);
        let copies = read_copies(&dir);
        if let Some(&(newest, _)) = copies.iter().max_by_key(|c| c.0) {
            if !force && now.saturating_sub(newest) < MIN_GAP {
                return Ok(false);
            }
            if fs::read(copy_path(&dir, newest)).is_ok_and(|same| same == old) {
                return Ok(false);
            }
        }
        fs::create_dir_all(&dir)?;
        // Two copies in the same millisecond would share a name; the next free one is used.
        let mut ms = now;
        while copy_path(&dir, ms).exists() {
            ms += 1;
        }
        write_atomic(&copy_path(&dir, ms), old)?;
        let mut all = copies;
        all.push((ms, old.len() as u64));
        for time in copies_to_delete(&all, now) {
            let _ = fs::remove_file(copy_path(&dir, time));
        }
        if COPIES_MADE.fetch_add(1, Ordering::Relaxed) % TOTAL_CHECK_EVERY == TOTAL_CHECK_EVERY - 1 {
            self.history_enforce_total(MAX_TOTAL_BYTES);
        }
        Ok(true)
    }

    /// Deletes the oldest copies of all pages until the whole history is at most `limit` bytes.
    fn history_enforce_total(&self, limit: u64) {
        let Ok(pages) = fs::read_dir(self.history_root()) else { return };
        let mut all: Vec<(u64, u64, PathBuf)> = Vec::new();
        let mut total = 0u64;
        for page in pages.flatten().take(MAX_WALKED) {
            for (ms, size) in read_copies(&page.path()) {
                total = total.saturating_add(size);
                all.push((ms, size, copy_path(&page.path(), ms)));
            }
            if all.len() > MAX_WALKED {
                break;
            }
        }
        if total <= limit {
            return;
        }
        all.sort_by_key(|c| c.0);
        for (_, size, path) in all {
            if total <= limit {
                break;
            }
            if fs::remove_file(&path).is_ok() {
                total = total.saturating_sub(size);
            }
        }
    }

    // The folder name for a page's history, from what is on disk now.
    fn history_dir_for(&self, relative: &str) -> Result<PathBuf> {
        let current = self.read_note(relative)?;
        Ok(self.history_root().join(page_key(relative, &current.text)))
    }

    /// Makes a copy of the page as it is now, whatever the time since the last one. The
    /// interface calls this before it puts an older version back, so that restoring can itself
    /// be undone.
    pub fn history_keep_now(&self, relative: &str) -> Result<()> {
        let path = self.note_path(relative)?;
        let bytes = fs::read(&path)?;
        if bytes.len() as u64 > MAX_NOTE_BYTES {
            return Err(VaultError::TooLarge);
        }
        let text = String::from_utf8(bytes).map_err(|_| VaultError::NotUtf8)?;
        let key = page_key(relative, &text);
        self.history_copy(&key, text.as_bytes(), now_ms(), true)?;
        Ok(())
    }

    /// The older versions of a page, newest first. A page with no history gives an empty list.
    pub fn history_list(&self, relative: &str) -> Result<Vec<HistoryEntry>> {
        let dir = self.history_dir_for(relative)?;
        let mut copies = read_copies(&dir);
        copies.sort_by(|a, b| b.0.cmp(&a.0));
        copies.truncate(MAX_LISTED);
        Ok(copies.into_iter().map(|(ms, size)| HistoryEntry { id: ms.to_string(), time: ms / 1000, size }).collect())
    }

    /// The text of one older version of a page.
    pub fn history_read(&self, relative: &str, id: &str) -> Result<String> {
        if !valid_copy_id(id) {
            return Err(VaultError::InvalidPath);
        }
        let path = self.history_dir_for(relative)?.join(format!("{id}.md"));
        let meta = fs::metadata(&path)?;
        if !meta.is_file() {
            return Err(VaultError::NotFound);
        }
        if meta.len() > MAX_NOTE_BYTES {
            return Err(VaultError::TooLarge);
        }
        String::from_utf8(fs::read(&path)?).map_err(|_| VaultError::NotUtf8)
    }

    /// Deletes the history of every page. The pages themselves are not touched.
    pub fn history_clear(&self) -> Result<()> {
        match fs::remove_dir_all(self.history_root()) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(error.into()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn vault(name: &str) -> (PathBuf, Vault) {
        let dir = std::env::temp_dir().join(format!("sn-history-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).expect("folder");
        let vault = Vault::open(&dir).expect("open");
        (dir, vault)
    }

    fn save(vault: &Vault, path: &str, text: &str) {
        let expected = vault.read_note(path).ok().map(|n| n.version);
        vault.write_note(path, text, expected).expect("save");
    }

    #[test]
    fn thinning_keeps_a_day_then_one_per_day_then_one_per_month() {
        let now = 1_000 * DAY;
        let mut copies = Vec::new();
        for minute in 0..30 {
            copies.push((now - minute * 10 * MINUTE, 10)); // 5 hours, every 10 minutes
        }
        for day in 2..12 {
            copies.push((now - day * DAY, 10));
            copies.push((now - day * DAY + MINUTE, 10)); // two in one day: only the newest stays
        }
        for month in 3..8 {
            copies.push((now - month * 30 * DAY, 10));
        }
        copies.push((now - 400 * DAY, 10)); // older than a year
        let gone: HashSet<u64> = copies_to_delete(&copies, now).into_iter().collect();
        assert!(copies[..30].iter().all(|c| !gone.contains(&c.0)), "the last day is kept whole");
        for day in 2..12u64 {
            assert!(!gone.contains(&(now - day * DAY + MINUTE)), "newest of day {day} stays");
            assert!(gone.contains(&(now - day * DAY)), "older one of day {day} goes");
        }
        assert!(gone.contains(&(now - 400 * DAY)));
        assert!(copies.iter().filter(|c| !gone.contains(&c.0)).count() >= 30 + 10);
    }

    #[test]
    fn there_are_never_more_than_100_copies_or_32_mib_of_one_page() {
        let now = 10 * DAY;
        let many: Vec<(u64, u64)> = (0..300).map(|i| (now - i * MINUTE, 10)).collect();
        let gone = copies_to_delete(&many, now);
        assert_eq!(many.len() - gone.len(), MAX_VERSIONS);
        assert!(!gone.contains(&now), "the newest is kept");
        let big: Vec<(u64, u64)> = (0..10).map(|i| (now - i * MINUTE, 10 * 1024 * 1024)).collect();
        let kept = big.len() - copies_to_delete(&big, now).len();
        assert_eq!(kept, 3, "three of 10 MiB fit in 32 MiB");
        let one_huge = [(now, 100 * 1024 * 1024u64)];
        assert!(copies_to_delete(&one_huge, now).is_empty(), "the newest is never dropped for its size alone");
    }

    #[test]
    fn a_save_keeps_the_text_it_replaces_but_not_more_often_than_every_five_minutes() {
        let (dir, vault) = vault("gap");
        save(&vault, "A.md", "one\n");
        assert!(vault.history_list("A.md").expect("list").is_empty(), "a new page has no older version");
        save(&vault, "A.md", "two\n");
        save(&vault, "A.md", "three\n");
        save(&vault, "A.md", "four\n");
        let list = vault.history_list("A.md").expect("list");
        assert_eq!(list.len(), 1, "the three quick saves made one copy");
        assert_eq!(vault.history_read("A.md", &list[0].id).expect("read"), "one\n");
        assert_eq!(vault.read_note("A.md").expect("now").text, "four\n");
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn a_copy_is_made_again_after_five_minutes_and_not_when_nothing_changed() {
        let (dir, vault) = vault("later");
        save(&vault, "A.md", "one\n");
        let key = page_key("A.md", "one\n");
        let t = 5_000 * DAY;
        assert!(vault.history_copy(&key, b"one\n", t, false).expect("first"));
        assert!(!vault.history_copy(&key, b"two\n", t + 4 * MINUTE, false).expect("too soon"));
        assert!(!vault.history_copy(&key, b"one\n", t + 6 * MINUTE, false).expect("same text"));
        assert!(vault.history_copy(&key, b"two\n", t + 6 * MINUTE, false).expect("later"));
        assert!(vault.history_copy(&key, b"three\n", t + 7 * MINUTE, true).expect("forced"));
        assert_eq!(read_copies(&vault.history_root().join(&key)).len(), 3);
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn keep_now_copies_the_current_page_at_once_and_does_not_change_it() {
        let (dir, vault) = vault("now");
        save(&vault, "A.md", "one\n");
        save(&vault, "A.md", "two\n");
        vault.history_keep_now("A.md").expect("keep");
        let list = vault.history_list("A.md").expect("list");
        assert_eq!(list.len(), 2);
        assert_eq!(vault.history_read("A.md", &list[0].id).expect("newest"), "two\n");
        assert_eq!(vault.read_note("A.md").expect("now").text, "two\n");
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn the_history_follows_a_page_that_has_an_id_when_it_is_renamed_or_moved() {
        let (dir, vault) = vault("rename");
        save(&vault, "A.md", "---\nid: abc-123\n---\n\none\n");
        save(&vault, "A.md", "---\nid: abc-123\n---\n\ntwo\n");
        vault.rename("A.md", "B").expect("rename");
        let list = vault.history_list("B.md").expect("list");
        assert_eq!(list.len(), 1);
        assert!(vault.history_read("B.md", &list[0].id).expect("read").ends_with("one\n"));
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn a_page_gets_its_history_even_when_the_id_is_added_by_the_save_itself() {
        let (dir, vault) = vault("newid");
        save(&vault, "A.md", "plain\n");
        save(&vault, "A.md", "---\nid: abc\n---\n\nedited\n");
        assert_eq!(vault.history_list("A.md").expect("list").len(), 1, "the old text is under the new id");
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn hostile_ids_and_copy_names_cannot_point_outside_the_history_folder() {
        let (dir, vault) = vault("hostile");
        for id in ["../x", "a/b", "a\\b", "", &"a".repeat(80), "a b", "é"] {
            let text = format!("---\nid: {id}\n---\n\nbody\n");
            let key = page_key("A.md", &text);
            assert!(key.starts_with("p-"), "{id:?} falls back to the path fingerprint: {key}");
            assert!(key.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_'));
        }
        save(&vault, "A.md", "x\n");
        for id in ["../../A", "1/2", "", "abc", "99999999999999999999999", "1.md", "-1"] {
            assert!(vault.history_read("A.md", id).is_err(), "{id:?}");
        }
        assert!(vault.history_list("../A.md").is_err());
        assert!(vault.history_list("Missing.md").is_err());
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn the_history_is_not_a_page_and_clearing_it_leaves_pages_alone() {
        let (dir, vault) = vault("hidden");
        save(&vault, "A.md", "one #tag\n");
        save(&vault, "A.md", "two\n");
        assert!(dir.join(HISTORY_DIR).is_dir());
        let paths: Vec<String> = vault.tree().expect("tree").entries.into_iter().map(|e| e.path).collect();
        assert_eq!(paths, vec!["A.md"]);
        assert!(vault.search("one", 20).expect("search").hits.is_empty(), "old text is not searched");
        assert!(vault.page_index().expect("index").pages.is_empty(), "old tags are not listed");
        vault.history_clear().expect("clear");
        vault.history_clear().expect("clear twice");
        assert!(!dir.join(HISTORY_DIR).exists());
        assert_eq!(vault.read_note("A.md").expect("page").text, "two\n");
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn the_whole_history_is_cut_back_from_the_oldest_copies() {
        let (dir, vault) = vault("total");
        for (page, base) in [("a", 1_000u64), ("b", 2_000)] {
            let folder = vault.history_root().join(page);
            fs::create_dir_all(&folder).expect("folder");
            for i in 0..5 {
                fs::write(copy_path(&folder, base + i), vec![b'x'; 100]).expect("copy");
            }
        }
        vault.history_enforce_total(450);
        let left: usize = ["a", "b"].iter().map(|p| read_copies(&vault.history_root().join(p)).len()).sum();
        assert_eq!(left, 4);
        assert_eq!(read_copies(&vault.history_root().join("a")).len(), 0, "the oldest copies went first");
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn odd_files_in_the_history_folder_are_ignored() {
        let (dir, vault) = vault("odd");
        save(&vault, "A.md", "one\n");
        save(&vault, "A.md", "two\n");
        let folder = vault.history_dir_for("A.md").expect("folder");
        fs::write(folder.join("notes.txt"), "x").expect("stray");
        fs::write(folder.join("12x.md"), "x").expect("stray");
        fs::create_dir_all(folder.join("99.md")).expect("folder named like a copy");
        let list = vault.history_list("A.md").expect("list");
        assert_eq!(list.len(), 1);
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn a_failed_copy_does_not_fail_the_save_but_is_reported_once() {
        let (dir, vault) = vault("problem");
        save(&vault, "A.md", "one\n");
        // A file where the history folder should be: no copy can be made.
        fs::write(vault.root().join(HISTORY_DIR), "in the way").expect("blocker");
        save(&vault, "A.md", "two\n");
        assert_eq!(vault.read_note("A.md").expect("read").text, "two\n");
        assert!(vault.take_history_problem().is_some());
        assert!(vault.take_history_problem().is_none(), "reported only once");
        let _ = fs::remove_dir_all(dir);
    }
}
