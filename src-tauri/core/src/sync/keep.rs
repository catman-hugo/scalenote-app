//! What this device keeps of the vault: the "available offline" choices (version 0.6).
//!
//! By default a device keeps everything, as before. A person can choose per folder or per page
//! what to keep here: text (`.md`), drawings (`.canvas.json`), pictures, and other files (PDFs and
//! anything else). A choice holds for everything inside a folder, until a deeper choice overrides
//! it. A choice on a page (`dir/Plan.md`) also covers the page's drawing (`dir/Plan.canvas.json`).
//!
//! Pictures and PDFs live together in `attachments/`. A file there is kept when a page this device
//! keeps links to it and that page's choice includes its kind; otherwise the choice for the
//! `attachments` folder decides. The words kept beside a picture (`x.png.text.json`) follow the
//! picture.
//!
//! The rules that make this safe (the 0.6 plan, docs/v0.6-plan.md):
//! - **"Not kept here" is never "deleted".** A file this device does not have, did not have at the
//!   last sync (`base`), and does not keep, is left out of the sync on both sides. A file that was
//!   here at the last sync and is now gone was deleted by the person, and that still syncs.
//! - **Freeing space never loses the only copy.** A local copy is only removed when a saved list
//!   shows a paired device had exactly this version at the last sync. When it is removed, it is
//!   taken out of every saved list (so the next sync does not read its absence as a delete) and
//!   written to the "removed" list, which is sent to other devices as "not here by choice" until
//!   the file is back. Devices that started a sync keep their own saved list, so this is how they
//!   learn the file was not deleted.
//! - **The choices are per device.** They live in `.scalenote/offline.txt` of this vault, which is
//!   never synced (only `.scalenote/folder-icons.json` is), and Obsidian ignores hidden folders.

use super::manifest::{safe_path, Manifest, MAX_FILES};
use super::{Result, SyncError};
use crate::atomic::write_atomic;
use crate::attachments::{ATTACHMENT_DIR, PAGE_TEXT_SUFFIX};
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};

const RULES_FILE: &str = ".scalenote/offline.txt";
const REMOVED_FILE: &str = ".scalenote/offline-removed.txt";
const RULES_HEADER: &str = "scalenote-offline 1";
const REMOVED_HEADER: &str = "scalenote-offline-removed 1";
/// The settings file of the notes is always kept: folders would lose their colours otherwise.
const SETTINGS_FILE: &str = ".scalenote/folder-icons.json";
/// No person makes more choices than this; a longer list (from a damaged file or another device) is refused.
pub const MAX_RULES: usize = 10_000;
const MAX_RULES_BYTES: u64 = 4 * 1024 * 1024;
const MAX_REMOVED_BYTES: u64 = 64 * 1024 * 1024;
/// A page bigger than this is not read for its links (notes are limited to 8 MB anyway).
const MAX_PAGE_BYTES: u64 = 8 * 1024 * 1024;

/// The four kinds of file a choice can keep.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum Kind {
    Text,
    Drawing,
    Picture,
    Other,
}

const PICTURE_EXTENSIONS: [&str; 8] = ["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "avif"];

impl Kind {
    fn letter(self) -> char {
        match self {
            Kind::Text => 't',
            Kind::Drawing => 'd',
            Kind::Picture => 'i',
            Kind::Other => 'f',
        }
    }

    const ALL: [Kind; 4] = [Kind::Text, Kind::Drawing, Kind::Picture, Kind::Other];
}

/// The kind of a vault file, by its name.
pub fn kind_of(path: &str) -> Kind {
    let path = owner_of(path);
    let lower = path.to_ascii_lowercase();
    if lower.ends_with(".canvas.json") {
        return Kind::Drawing;
    }
    if lower.ends_with(".md") {
        return Kind::Text;
    }
    let extension = lower.rsplit_once('.').map_or("", |(_, e)| e);
    if !lower.rsplit('/').next().unwrap_or("").starts_with('.') && PICTURE_EXTENSIONS.contains(&extension) {
        return Kind::Picture;
    }
    Kind::Other
}

/// The file another file belongs to: `x.png.text.json` belongs to `x.png`. Others belong to themselves.
fn owner_of(path: &str) -> &str {
    path.strip_suffix(PAGE_TEXT_SUFFIX).filter(|p| !p.is_empty() && !p.ends_with('/')).unwrap_or(path)
}

/// Which kinds a choice keeps. All four is "keep everything", none is "keep nothing here".
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Kinds(u8);

impl Kinds {
    pub const ALL: Kinds = Kinds(0b1111);
    pub const NONE: Kinds = Kinds(0);

    fn bit(kind: Kind) -> u8 {
        1 << (kind as u8)
    }

    pub fn of(kinds: &[Kind]) -> Kinds {
        Kinds(kinds.iter().fold(0, |all, k| all | Kinds::bit(*k)))
    }

    pub fn has(self, kind: Kind) -> bool {
        self.0 & Kinds::bit(kind) != 0
    }

    /// `tdif` for all, `t` for text only, `-` for nothing.
    pub fn to_letters(self) -> String {
        let letters: String = Kind::ALL.iter().filter(|k| self.has(**k)).map(|k| k.letter()).collect();
        if letters.is_empty() {
            "-".to_string()
        } else {
            letters
        }
    }

    pub fn from_letters(text: &str) -> Option<Kinds> {
        if text == "-" {
            return Some(Kinds::NONE);
        }
        if text.is_empty() || text.len() > 4 {
            return None;
        }
        let mut kinds = Kinds::NONE;
        for c in text.chars() {
            let kind = Kind::ALL.into_iter().find(|k| k.letter() == c)?;
            if kinds.has(kind) {
                return None;
            }
            kinds.0 |= Kinds::bit(kind);
        }
        Some(kinds)
    }
}

/// What one device keeps: its choices, plus the attachments its kept pages link to.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct KeepRules {
    /// Folder path or page path (`dir/Plan.md`) -> kinds. `""` is the whole vault.
    pub choices: BTreeMap<String, Kinds>,
    /// Files in `attachments/` that are kept because a kept page links to them.
    pub linked: BTreeSet<String>,
}

/// Whether a choice for `rule` covers `path`: the same path, something inside that folder, or the
/// drawing of that page.
fn covers(rule: &str, path: &str) -> bool {
    if rule.is_empty() || path == rule {
        return true;
    }
    if path.len() > rule.len() && path.starts_with(rule) && path.as_bytes()[rule.len()] == b'/' {
        return true;
    }
    match rule.strip_suffix(".md") {
        Some(stem) => path.strip_prefix(stem) == Some(".canvas.json"),
        None => false,
    }
}

/// A path a choice may be made for: the whole vault (`""`) or a safe vault path.
fn choice_path_ok(path: &str) -> bool {
    path.is_empty() || (safe_path(path) && path != SETTINGS_FILE && path != super::shares::SHARES_FILE)
}

impl KeepRules {
    /// Keeps everything: no choices at all. This is how every device starts, and how a device
    /// that never says otherwise (an app older than 0.6) is treated.
    pub fn keeps_everything(&self) -> bool {
        self.choices.values().all(|k| *k == Kinds::ALL)
    }

    /// The choice that holds for `path`: the deepest one that covers it.
    pub fn choice_for(&self, path: &str) -> Kinds {
        let mut best: Option<(&String, Kinds)> = None;
        for (rule, kinds) in &self.choices {
            if covers(rule, path) && best.map_or(true, |(b, _)| rule.len() >= b.len()) {
                best = Some((rule, *kinds));
            }
        }
        best.map_or(Kinds::ALL, |(_, k)| k)
    }

    /// Whether this device keeps anything in the folder `folder` (0.6.6, foldersync.rs): its own
    /// choice keeps some kind, or a choice for a folder inside it does. A folder kept for
    /// nothing is not made by a sync; its pages are listed from the other devices anyway.
    pub fn keeps_folder(&self, folder: &str) -> bool {
        self.choice_for(folder) != Kinds::NONE || self.choices.iter().any(|(rule, kinds)| *kinds != Kinds::NONE && rule != folder && covers(folder, rule))
    }

    /// Whether this device keeps `path`.
    pub fn keeps(&self, path: &str) -> bool {
        if path == SETTINGS_FILE || path == super::shares::SHARES_FILE {
            return true;
        }
        let owner = owner_of(path);
        if self.linked.contains(owner) {
            return true;
        }
        self.choice_for(owner).has(kind_of(owner))
    }

    /// Sets (or with `None` removes) the choice for one folder or page.
    pub fn set(&mut self, path: &str, kinds: Option<Kinds>) -> Result<()> {
        if !choice_path_ok(path) {
            return Err(SyncError::Refused("path not allowed"));
        }
        match kinds {
            Some(kinds) => {
                if !self.choices.contains_key(path) && self.choices.len() >= MAX_RULES {
                    return Err(SyncError::Refused("too many choices"));
                }
                self.choices.insert(path.to_string(), kinds);
            }
            None => {
                self.choices.remove(path);
            }
        }
        Ok(())
    }

    fn choices_text(&self) -> String {
        let mut out = format!("{RULES_HEADER}\n");
        for (path, kinds) in &self.choices {
            out.push_str(&format!("{} {path}\n", kinds.to_letters()));
        }
        out
    }

    /// Reads choices written by `choices_text`. Anything unexpected is refused as a whole.
    fn from_choices_text(text: &str) -> Result<KeepRules> {
        let mut lines = text.lines();
        if lines.next() != Some(RULES_HEADER) {
            return Err(SyncError::Damaged("offline choices"));
        }
        let mut rules = KeepRules::default();
        for line in lines {
            let (letters, path) = line.split_once(' ').ok_or(SyncError::Damaged("offline choices"))?;
            let kinds = Kinds::from_letters(letters).ok_or(SyncError::Damaged("offline choices"))?;
            if !choice_path_ok(path) || rules.choices.len() >= MAX_RULES || rules.choices.insert(path.to_string(), kinds).is_some() {
                return Err(SyncError::Damaged("offline choices"));
            }
        }
        Ok(rules)
    }

    /// This vault's choices on this device. No file means "keep everything". A damaged file is
    /// also read as "keep everything": the safe reading, because keeping more never loses anything.
    pub fn load(root: &Path) -> KeepRules {
        let path = root.join(RULES_FILE);
        match fs::symlink_metadata(&path) {
            Ok(meta) if meta.is_file() && meta.len() <= MAX_RULES_BYTES => {}
            _ => return KeepRules::default(),
        }
        fs::read_to_string(&path).ok().and_then(|text| KeepRules::from_choices_text(&text).ok()).unwrap_or_default()
    }

    /// Saves the choices of this vault on this device (atomic write).
    pub fn save(&self, root: &Path) -> Result<()> {
        write_hidden(root, RULES_FILE, self.choices_text().as_bytes())
    }

    /// This device's choices with the attachments its kept pages link to filled in.
    pub fn load_with_links(root: &Path, local: &Manifest) -> KeepRules {
        let mut rules = KeepRules::load(root);
        rules.linked = rules.linked_attachments(root, local);
        rules
    }

    /// The attachments kept because of links: for every page here that this device keeps, the
    /// files in `attachments/` it links to whose kind its choice includes.
    fn linked_attachments(&self, root: &Path, local: &Manifest) -> BTreeSet<String> {
        let mut linked = BTreeSet::new();
        if self.keeps_everything() {
            return linked;
        }
        for (path, state) in &local.files {
            if kind_of(path) != Kind::Text || state.size > MAX_PAGE_BYTES {
                continue;
            }
            let choice = self.choice_for(path);
            if !choice.has(Kind::Text) || !(choice.has(Kind::Picture) || choice.has(Kind::Other)) {
                continue;
            }
            let Ok(text) = fs::read_to_string(root.join(path)) else { continue };
            for target in attachment_links(&text) {
                if choice.has(kind_of(&target)) && linked.len() < MAX_FILES {
                    linked.insert(target);
                }
            }
        }
        linked
    }
}

/// The `attachments/...` files a page links to, in any of the forms ScaleNote and Obsidian write:
/// `![](attachments/x.png)`, `![alt|300](attachments/x.pdf)`, `![[attachments/x.png]]`.
/// Spaces written as `%20` are read back. Anything that is not a safe path is dropped.
pub fn attachment_links(text: &str) -> BTreeSet<String> {
    let needle = format!("{ATTACHMENT_DIR}/");
    let mut found = BTreeSet::new();
    let mut rest = text;
    while let Some(at) = rest.find(&needle) {
        let before = rest[..at].chars().next_back();
        let tail = &rest[at..];
        let end = tail.find(|c: char| c == ')' || c == ']' || c == '|' || c == '"' || c == '#' || c == '<' || c == '>' || c.is_whitespace()).unwrap_or(tail.len());
        // Only a link that starts the target (after `(`, `[` or `/`-less start), not the middle
        // of another path such as `old/attachments/x.png`.
        if matches!(before, None | Some('(') | Some('[') | Some('<') | Some(' ')) {
            let target = tail[..end].replace("%20", " ");
            if safe_path(&target) && target.matches('/').count() == 1 {
                found.insert(target);
            }
        }
        rest = &tail[needle.len()..];
    }
    found
}

fn write_hidden(root: &Path, relative: &str, bytes: &[u8]) -> Result<()> {
    let path = root.join(relative);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    write_atomic(&path, bytes)?;
    Ok(())
}

/// The files this device removed to free space and does not have back yet.
pub fn load_removed(root: &Path) -> BTreeSet<String> {
    let path = root.join(REMOVED_FILE);
    match fs::symlink_metadata(&path) {
        Ok(meta) if meta.is_file() && meta.len() <= MAX_REMOVED_BYTES => {}
        _ => return BTreeSet::new(),
    }
    let Ok(text) = fs::read_to_string(&path) else { return BTreeSet::new() };
    let mut lines = text.lines();
    if lines.next() != Some(REMOVED_HEADER) {
        return BTreeSet::new();
    }
    lines.filter(|l| safe_path(l)).take(MAX_FILES).map(str::to_string).collect()
}

fn save_removed(root: &Path, removed: &BTreeSet<String>) -> Result<()> {
    let mut text = format!("{REMOVED_HEADER}\n");
    for path in removed {
        text.push_str(path);
        text.push('\n');
    }
    write_hidden(root, REMOVED_FILE, text.as_bytes())
}

/// The removed files that are still not here: what this device tells others it does not have
/// by choice. Files that came back are dropped from the saved list on the way.
pub fn still_removed(root: &Path, local: &Manifest) -> BTreeSet<String> {
    let removed = load_removed(root);
    let missing: BTreeSet<String> = removed.iter().filter(|p| !local.files.contains_key(*p)).cloned().collect();
    if missing.len() != removed.len() {
        let _ = save_removed(root, &missing);
    }
    missing
}

/// The paths a sync leaves alone because the device with list `held` does not have them by
/// choice: not there now, not there at the last sync (`base`), and not kept by its `rules`.
pub fn left_out<'a>(rules: &KeepRules, held: &Manifest, base: &Manifest, candidates: impl Iterator<Item = &'a String>) -> BTreeSet<String> {
    if rules.keeps_everything() && rules.linked.is_empty() {
        return BTreeSet::new();
    }
    candidates
        .filter(|p| !held.files.contains_key(*p) && !base.files.contains_key(*p) && !rules.keeps(p))
        .cloned()
        .collect()
}

/// The saved lists of this vault ("what both sides had at the last sync"), one per paired device.
/// Whether a file name is the saved list of a sync with one of this person's own devices:
/// `sync-base-<16 hex>.txt`. The lists of share syncs with other people (`sync-base-<16 hex>-<16
/// hex>.txt`, 0.6.4) do not count: a copy on someone else's device is not a copy of one's own, and
/// their names are share names, not paths in this folder.
fn own_device_list(name: &str) -> bool {
    name.strip_prefix("sync-base-").and_then(|n| n.strip_suffix(".txt")).is_some_and(|id| id.len() == 16 && id.bytes().all(|b| b.is_ascii_hexdigit()))
}

fn base_files(root: &Path) -> Vec<PathBuf> {
    let Ok(entries) = fs::read_dir(root.join(".scalenote")) else { return Vec::new() };
    let mut found: Vec<PathBuf> = entries
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| p.file_name().and_then(|n| n.to_str()).is_some_and(own_device_list))
        .collect();
    found.sort();
    found
}

fn read_list(path: &Path) -> Option<Manifest> {
    let meta = fs::symlink_metadata(path).ok()?;
    if !meta.is_file() || meta.len() > super::manifest::MAX_MANIFEST_BYTES as u64 {
        return None;
    }
    Manifest::from_text(&fs::read_to_string(path).ok()?).ok()
}

/// What "Free up space" did.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct FreeReport {
    /// Removed from this device (another device has the same version).
    pub removed: Vec<String>,
    pub bytes: u64,
    /// Not kept by the choices, but left here: no paired device had this version at the last
    /// sync (new or changed here since). They go once a sync has brought them across.
    pub only_here: Vec<String>,
}

/// Removes from this device the files its choices no longer keep, but only those a paired device
/// had in exactly this version at the last sync. Steps, in the order that keeps a crash harmless:
/// 1. the files are added to the "removed" list, 2. they are taken out of every saved list,
/// 3. each file is deleted if it still has the version that was checked. A crash after 1 or 2
/// leaves a file that is still here, which the next sync simply finds the same on both sides.
pub fn free_up_space(root: &Path) -> Result<FreeReport> {
    let local = Manifest::scan(root)?.manifest;
    let rules = KeepRules::load_with_links(root, &local);
    let mut report = FreeReport::default();
    if rules.keeps_everything() {
        return Ok(report);
    }
    let bases: Vec<(PathBuf, Manifest)> = base_files(root).into_iter().filter_map(|p| read_list(&p).map(|m| (p, m))).collect();
    let mut chosen = Vec::new();
    for (path, state) in &local.files {
        if rules.keeps(path) {
            continue;
        }
        let elsewhere = bases.iter().any(|(_, base)| base.files.get(path).is_some_and(|b| b.same_content(state)));
        if elsewhere {
            chosen.push((path.clone(), state.clone()));
        } else {
            report.only_here.push(path.clone());
        }
    }
    if chosen.is_empty() {
        return Ok(report);
    }
    let mut removed = load_removed(root);
    removed.extend(chosen.iter().map(|(p, _)| p.clone()));
    save_removed(root, &removed)?;
    for (file, mut base) in bases {
        let before = base.files.len();
        base.files.retain(|p, _| !chosen.iter().any(|(c, _)| c == p));
        if base.files.len() != before {
            write_atomic(&file, base.to_text().as_bytes())?;
        }
    }
    for (path, state) in chosen {
        // Checked again right before: a page typed in a moment ago is never removed.
        if super::files::current_hash(root, &path)?.as_deref() == Some(state.hash.as_str()) {
            fs::remove_file(root.join(&path))?;
            report.bytes += state.size;
            report.removed.push(path);
        }
    }
    Ok(report)
}

/// The saved lists of what other devices had at the last sync (`.scalenote/sync-tree-*.txt`).
fn tree_files(root: &Path) -> Vec<PathBuf> {
    let Ok(entries) = fs::read_dir(root.join(".scalenote")) else { return Vec::new() };
    entries
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| p.file_name().and_then(|n| n.to_str()).is_some_and(|n| n.starts_with("sync-tree-") && n.ends_with(".txt")))
        .collect()
}

/// Every file known to exist on another device or removed from here, that this device does not
/// have by choice. The page list shows these with a cloud icon (0.6.3). Quick enough to ask on
/// every redraw of the page list: no file is hashed, and only kept pages that are here and whose
/// choice keeps pictures or files are read (for the attachments they link to).
pub fn not_here(root: &Path) -> Result<BTreeSet<String>> {
    let here = |p: &String| root.join(p).exists();
    let mut known: BTreeSet<String> = load_removed(root).into_iter().filter(|p| !here(p)).collect();
    let mut rules = KeepRules::load(root);
    if rules.keeps_everything() {
        return Ok(known);
    }
    let mut elsewhere = BTreeSet::new();
    for file in tree_files(root) {
        if let Some(tree) = read_list(&file) {
            elsewhere.extend(tree.files.into_keys());
        }
    }
    for page in elsewhere.iter().filter(|p| kind_of(p) == Kind::Text && here(p)) {
        let choice = rules.choice_for(page);
        if !choice.has(Kind::Text) || !(choice.has(Kind::Picture) || choice.has(Kind::Other)) {
            continue;
        }
        let path = root.join(page);
        if fs::metadata(&path).map(|m| m.len() > MAX_PAGE_BYTES).unwrap_or(true) {
            continue;
        }
        let Ok(text) = fs::read_to_string(&path) else { continue };
        let links: Vec<String> = attachment_links(&text).into_iter().filter(|l| choice.has(kind_of(l))).collect();
        rules.linked.extend(links);
    }
    known.extend(elsewhere.into_iter().filter(|p| !here(p) && !rules.keeps(p)));
    Ok(known)
}

/// The choices of this device, as (path, kinds as letters) pairs: what the "Available offline"
/// menus show. `""` is the whole notes folder.
pub fn choices(root: &Path) -> Vec<(String, String)> {
    KeepRules::load(root).choices.into_iter().map(|(path, kinds)| (path, kinds.to_letters())).collect()
}

/// Sets (or with `None` removes) the choice for one folder or page, saves it, and then frees
/// what is no longer kept, as "Free up space" does (only files another device has).
pub fn set_choice(root: &Path, path: &str, letters: Option<&str>) -> Result<FreeReport> {
    let kinds = match letters {
        Some(text) => Some(Kinds::from_letters(text).ok_or(SyncError::Refused("not a choice"))?),
        None => None,
    };
    let mut rules = KeepRules::load(root);
    rules.set(path, kinds)?;
    rules.save(root)?;
    free_up_space(root)
}

/// Whether renaming, moving or deleting `relative` (a page or a folder) would leave files behind
/// that this device does not have: then it has to wait until those files are here. A page counts
/// its drawing too. It only looks at names (no file is read or hashed), so it is quick enough to
/// ask before every rename. Attachments kept because of a link count as not kept here, which can
/// only make it say "wait" more often, never less.
pub fn has_missing_inside(root: &Path, relative: &str) -> bool {
    if relative.is_empty() {
        return false;
    }
    let rules = KeepRules::load(root);
    let removed = load_removed(root);
    if rules.keeps_everything() && removed.is_empty() {
        return false;
    }
    let missing = |p: &String| covers(relative, p) && !root.join(p).exists();
    if removed.iter().any(missing) {
        return true;
    }
    if rules.keeps_everything() {
        return false;
    }
    tree_files(root).iter().filter_map(|f| read_list(f)).any(|tree| tree.files.keys().any(|p| missing(p) && !rules.keeps(p)))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rules(pairs: &[(&str, &str)]) -> KeepRules {
        let mut r = KeepRules::default();
        for (path, letters) in pairs {
            r.set(path, Some(Kinds::from_letters(letters).expect("letters"))).expect("set");
        }
        r
    }

    #[test]
    fn kinds_by_name() {
        assert_eq!(kind_of("a/Plan.md"), Kind::Text);
        assert_eq!(kind_of("a/Plan.canvas.json"), Kind::Drawing);
        assert_eq!(kind_of("attachments/x.PNG"), Kind::Picture);
        assert_eq!(kind_of("attachments/x.png.text.json"), Kind::Picture);
        assert_eq!(kind_of("attachments/x.pdf"), Kind::Other);
        assert_eq!(kind_of("data.json"), Kind::Other);
    }

    #[test]
    fn letters_round_trip_and_junk_is_refused() {
        for text in ["tdif", "t", "di", "-"] {
            assert_eq!(Kinds::from_letters(text).expect("ok").to_letters(), text);
        }
        for junk in ["", "tt", "x", "tdifx", "t-"] {
            assert!(Kinds::from_letters(junk).is_none(), "{junk}");
        }
    }

    #[test]
    fn the_deepest_choice_wins_and_a_page_choice_covers_its_drawing() {
        let r = rules(&[("", "t"), ("Uni", "tdif"), ("Uni/Old", "-"), ("Home/Plan.md", "td")]);
        assert!(r.keeps("Notes.md"));
        assert!(!r.keeps("Notes.canvas.json"));
        assert!(r.keeps("Uni/Bio/Cells.canvas.json"));
        assert!(!r.keeps("Uni/Old/Exam.md"));
        assert!(r.keeps("Home/Plan.canvas.json"));
        assert!(!r.keeps("Home/Planner.canvas.json"), "a page choice is not a name prefix");
        assert!(!r.keeps("Unicorns/a.canvas.json"), "a folder choice is not a name prefix");
        assert!(r.keeps(".scalenote/folder-icons.json"));
        assert!(KeepRules::default().keeps("anything/at/all.pdf"));
    }

    #[test]
    fn linked_attachments_are_kept_with_their_words() {
        let mut r = rules(&[("", "t")]);
        r.linked.insert("attachments/a.png".to_string());
        assert!(r.keeps("attachments/a.png"));
        assert!(r.keeps("attachments/a.png.text.json"));
        assert!(!r.keeps("attachments/b.png"));
    }

    #[test]
    fn links_are_found_in_every_written_form() {
        let text = "![](attachments/a.png) ![x|300](attachments/b.pdf)\n![[attachments/c%20d.png]] old/attachments/no.png <attachments/e.webp>";
        let found: Vec<String> = attachment_links(text).into_iter().collect();
        assert_eq!(found, ["attachments/a.png", "attachments/b.pdf", "attachments/c d.png", "attachments/e.webp"]);
        assert!(attachment_links("attachments/../x.png attachments/a/b.png").is_empty());
    }

    #[test]
    fn choices_are_saved_and_damage_means_keep_everything() {
        let dir = std::env::temp_dir().join(format!("sn-keep-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).expect("dir");
        let r = rules(&[("", "t"), ("Uni", "tdif")]);
        r.save(&dir).expect("save");
        assert_eq!(KeepRules::load(&dir), r);
        fs::write(dir.join(RULES_FILE), "scalenote-offline 1\nzz Uni\n").expect("damage");
        assert!(KeepRules::load(&dir).keeps_everything());
        let mut bad = KeepRules::default();
        assert!(bad.set("../x", Some(Kinds::ALL)).is_err());
        assert!(bad.set(".scalenote/folder-icons.json", Some(Kinds::NONE)).is_err());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_copy_on_someone_elses_device_does_not_count_when_freeing_space() {
        assert!(own_device_list("sync-base-0123456789abcdef.txt"));
        assert!(!own_device_list("sync-base-0123456789abcdef-fedcba9876543210.txt"));
        assert!(!own_device_list("sync-base-zz23456789abcdef.txt"));
        let dir = std::env::temp_dir().join(format!("sn-keep-share-base-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(dir.join("Bio")).expect("dir");
        fs::write(dir.join("Bio/Cells.md"), "cells").expect("page");
        fs::write(dir.join("Bio/Cells.canvas.json"), "{}").expect("drawing");
        // Only a share sync with another person has this drawing, in exactly this version.
        let list = Manifest::scan(&dir).expect("scan").manifest;
        fs::create_dir_all(dir.join(".scalenote")).expect("dir");
        fs::write(dir.join(".scalenote/sync-base-0123456789abcdef-fedcba9876543210.txt"), list.to_text()).expect("list");
        let report = set_choice(&dir, "Bio", Some("t")).expect("text only");
        assert!(report.removed.is_empty(), "nothing removed: no device of one's own has it");
        assert_eq!(report.only_here, ["Bio/Cells.canvas.json"]);
        assert!(dir.join("Bio/Cells.canvas.json").is_file());
        // With one's own device having it, it is freed.
        fs::write(dir.join(".scalenote/sync-base-0123456789abcdef.txt"), list.to_text()).expect("list");
        assert_eq!(free_up_space(&dir).expect("free").removed, ["Bio/Cells.canvas.json"]);
        let _ = fs::remove_dir_all(&dir);
    }
}
