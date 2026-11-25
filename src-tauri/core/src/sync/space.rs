//! What one share looks like to the sync (0.6.4, slice 5): the "share space".
//!
//! The same shared folder sits at different places in two people's notes (`Biology` for Alice,
//! `Shared with me/Alice/Biology` for Dana), so a share is synced under its own names, the same
//! on both sides, and each device maps them to its own places:
//!
//! - `s/<path>` is the shared item: for a folder, everything in it (`s/Cells.md` is
//!   `Biology/Cells.md` here); for a page, the page, its drawing and its conflict copies only
//!   (`s/Chemistry.md`, `s/Chemistry.canvas.json`, `s/Chemistry (conflict …).md`).
//! - `a/<name>` is a picture or PDF in `attachments/` that a shared page links to. Pages link to
//!   `attachments/<name>` from the top of the notes, so the link works on both sides as it is.
//!
//! Everything else in the notes is outside the share: it is never listed, read, written or
//! removed for the other person. An attachment that no shared page links to may only be made new
//! (a page that was just changed on the other side may link to it), never read, changed or
//! removed.

use super::manifest::{safe_path, Manifest};
use super::shares::Share;
use crate::attachments::{ATTACHMENT_DIR, PAGE_TEXT_SUFFIX};
use std::collections::BTreeSet;
use std::fs;
use std::path::Path;

/// A page bigger than this is not read for its links.
const MAX_PAGE_BYTES: u64 = 2 * 1024 * 1024;

#[derive(Clone, Debug)]
pub struct ShareMap {
    pub id: [u8; super::account::ID_LEN],
    folder: bool,
    /// Where the share is here: the folder, or the page (`….md`).
    path: String,
    /// The attachments (vault paths, `attachments/x.png`) that shared pages here link to.
    linked: BTreeSet<String>,
}

impl ShareMap {
    /// The map of `share` in the notes folder at `root`, whose files are `vault`.
    pub fn new(share: &Share, root: &Path, vault: &Manifest) -> ShareMap {
        let mut map = ShareMap { id: share.id, folder: share.folder, path: share.path.clone(), linked: BTreeSet::new() };
        for (path, state) in &vault.files {
            if !path.ends_with(".md") || state.size > MAX_PAGE_BYTES || map.item_to_space(path).is_none() {
                continue;
            }
            let Ok(text) = fs::read_to_string(root.join(path)) else { continue };
            for link in super::keep::attachment_links(&text) {
                let text_file = format!("{link}{PAGE_TEXT_SUFFIX}");
                if vault.files.contains_key(&text_file) {
                    map.linked.insert(text_file);
                }
                map.linked.insert(link);
            }
        }
        map
    }

    /// The page's name without `.md`, and the folder it is in (`""` or ending in `/`).
    fn page_parts(&self) -> (&str, &str) {
        let stem = self.path.strip_suffix(".md").unwrap_or(&self.path);
        match stem.rfind('/') {
            Some(i) => (&stem[i + 1..], &self.path[..=i]),
            None => (stem, ""),
        }
    }

    /// Whether `name` (one file name) belongs to the shared page.
    fn page_file(&self, name: &str) -> bool {
        let (stem, _) = self.page_parts();
        name == format!("{stem}.md") || name == format!("{stem}.canvas.json") || name.strip_prefix(stem).is_some_and(|rest| rest.starts_with(" (conflict ") && (rest.ends_with(".md") || rest.ends_with(".canvas.json")))
    }

    fn item_to_space(&self, vault: &str) -> Option<String> {
        if self.folder {
            let rest = vault.strip_prefix(&self.path)?.strip_prefix('/')?;
            return Some(format!("s/{rest}"));
        }
        let (_, parent) = self.page_parts();
        let name = vault.strip_prefix(parent)?;
        (!name.contains('/') && self.page_file(name)).then(|| format!("s/{name}"))
    }

    /// The share-space name of a file here, or `None` when it is not part of the share.
    pub fn to_space(&self, vault: &str) -> Option<String> {
        if self.linked.contains(vault) {
            return Some(format!("a/{}", vault.strip_prefix(ATTACHMENT_DIR)?.strip_prefix('/')?));
        }
        self.item_to_space(vault)
    }

    /// Where a share-space name is here, or `None` when it is not a name of this share.
    pub fn to_vault(&self, space: &str) -> Option<String> {
        if !safe_path(space) {
            return None;
        }
        let vault = if let Some(rest) = space.strip_prefix("s/") {
            if self.folder {
                format!("{}/{rest}", self.path)
            } else {
                if rest.contains('/') || !self.page_file(rest) {
                    return None;
                }
                format!("{}{rest}", self.page_parts().1)
            }
        } else if let Some(name) = space.strip_prefix("a/") {
            if name.contains('/') {
                return None;
            }
            format!("{ATTACHMENT_DIR}/{name}")
        } else {
            return None;
        };
        safe_path(&vault).then_some(vault)
    }

    /// Whether the other side may read, change or remove this name: anything of the shared item,
    /// and the attachments its pages here link to.
    pub fn listed(&self, space: &str) -> bool {
        match self.to_vault(space) {
            Some(vault) => space.starts_with("s/") || self.linked.contains(&vault),
            None => false,
        }
    }

    /// The share as the sync sees it: the files of `vault` that are in it, by share-space name.
    pub fn view(&self, vault: &Manifest) -> Manifest {
        let mut view = Manifest::default();
        for (path, state) in &vault.files {
            if let Some(space) = self.to_space(path) {
                view.files.insert(space, state.clone());
            }
        }
        view
    }

    /// The share-space name of a vault path, for names that were skipped (big files, links).
    pub fn view_names<'a>(&self, names: impl Iterator<Item = &'a String>) -> BTreeSet<String> {
        names.filter_map(|n| self.item_to_space(n)).collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sync::manifest::FileState;
    use crate::sync::shares::State;
    use std::collections::BTreeMap;

    fn share(path: &str, folder: bool) -> Share {
        Share { id: [1; 16], item: path.rsplit('/').next().unwrap_or(path).to_string(), folder, owner: [1; 16], people: BTreeMap::new(), path: path.to_string(), state: State::Active, told: true }
    }

    fn map(path: &str, folder: bool) -> ShareMap {
        ShareMap { id: [1; 16], folder, path: path.to_string(), linked: ["attachments/cell.png".to_string()].into() }
    }

    #[test]
    fn a_shared_folder_maps_everything_in_it_and_nothing_else() {
        let m = map("Shared with me/Alice/Biology", true);
        assert_eq!(m.to_space("Shared with me/Alice/Biology/Week 1/Cells.md").as_deref(), Some("s/Week 1/Cells.md"));
        assert_eq!(m.to_vault("s/Week 1/Cells.md").as_deref(), Some("Shared with me/Alice/Biology/Week 1/Cells.md"));
        assert_eq!(m.to_space("Shared with me/Alice/Biology 2/x.md"), None, "a folder with a longer name is not in it");
        assert_eq!(m.to_space("Shared with me/Alice/Biology"), None);
        assert_eq!(m.to_space("Diary.md"), None);
        assert_eq!(m.to_space("attachments/cell.png").as_deref(), Some("a/cell.png"));
        assert_eq!(m.to_space("attachments/other.png"), None, "not linked: not shared");
        for bad in ["../x.md", "s/../x.md", "x.md", "a/sub/x.png", ".scalenote/shares.json", "s/.scalenote/x", "/s/x.md"] {
            assert_eq!(m.to_vault(bad), None, "{bad}");
        }
        assert!(m.listed("a/cell.png") && !m.listed("a/other.png"));
        assert_eq!(m.to_vault("a/other.png").as_deref(), Some("attachments/other.png"), "may be made new");
    }

    #[test]
    fn a_shared_page_maps_its_drawing_and_conflict_copies_only() {
        let m = map("School/Chemistry.md", false);
        for (vault, space) in [("School/Chemistry.md", "s/Chemistry.md"), ("School/Chemistry.canvas.json", "s/Chemistry.canvas.json"), ("School/Chemistry (conflict tablet 2026-11-25).md", "s/Chemistry (conflict tablet 2026-11-25).md")] {
            assert_eq!(m.to_space(vault).as_deref(), Some(space));
            assert_eq!(m.to_vault(space).as_deref(), Some(vault));
        }
        for other in ["School/Chemistry 2.md", "School/Chemistry.txt", "School/Biology.md", "Chemistry.md", "School/Chemistry.md/x"] {
            assert_eq!(m.to_space(other), None, "{other}");
        }
        for bad in ["s/Biology.md", "s/Chemistry.exe", "s/sub/Chemistry.md"] {
            assert_eq!(m.to_vault(bad), None, "{bad}");
        }
    }

    #[test]
    fn links_in_shared_pages_bring_their_attachments_along() {
        let dir = std::env::temp_dir().join(format!("sn-space-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(dir.join("Bio")).expect("dir");
        fs::write(dir.join("Bio/Cells.md"), "![](attachments/cell.png) and ![[attachments/scan.pdf]]").expect("write");
        fs::write(dir.join("Diary.md"), "![](attachments/me.png)").expect("write");
        let mut vault = Manifest::default();
        let state = |size| FileState { hash: "0".repeat(64), size, modified: 0 };
        for (path, size) in [("Bio/Cells.md", 60), ("Diary.md", 24), ("attachments/cell.png", 1), ("attachments/scan.pdf", 1), ("attachments/scan.pdf.text.json", 1), ("attachments/me.png", 1)] {
            vault.files.insert(path.to_string(), state(size));
        }
        let m = ShareMap::new(&share("Bio", true), &dir, &vault);
        let view: Vec<String> = m.view(&vault).files.into_keys().collect();
        assert_eq!(view, ["a/cell.png", "a/scan.pdf", "a/scan.pdf.text.json", "s/Cells.md"]);
        let _ = fs::remove_dir_all(&dir);
    }
}
