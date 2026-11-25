//! How much room the notes folder takes on this device (0.6.5, Settings, Storage).
//!
//! The counts come from the file sizes alone (no file is hashed), so the page opens quickly even
//! for a large folder. Pages are read once, up to a limit, only to learn which pictures and PDFs
//! they show: an attachment counts towards the folder of the first page (in name order) that
//! shows it, so "Biology" includes the pictures of its pages. Attachments no page here shows are
//! a row of their own. The app's own folders (trash, page history, sync data) are rows of their
//! own too, so the total is everything in the notes folder.
//!
//! "Can be freed" is what this device does not keep by its offline choices (sync/keep.rs) but
//! still has. Freeing it removes only files another device has in exactly this version
//! (`keep::free_up_space`), so the real result can be smaller; the report says what stayed.

use crate::attachments::{ATTACHMENT_DIR, PAGE_TEXT_SUFFIX};
use crate::history::HISTORY_DIR;
use crate::sync::keep::{self, attachment_links, KeepRules};
use crate::sync::manifest::{FileState, Manifest};
use crate::trash::TRASH_DIR;
use std::collections::BTreeMap;
use std::fs;
use std::path::Path;

/// The walk stops after this many files or this depth; the report then says it is not complete.
const MAX_FILES: usize = 200_000;
const MAX_DEPTH: usize = 64;
/// Pages bigger than this are not read for their links, and reading stops after this much.
const MAX_PAGE_BYTES: u64 = 2 * 1024 * 1024;
const MAX_READ_BYTES: u64 = 256 * 1024 * 1024;

/// The kinds the Storage page shows.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Part {
    Text,
    Ink,
    Pictures,
    Pdfs,
    Other,
}

impl Part {
    pub const ALL: [Part; 5] = [Part::Text, Part::Ink, Part::Pictures, Part::Pdfs, Part::Other];

    fn of(path: &str) -> Part {
        let owner = path.strip_suffix(PAGE_TEXT_SUFFIX).unwrap_or(path).to_ascii_lowercase();
        match keep::kind_of(path) {
            keep::Kind::Text => Part::Text,
            keep::Kind::Drawing => Part::Ink,
            keep::Kind::Picture => Part::Pictures,
            keep::Kind::Other if owner.ends_with(".pdf") => Part::Pdfs,
            keep::Kind::Other => Part::Other,
        }
    }

    fn index(self) -> usize {
        self as usize
    }
}

/// Bytes per kind, and how many files.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Usage {
    pub bytes: [u64; 5],
    pub files: u64,
}

impl Usage {
    pub fn total(&self) -> u64 {
        self.bytes.iter().sum()
    }

    fn add(&mut self, part: Part, size: u64) {
        self.bytes[part.index()] += size;
        self.files += 1;
    }
}

/// One row of the Storage page.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Row {
    /// A folder of the notes (its path), with everything under it.
    Folder(String),
    /// Pages at the top of the notes folder, in no folder.
    TopPages,
    /// Pictures and PDFs no page here shows.
    LooseAttachments,
    Trash,
    History,
    /// Sync lists, offline choices, the list of shares, conflict-base copies.
    AppData,
}

#[derive(Clone, Debug, Default)]
pub struct StorageReport {
    pub total: Usage,
    /// Top-level rows, biggest first.
    pub rows: Vec<(Row, Usage)>,
    /// Every folder of the notes (`a`, `a/b`, …) with everything under it, to look inside a row.
    pub folders: BTreeMap<String, Usage>,
    /// Not kept by this device's choices but still here: what "Free up space" may remove.
    pub can_free_bytes: u64,
    pub can_free_files: u64,
    /// Whether this device keeps everything (then there is nothing to free).
    pub keeps_everything: bool,
    /// A limit stopped the count early.
    pub incomplete: bool,
}

struct Found {
    path: String,
    size: u64,
}

/// Every file under `root` with its size, without following links, within the limits.
fn walk(root: &Path, incomplete: &mut bool) -> Vec<Found> {
    let mut found = Vec::new();
    let mut stack = vec![(root.to_path_buf(), String::new(), 0usize)];
    while let Some((dir, prefix, depth)) = stack.pop() {
        let Ok(entries) = fs::read_dir(&dir) else { continue };
        for entry in entries.flatten() {
            let Some(name) = entry.file_name().to_str().map(str::to_string) else { continue };
            let Ok(meta) = entry.path().symlink_metadata() else { continue };
            let path = if prefix.is_empty() { name } else { format!("{prefix}/{name}") };
            if meta.is_dir() {
                if depth + 1 >= MAX_DEPTH {
                    *incomplete = true;
                } else {
                    stack.push((entry.path(), path, depth + 1));
                }
            } else if meta.is_file() {
                if found.len() >= MAX_FILES {
                    *incomplete = true;
                    return found;
                }
                found.push(Found { path, size: meta.len() });
            }
        }
    }
    found
}

/// Which top-level row an app folder belongs to, if any.
fn app_row(path: &str) -> Option<Row> {
    let top = path.split('/').next().unwrap_or(path);
    match top {
        t if t == TRASH_DIR => Some(Row::Trash),
        t if t == HISTORY_DIR => Some(Row::History),
        t if t.starts_with('.') => Some(Row::AppData),
        _ => None,
    }
}

/// Counts the notes folder at `root`.
pub fn report(root: &Path) -> StorageReport {
    let mut report = StorageReport::default();
    let files = walk(root, &mut report.incomplete);

    // Which folder each attachment counts towards: the folder of the first page showing it.
    let mut shown_in: BTreeMap<String, String> = BTreeMap::new();
    let mut read = 0u64;
    let mut pages: Vec<&Found> = files.iter().filter(|f| app_row(&f.path).is_none() && f.path.ends_with(".md") && !f.path.starts_with(&format!("{ATTACHMENT_DIR}/"))).collect();
    pages.sort_by(|a, b| a.path.cmp(&b.path));
    for page in pages {
        if page.size > MAX_PAGE_BYTES || read + page.size > MAX_READ_BYTES {
            continue;
        }
        read += page.size;
        let Ok(text) = fs::read_to_string(root.join(&page.path)) else { continue };
        let folder = page.path.rsplit_once('/').map_or(String::new(), |(f, _)| f.to_string());
        for link in attachment_links(&text) {
            shown_in.entry(format!("{link}{PAGE_TEXT_SUFFIX}")).or_insert_with(|| folder.clone());
            shown_in.entry(link).or_insert_with(|| folder.clone());
        }
    }

    let mut rows: Vec<(Row, Usage)> = Vec::new();
    let mut add_row = |row: Row, part: Part, size: u64| match rows.iter_mut().find(|(r, _)| *r == row) {
        Some((_, usage)) => usage.add(part, size),
        None => {
            let mut usage = Usage::default();
            usage.add(part, size);
            rows.push((row, usage));
        }
    };
    for file in &files {
        let part = Part::of(&file.path);
        report.total.add(part, file.size);
        if let Some(row) = app_row(&file.path) {
            add_row(row, part, file.size);
            continue;
        }
        let in_attachments = file.path.starts_with(&format!("{ATTACHMENT_DIR}/"));
        let folder = if in_attachments {
            match shown_in.get(&file.path) {
                Some(folder) => folder.clone(),
                None => {
                    add_row(Row::LooseAttachments, part, file.size);
                    continue;
                }
            }
        } else {
            file.path.rsplit_once('/').map_or(String::new(), |(f, _)| f.to_string())
        };
        if folder.is_empty() {
            add_row(Row::TopPages, part, file.size);
            continue;
        }
        // The file counts in its folder and in every folder above it.
        let mut at = folder.as_str();
        loop {
            report.folders.entry(at.to_string()).or_default().add(part, file.size);
            match at.rsplit_once('/') {
                Some((up, _)) => at = up,
                None => break,
            }
        }
        add_row(Row::Folder(folder.split('/').next().unwrap_or(&folder).to_string()), part, file.size);
    }
    // A top-level folder row holds the same as its entry in `folders`; one count is kept.
    for (row, usage) in rows.iter_mut() {
        if let Row::Folder(name) = row {
            if let Some(whole) = report.folders.get(name) {
                *usage = *whole;
            }
        }
    }
    rows.sort_by(|a, b| b.1.total().cmp(&a.1.total()));
    report.rows = rows;

    // What the offline choices do not keep: listed with sizes only, so nothing is hashed here.
    let mut listed = Manifest::default();
    for file in files.iter().filter(|f| app_row(&f.path).is_none()) {
        listed.files.insert(file.path.clone(), FileState { hash: String::new(), size: file.size, modified: 0 });
    }
    let rules = KeepRules::load_with_links(root, &listed);
    report.keeps_everything = rules.keeps_everything();
    if !report.keeps_everything {
        for (path, state) in &listed.files {
            if !rules.keeps(path) {
                report.can_free_bytes += state.size;
                report.can_free_files += 1;
            }
        }
    }
    report
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("sn-storage-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).expect("scratch");
        dir
    }

    fn put(root: &Path, path: &str, bytes: usize) {
        let file = root.join(path);
        fs::create_dir_all(file.parent().expect("parent")).expect("dir");
        fs::write(file, vec![b'x'; bytes]).expect("write");
    }

    fn row<'a>(report: &'a StorageReport, wanted: &Row) -> &'a Usage {
        &report.rows.iter().find(|(r, _)| r == wanted).unwrap_or_else(|| panic!("no row {wanted:?}")).1
    }

    #[test]
    fn sizes_are_counted_per_folder_and_kind_and_pictures_go_with_the_page_that_shows_them() {
        let root = scratch("count");
        fs::create_dir_all(root.join("Biology/Week 1")).expect("dir");
        fs::write(root.join("Biology/Week 1/Cells.md"), "![](attachments/cell.png) ![[attachments/scan.pdf]]").expect("page");
        put(&root, "Biology/Week 1/Cells.canvas.json", 300);
        put(&root, "attachments/cell.png", 1000);
        put(&root, "attachments/scan.pdf", 5000);
        put(&root, "attachments/scan.pdf.text.json", 50);
        put(&root, "attachments/unused.png", 70);
        put(&root, "Diary.md", 20);
        put(&root, ".trash/old.md", 9);
        put(&root, ".history/Diary.md/1.md", 8);
        put(&root, ".scalenote/sync-base-0011223344556677.txt", 7);
        let report = report(&root);
        let page_bytes = fs::metadata(root.join("Biology/Week 1/Cells.md")).expect("meta").len();
        let biology = row(&report, &Row::Folder("Biology".to_string()));
        assert_eq!(biology.bytes, [page_bytes, 300, 1000, 5050, 0]);
        assert_eq!(report.folders["Biology/Week 1"], *biology, "the folder inside counts the same here");
        assert_eq!(row(&report, &Row::TopPages).total(), 20);
        assert_eq!(row(&report, &Row::LooseAttachments).total(), 70);
        assert_eq!((row(&report, &Row::Trash).total(), row(&report, &Row::History).total(), row(&report, &Row::AppData).total()), (9, 8, 7));
        assert_eq!(report.total.total(), page_bytes + 300 + 1000 + 5050 + 70 + 20 + 9 + 8 + 7);
        assert_eq!(report.rows[0].0, Row::Folder("Biology".to_string()), "biggest first");
        assert!(report.keeps_everything && report.can_free_bytes == 0);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn what_the_offline_choices_do_not_keep_is_what_can_be_freed() {
        let root = scratch("free");
        put(&root, "Biology/Cells.md", 10);
        put(&root, "Biology/Cells.canvas.json", 400);
        put(&root, "Chemistry/Atoms.md", 30);
        keep::set_choice(&root, "Biology", Some("t")).expect("text only");
        let report = report(&root);
        assert!(!report.keeps_everything);
        assert_eq!((report.can_free_files, report.can_free_bytes), (1, 400), "the drawing is not kept, but still here");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn an_empty_or_missing_folder_is_counted_as_nothing() {
        let root = scratch("empty");
        let report = report(&root);
        assert_eq!(report.total.total(), 0);
        assert!(report.rows.is_empty());
        let gone = report_of_missing();
        assert_eq!(gone.total.total(), 0);
        let _ = fs::remove_dir_all(&root);
    }

    fn report_of_missing() -> StorageReport {
        report(Path::new("/nonexistent/sn-storage-missing"))
    }
}
