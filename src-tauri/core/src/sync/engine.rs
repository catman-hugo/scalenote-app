//! The calling side of a sync: compare two vaults, show what would happen, then do it.
//!
//! Order of a sync, and why:
//! 1. Ask the other device for its list of files, list this vault too, and make a plan
//!    (plan.rs). Nothing has been changed yet; this is also what "Compare" shows.
//! 2. The very first sync with a device (no saved "last time both sides matched") stops here and
//!    waits for the person to say yes, because it is the moment two whole vaults meet.
//! 3. Every action is carried out file by file. Each one says what it expects to find, so a
//!    file that changed in the meantime is left alone and picked up by the next sync. A
//!    conflict first saves the older version next to the newer one on this device, and only
//!    then changes the other device, so a word is never lost even if the connection drops.
//! 4. At the end both lists are made again and the files that are now identical on both sides
//!    are saved as the new "last time both sides matched". Files that are not identical are
//!    left out of it, so they are never mistaken for deleted files next time.
//!
//! The saved list sits inside the vault (`.scalenote/sync-base-<device>.txt`), so a person who
//! switches to another vault folder gets that folder's own history with the device.
//!
//! Since 0.6 a device may keep only part of the vault (keep.rs). Both sides' choices go into the
//! plan as "left out" names, so a file that a device does not have by choice is never copied to
//! it and never taken for a deleted file. After each sync the other device's list is saved too
//! (`.scalenote/sync-tree-<device>.txt`): what exists elsewhere, for the page list and for the
//! check before a folder with missing files is renamed or moved.

use super::channel::Channel;
use super::exchange::*;
use super::exchange::Listing;
use super::space::ShareMap;
use super::files::{self, Done, Expect, MAX_TRANSFER_BYTES};
use super::foldersync::{self, FolderAction};
use super::identity::KEY_LEN;
use super::keep::{self, KeepRules};
use super::manifest::{FileState, Manifest};
use super::plan::{conflict_name, make_plan, Action, Plan, PlanInput, PlanSummary, Side};
use super::{hex, Result, SyncError};
use crate::atomic::write_atomic;
use std::collections::BTreeSet;
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

/// The one settings file that is synced: when both sides changed it, the newer one wins and no
/// copy is made (a copy of a hidden settings file would be a file nobody can see).
const SETTINGS_FILE: &str = ".scalenote/folder-icons.json";
const SHARES_FILE: &str = super::shares::SHARES_FILE;

/// The two small files of the notes folder that are merged entry by entry instead of copied
/// whole: the folder colours (by folder) and, since 0.6.4, the list of shares (by share).
fn merged_file(path: &str) -> bool {
    path == SETTINGS_FILE || path == SHARES_FILE
}
const BASE_DIR: &str = ".scalenote";
/// The saved list is read back as untrusted input and must stay small.
const MAX_BASE_BYTES: u64 = 64 * 1024 * 1024;

/// Who is syncing with whom.
pub struct Pair<'a> {
    pub root: &'a Path,
    /// The other device's public key; names its saved list.
    pub peer_key: &'a [u8; KEY_LEN],
    pub own_name: &'a str,
    pub peer_name: &'a str,
    /// For the name of conflict copies, `2026-11-17`.
    pub today: &'a str,
    /// Whether the other device knows the list of shares (0.6.4 and later; it says so in its
    /// greeting). Older apps refuse a list with a file they do not know, so for them the shares
    /// file is left out of this device's list.
    pub shares: bool,
    /// Whether the other device keeps the list of what both have at the end of a sync between
    /// one's own devices (0.6.9; it says `base=1` in its greeting). Before this only the device
    /// that started a sync kept the list, so the other one saw a rename as a new page and an edit
    /// as a clash the next time it started a sync itself, or showed "first sync" when it never had.
    pub base: bool,
    /// When syncing one share with another person's device (0.6.4): how its share-space names
    /// map to this notes folder (space.rs). `None` for a sync between one's own devices.
    pub map: Option<&'a ShareMap>,
}

/// The vault path of a name in the plan: itself, or for a share sync its place here. A name that
/// is not in the share is refused (the other device can only name what the share holds).
fn place(pair: &Pair, path: &str) -> Result<String> {
    match pair.map {
        None => Ok(path.to_string()),
        Some(map) => map.to_vault(path).ok_or(SyncError::Refused("outside the share")),
    }
}

/// Names the saved lists of this sync: the other device, and for a share sync also the share,
/// so a share's history never mixes with the whole-folder sync with the same device.
fn tag(pair: &Pair) -> String {
    let peer = &hex::encode(pair.peer_key)[..16];
    match pair.map {
        None => peer.to_string(),
        Some(map) => format!("{peer}-{}", &hex::encode(&map.id)[..16]),
    }
}

/// The answering side of a share sync keeps the list the calling device says both now have alike,
/// but only the files that are exactly so here (a list from another person is not taken on trust).
pub fn keep_share_base(pair: &Pair, said: &Manifest) -> Result<()> {
    let Some(map) = pair.map else { return Ok(()) };
    let here = map.view(&Manifest::scan(pair.root)?.manifest);
    let mut same = Manifest::default();
    for (path, state) in &said.files {
        if here.files.get(path).is_some_and(|mine| mine.same_content(state)) {
            same.files.insert(path.clone(), state.clone());
        }
    }
    let before = load_base(pair);
    save_base(pair, &same)?;
    super::basetext::update_mapped(pair.root, &tag(pair), before.as_ref(), &same, &|path| place(pair, path).ok())
}

/// The share's listing: its files by share-space name, no choices (a share is kept whole).
pub fn share_listing(root: &Path, map: &ShareMap) -> Result<Listing> {
    let scan = Manifest::scan(root)?;
    Ok(Listing { manifest: map.view(&scan.manifest), skipped: map.view_names(scan.skipped.iter().map(|s| &s.path)), not_kept: BTreeSet::new(), rules: KeepRules::default(), folders: None })
}

/// What a sync would do, without doing it.
#[derive(Clone, Debug)]
pub struct Preview {
    pub plan: Plan,
    pub summary: PlanSummary,
    /// There is no saved list for this device yet: this is the first sync with it.
    pub first: bool,
    /// Files left out on this side / on the other side (too big, links, odd names).
    pub skipped_here: usize,
    pub skipped_there: usize,
    /// Files left alone because this device / the other device does not keep them (0.6).
    pub not_kept_here: usize,
    pub not_kept_there: usize,
    /// Files bigger than one transfer takes; reported and not moved.
    pub too_big: Vec<String>,
    /// File names for the preview (the actions, with sizes), capped for display.
    pub files_here: usize,
    pub files_there: usize,
    /// Folders to make or remove (foldersync.rs); empty when the other device does not list
    /// folders (an app before 0.6.7) or for a share sync.
    pub folders: Vec<FolderAction>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Report {
    pub sent: usize,
    pub received: usize,
    pub deleted_here: usize,
    pub deleted_there: usize,
    pub conflicts: usize,
    /// Pages changed on both sides whose changes were joined into one text (textmerge.rs).
    pub merged: usize,
    /// The names of the conflict copies made, so the interface can offer to review them.
    pub conflict_copies: Vec<String>,
    /// Files that changed while the sync ran and were left for the next one.
    pub left_for_next: usize,
    pub too_big: Vec<String>,
    pub clashes: Vec<String>,
    /// Folders made or removed on either side (0.6.7).
    pub folders: usize,
}

impl Report {
    /// How many files (and folders) were changed on either side (the "3 changed" of the status line).
    pub fn changed(&self) -> usize {
        self.sent + self.received + self.deleted_here + self.deleted_there + self.conflicts + self.merged + self.folders
    }
}

pub enum Outcome {
    /// The first sync with this device: nothing was changed; the person has to say yes.
    NeedsApproval(Preview),
    Done(Report),
}

#[derive(Clone, Debug)]
pub struct Progress {
    pub done: usize,
    pub total: usize,
    pub path: String,
}

fn base_path(pair: &Pair) -> PathBuf {
    pair.root.join(BASE_DIR).join(format!("sync-base-{}.txt", tag(pair)))
}

/// The folder colours file as both devices had it after the last sync (settings_merge.rs).
fn settings_base_path(root: &Path, peer_key: &[u8; KEY_LEN]) -> PathBuf {
    root.join(BASE_DIR).join(format!("sync-settings-{}.json", &hex::encode(peer_key)[..16]))
}

/// The same for the list of shares (shares.rs).
fn shares_base_path(root: &Path, peer_key: &[u8; KEY_LEN]) -> PathBuf {
    root.join(BASE_DIR).join(format!("sync-shares-{}.json", &hex::encode(peer_key)[..16]))
}

fn merge_base_path(root: &Path, peer_key: &[u8; KEY_LEN], path: &str) -> PathBuf {
    if path == SHARES_FILE {
        shares_base_path(root, peer_key)
    } else {
        settings_base_path(root, peer_key)
    }
}

/// This device's listing as the other device may see it (see `Pair::shares`).
pub fn listing_for(root: &Path, shares: bool) -> Result<Listing> {
    let mut listing = own_listing(root)?;
    if !shares {
        listing.manifest.files.remove(SHARES_FILE);
    }
    Ok(listing)
}

fn tree_path(root: &Path, peer_key: &[u8; KEY_LEN]) -> PathBuf {
    root.join(BASE_DIR).join(format!("sync-tree-{}.txt", &hex::encode(peer_key)[..16]))
}

/// The saved list for this device. A missing or damaged file is "no list": the safe reading,
/// because without a list the planner never deletes anything.
fn load_base(pair: &Pair) -> Option<Manifest> {
    let path = base_path(pair);
    let meta = fs::symlink_metadata(&path).ok()?;
    if !meta.is_file() || meta.len() > MAX_BASE_BYTES {
        return None;
    }
    Manifest::from_text(&fs::read_to_string(&path).ok()?).ok()
}

fn save_base(pair: &Pair, manifest: &Manifest) -> Result<()> {
    let path = base_path(pair);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    write_atomic(&path, manifest.to_text().as_bytes())?;
    Ok(())
}

/// Forgets the saved list of a device (it was removed): a later pairing starts as a first sync.
pub fn forget_base(root: &Path, peer_key: &[u8; KEY_LEN]) {
    let path = root.join(BASE_DIR).join(format!("sync-base-{}.txt", &hex::encode(peer_key)[..16]));
    let _ = fs::remove_file(path);
    let _ = fs::remove_file(tree_path(root, peer_key));
    let _ = fs::remove_file(settings_base_path(root, peer_key));
    let _ = fs::remove_file(shares_base_path(root, peer_key));
    super::basetext::forget(root, &hex::encode(peer_key)[..16]);
    foldersync::forget(root, &hex::encode(peer_key)[..16]);
}

/// Whether this device has synced with that device in this vault before.
pub fn has_history(root: &Path, peer_key: &[u8; KEY_LEN]) -> bool {
    root.join(BASE_DIR).join(format!("sync-base-{}.txt", &hex::encode(peer_key)[..16])).is_file()
}

/// When the last sync with that device finished, in UTC, as far as the saved list of this vault shows
/// (the list is rewritten after each sync). `None` if there never was one.
pub fn last_sync_time(root: &Path, peer_key: &[u8; KEY_LEN]) -> Option<String> {
    let path = root.join(BASE_DIR).join(format!("sync-base-{}.txt", &hex::encode(peer_key)[..16]));
    let seconds = std::fs::metadata(path).ok()?.modified().ok()?.duration_since(std::time::UNIX_EPOCH).ok()?.as_secs();
    Some(crate::logger::format_utc(seconds))
}

fn ask<S: Read + Write>(channel: &mut Channel<S>, kind: u8, meta: &[u8], body: &[u8], max_body: u64) -> Result<Blob> {
    send_blob(channel, kind, meta, body)?;
    let answer = recv_blob(channel, max_body)?;
    if answer.kind == KIND_NO {
        // An app since 0.5.6 says why when this device is tied to another folder there.
        if answer.meta == super::exchange::NO_OTHER_FOLDER {
            return Err(SyncError::Refused("the other device has it with another folder"));
        }
        return Err(SyncError::Refused("the other device said no"));
    }
    Ok(answer)
}

fn fetch_listing<S: Read + Write>(channel: &mut Channel<S>) -> Result<Listing> {
    let answer = ask(channel, KIND_LIST, &[], &[], MAX_LISTING_BYTES)?;
    if answer.kind != KIND_LISTING {
        return Err(SyncError::Damaged("answer to the list request"));
    }
    decode_listing_full(&answer.body)
}

fn too_big(manifest: &Manifest, path: &str) -> bool {
    manifest.files.get(path).is_some_and(|s| s.size > MAX_TRANSFER_BYTES)
}

/// Gives each conflict copy the name of the device that made the older version, and keeps the
/// settings file out of the copy business.
fn finish_plan(mut plan: Plan, local: &Manifest, remote: &Manifest, local_skipped: &BTreeSet<String>, remote_skipped: &BTreeSet<String>, pair: &Pair) -> (Plan, Vec<String>) {
    let mut taken: BTreeSet<String> = local.files.keys().chain(remote.files.keys()).chain(local_skipped).chain(remote_skipped).map(|p| p.to_lowercase()).collect();
    let mut big = Vec::new();
    let mut actions = Vec::new();
    for action in plan.actions.drain(..) {
        let path = action.path().to_string();
        match action {
            // Deleting the colours or shares file would lose every folder's look or every share;
            // skipped. Changed on both sides, they are merged (see `perform`).
            Action::DeleteLocal { .. } | Action::DeleteRemote { .. } if merged_file(&path) => {}
            Action::Conflict { winner, .. } if merged_file(&path) => {
                actions.push(if winner == Side::Local { Action::Push { path } } else { Action::Pull { path } });
            }
            Action::Conflict { path, winner, .. } => {
                let loser = if winner == Side::Local { pair.peer_name } else { pair.own_name };
                let copy = conflict_name(&path, loser, pair.today, &taken);
                taken.insert(copy.to_lowercase());
                if too_big(local, &path) || too_big(remote, &path) {
                    big.push(path);
                } else {
                    actions.push(Action::Conflict { path, copy, winner });
                }
            }
            Action::Push { .. } | Action::Pull { .. } if too_big(local, &path) || too_big(remote, &path) => big.push(path),
            other => actions.push(other),
        }
    }
    plan.actions = actions;
    (plan, big)
}

struct Counts {
    skipped_here: usize,
    skipped_there: usize,
    not_kept_here: usize,
    not_kept_there: usize,
}

fn preview_from(plan: Plan, big: Vec<String>, first: bool, local: &Manifest, remote: &Manifest, counts: Counts) -> Preview {
    let summary = plan.summary();
    Preview {
        plan,
        summary,
        first,
        skipped_here: counts.skipped_here,
        skipped_there: counts.skipped_there,
        not_kept_here: counts.not_kept_here,
        not_kept_there: counts.not_kept_there,
        too_big: big,
        files_here: local.files.len(),
        files_there: remote.files.len(),
        folders: Vec::new(),
    }
}

/// What a sync would do. Changes nothing, here or there.
pub fn compare<S: Read + Write>(channel: &mut Channel<S>, pair: &Pair) -> Result<Preview> {
    let (preview, _, _) = make_preview(channel, pair)?;
    send_blob(channel, KIND_BYE, &[], &[])?;
    Ok(preview)
}

fn make_preview<S: Read + Write>(channel: &mut Channel<S>, pair: &Pair) -> Result<(Preview, Manifest, Manifest)> {
    let here = match pair.map {
        Some(map) => share_listing(pair.root, map)?,
        None => listing_for(pair.root, pair.shares)?,
    };
    let there = fetch_listing(channel)?;
    let base = load_base(pair);
    let first = base.is_none();
    let empty = Manifest::default();
    let base = base.as_ref().unwrap_or(&empty);
    // What each side does not have by choice. Removed files the other side reports are left
    // alone as well: its own saved list may still have them, and they are not deleted.
    let all = || base.files.keys().chain(here.manifest.files.keys()).chain(there.manifest.files.keys());
    let out_here = keep::left_out(&here.rules, &here.manifest, base, all());
    let mut out_there = keep::left_out(&there.rules, &there.manifest, base, all());
    out_there.extend(there.not_kept.iter().filter(|p| !there.manifest.files.contains_key(*p)).cloned());
    let local_skipped: BTreeSet<String> = here.skipped.union(&out_here).cloned().collect();
    let remote_skipped: BTreeSet<String> = there.skipped.union(&out_there).cloned().collect();
    let plan = make_plan(&PlanInput {
        base,
        local: &here.manifest,
        remote: &there.manifest,
        local_skipped: &local_skipped,
        remote_skipped: &remote_skipped,
        device: pair.peer_name,
        date: pair.today,
    });
    let (plan, big) = finish_plan(plan, &here.manifest, &there.manifest, &local_skipped, &remote_skipped, pair);
    let counts = Counts { skipped_here: here.skipped.len(), skipped_there: there.skipped.len(), not_kept_here: out_here.len(), not_kept_there: out_there.len() };
    let mut preview = preview_from(plan, big, first, &here.manifest, &there.manifest, counts);
    if let (None, Some(mine), Some(theirs)) = (pair.map, &here.folders, &there.folders) {
        let known = foldersync::known(foldersync::load(pair.root, &tag(pair)), base);
        // A folder is not made on a device that keeps nothing in it (Available offline).
        preview.folders = foldersync::plan(&known, mine, theirs)
            .into_iter()
            .filter(|action| match action {
                FolderAction::MakeHere(path) => here.rules.keeps_folder(path),
                FolderAction::MakeThere(path) => there.rules.keeps_folder(path),
                _ => true,
            })
            .collect();
    }
    Ok((preview, here.manifest, there.manifest))
}

/// Brings files this device does not have from the other device, as they are there now: the
/// "open a page that is not on this device" step of 0.6.3 (keep.rs). Nothing is sent and nothing
/// here is changed or removed; a file that turned up here in the meantime is left as it is. For a
/// page (`.md`), its drawing and the attachments it links to come along. The files are then
/// ordinary files here: they sync like any other, and "Free up space" may remove them again if
/// the choices do not keep them. Returns the files that were brought.
pub fn fetch<S: Read + Write>(channel: &mut Channel<S>, root: &Path, paths: &[String]) -> Result<Vec<String>> {
    let there = fetch_listing(channel)?.manifest;
    let mut wanted: Vec<String> = Vec::new();
    for path in paths {
        wanted.push(path.clone());
        if let Some(stem) = path.strip_suffix(".md") {
            wanted.push(format!("{stem}.canvas.json"));
        }
    }
    let mut got = Vec::new();
    let mut index = 0;
    while index < wanted.len() && index < super::manifest::MAX_FILES {
        let path = wanted[index].clone();
        index += 1;
        if !super::manifest::safe_path(&path) || got.contains(&path) || files::current_hash(root, &path)?.is_some() {
            continue;
        }
        let Some(state) = there.files.get(&path) else { continue };
        if state.size > MAX_TRANSFER_BYTES {
            continue;
        }
        let Some(bytes) = get_there(channel, &path, &state.hash)? else { continue };
        if files::put(root, &path, Expect::Absent, &bytes, Some(state.modified))? != Done::Applied {
            continue;
        }
        // A page that came brings what it shows: its pictures and PDFs (and their words).
        if path.ends_with(".md") {
            for link in keep::attachment_links(&String::from_utf8_lossy(&bytes)) {
                wanted.push(format!("{link}{}", crate::attachments::PAGE_TEXT_SUFFIX));
                wanted.push(link);
            }
        }
        got.push(path);
    }
    send_blob(channel, KIND_BYE, &[], &[])?;
    Ok(got)
}

/// Does the sync. On a first sync with this device nothing is changed unless `approved`.
pub fn run<S: Read + Write>(channel: &mut Channel<S>, pair: &Pair, approved: bool, progress: &mut dyn FnMut(Progress)) -> Result<Outcome> {
    let (preview, local, remote) = make_preview(channel, pair)?;
    if preview.first && !approved {
        send_blob(channel, KIND_BYE, &[], &[])?;
        return Ok(Outcome::NeedsApproval(preview));
    }
    let total = preview.plan.actions.len();
    let mut report = Report { too_big: preview.too_big.clone(), clashes: preview.plan.clashes.clone(), ..Report::default() };
    for (index, action) in preview.plan.actions.iter().enumerate() {
        progress(Progress { done: index, total, path: action.path().to_string() });
        perform(channel, pair, action, &local, &remote, &mut report)?;
    }
    // After the files, so a folder that was emptied by this sync can be removed.
    for action in &preview.folders {
        perform_folder(channel, pair, action, &mut report)?;
    }
    progress(Progress { done: total, total, path: String::new() });
    finish(channel, pair)?;
    Ok(Outcome::Done(report))
}

/// After the actions: list both sides again and save what is now the same on both.
fn finish<S: Read + Write>(channel: &mut Channel<S>, pair: &Pair) -> Result<()> {
    let scan = Manifest::scan(pair.root)?;
    let folders_here = scan.folders;
    let scanned = scan.manifest;
    let mut local = match pair.map {
        Some(map) => map.view(&scanned),
        None => scanned,
    };
    if !pair.shares {
        local.files.remove(SHARES_FILE);
    }
    let there = fetch_listing(channel)?;
    let remote = there.manifest;
    // The folders both now have, for the next folder plan (foldersync.rs).
    let folders_both: Option<BTreeSet<String>> = match (pair.map, &there.folders) {
        (None, Some(folders_there)) => Some(folders_here.intersection(folders_there).cloned().collect()),
        _ => None,
    };
    if let Some(both) = &folders_both {
        foldersync::save(pair.root, &tag(pair), both)?;
    }
    let mut same = Manifest::default();
    for (path, state) in &local.files {
        if remote.files.get(path).is_some_and(|other| other.same_content(state)) {
            same.files.insert(path.clone(), state.clone());
        }
    }
    let before = load_base(pair);
    save_base(pair, &same)?;
    // The pages both now have alike, for joining edits next time (basetext.rs).
    super::basetext::update_mapped(pair.root, &tag(pair), before.as_ref(), &same, &|path| place(pair, path).ok())?;
    if pair.map.is_some() {
        // The other person's device keeps the same list (see `keep_share_base`). A share has no
        // colours, choices or page list of its own.
        ask(channel, KIND_BASE, &[], same.to_text().as_bytes(), 0)?;
        return send_blob(channel, KIND_BYE, &[], &[]);
    }
    // The colours and shares files both devices now have, for the next merge.
    for path in [SETTINGS_FILE, SHARES_FILE] {
        if same.files.contains_key(path) {
            if let Some(text) = read_small(&pair.root.join(path)) {
                write_atomic(&merge_base_path(pair.root, pair.peer_key, path), &text)?;
            }
        }
    }
    // Files that came back are taken off the "removed to free space" list.
    keep::still_removed(pair.root, &local);
    // What the other device has, kept for the page list and the rename check (keep.rs).
    write_atomic(&tree_path(pair.root, pair.peer_key), remote.to_text().as_bytes())?;
    if pair.base {
        // The other device keeps the same list (see `keep_own_base`), so the next sync it starts
        // itself starts from what both had now, not from an older list or none.
        let listing = Listing { manifest: same, folders: folders_both, ..Listing::default() };
        ask(channel, KIND_BASE, &[], &encode_listing_full(&listing), 0)?;
    }
    send_blob(channel, KIND_BYE, &[], &[])
}

/// The answering side of a sync between one's own devices (0.6.9) keeps the list the calling
/// device says both now have alike, as the calling side does in `finish`: the files (only those
/// that are exactly so here, as for a share), the page texts for joining edits, the folders both
/// have (only those that are here) and the colours and shares files both have, for the next merge.
pub fn keep_own_base(root: &Path, peer_key: &[u8; KEY_LEN], shares: bool, said: &Listing) -> Result<()> {
    let pair = Pair { root, peer_key, own_name: "", peer_name: "", today: "", shares, base: true, map: None };
    let scan = Manifest::scan(root)?;
    let mut same = Manifest::default();
    for (path, state) in &said.manifest.files {
        if (shares || path != SHARES_FILE) && scan.manifest.files.get(path).is_some_and(|mine| mine.same_content(state)) {
            same.files.insert(path.clone(), state.clone());
        }
    }
    if let Some(folders) = &said.folders {
        let both = folders.intersection(&scan.folders).cloned().collect();
        foldersync::save(root, &tag(&pair), &both)?;
    }
    let before = load_base(&pair);
    save_base(&pair, &same)?;
    super::basetext::update_mapped(root, &tag(&pair), before.as_ref(), &same, &|path| Some(path.to_string()))?;
    for path in [SETTINGS_FILE, SHARES_FILE] {
        if same.files.contains_key(path) {
            if let Some(text) = read_small(&root.join(path)) {
                write_atomic(&merge_base_path(root, peer_key, path), &text)?;
            }
        }
    }
    Ok(())
}

fn state<'a>(manifest: &'a Manifest, path: &str) -> Result<&'a FileState> {
    manifest.files.get(path).ok_or(SyncError::Damaged("a file in the plan is not in the list"))
}

/// What a request's answer means for the count: applied, or changed meanwhile (left for later).
fn count(report: &mut Report, kind: u8, apply: impl FnOnce(&mut Report)) -> Result<()> {
    match kind {
        KIND_OK => apply(report),
        KIND_CHANGED => report.left_for_next += 1,
        // The other device refused this one file (for example a name it cannot hold): it is
        // reported as left, the rest of the sync goes on.
        KIND_NO => report.left_for_next += 1,
        _ => return Err(SyncError::Damaged("answer to a change")),
    }
    Ok(())
}

fn put_there<S: Read + Write>(channel: &mut Channel<S>, path: &str, expect: Expect, bytes: &[u8]) -> Result<u8> {
    let meta = format!("{}\n{}\n{path}", expect.to_wire(), super::manifest::hash_bytes(bytes));
    let answer = ask(channel, KIND_PUT, meta.as_bytes(), bytes, 0);
    match answer {
        Ok(blob) => Ok(blob.kind),
        // A "no" to one file is not the end of the sync.
        Err(SyncError::Refused("the other device said no")) => Ok(KIND_NO),
        Err(other) => Err(other),
    }
}

fn get_there<S: Read + Write>(channel: &mut Channel<S>, path: &str, hash: &str) -> Result<Option<Vec<u8>>> {
    let answer = ask(channel, KIND_GET, path.as_bytes(), &[], MAX_TRANSFER_BYTES + 1024)?;
    match answer.kind {
        KIND_MISSING => Ok(None),
        // What came must be what the list promised; anything else was changed meanwhile.
        KIND_FILE if answer.meta == hash.as_bytes() && super::manifest::hash_bytes(&answer.body) == hash => Ok(Some(answer.body)),
        KIND_FILE => Ok(None),
        _ => Err(SyncError::Damaged("answer to a file request")),
    }
}

fn perform<S: Read + Write>(channel: &mut Channel<S>, pair: &Pair, action: &Action, local: &Manifest, remote: &Manifest, report: &mut Report) -> Result<()> {
    match action {
        // The colours and shares files on both sides are merged entry by entry, not copied whole.
        Action::Push { path } | Action::Pull { path } if merged_file(path) && local.files.contains_key(path) && remote.files.contains_key(path) => {
            merge_settings(channel, pair, path, matches!(action, Action::Push { .. }), local, remote, report)
        }
        Action::Push { path } => {
            let mine = state(local, path)?;
            let expect = remote.files.get(path).map_or(Expect::Absent, |s| Expect::Hash(&s.hash));
            let Some(bytes) = files::read_expected(pair.root, &place(pair, path)?, &mine.hash)? else {
                report.left_for_next += 1;
                return Ok(());
            };
            let kind = put_there(channel, path, expect, &bytes)?;
            count(report, kind, |r| r.sent += 1)
        }
        Action::Pull { path } => {
            let theirs = state(remote, path)?;
            let expect = local.files.get(path).map_or(Expect::Absent, |s| Expect::Hash(&s.hash));
            let Some(bytes) = get_there(channel, path, &theirs.hash)? else {
                report.left_for_next += 1;
                return Ok(());
            };
            match files::put(pair.root, &place(pair, path)?, expect, &bytes, Some(theirs.modified))? {
                Done::Applied => report.received += 1,
                Done::Changed => report.left_for_next += 1,
            }
            Ok(())
        }
        Action::DeleteLocal { path } => {
            let mine = state(local, path)?;
            match files::remove(pair.root, &place(pair, path)?, &mine.hash)? {
                Done::Applied => report.deleted_here += 1,
                Done::Changed => report.left_for_next += 1,
            }
            Ok(())
        }
        Action::DeleteRemote { path } => {
            let theirs = state(remote, path)?;
            let meta = format!("{}\n{path}", theirs.hash);
            let answer = ask(channel, KIND_DEL, meta.as_bytes(), &[], 0)?;
            count(report, answer.kind, |r| r.deleted_there += 1)
        }
        Action::Conflict { path, copy, winner } => conflict(channel, pair, path, copy, *winner, local, remote, report),
    }
}

/// Makes or removes one folder (foldersync.rs). A folder that is not empty is never removed;
/// that, and a refusal from the other device, only means it is looked at again next time.
fn perform_folder<S: Read + Write>(channel: &mut Channel<S>, pair: &Pair, action: &FolderAction, report: &mut Report) -> Result<()> {
    let applied = match action {
        // A folder that cannot be made or removed here (no permission, a file in the way) is no
        // reason to stop the sync; it is tried again next time.
        FolderAction::MakeHere(path) => Ok(matches!(files::make_folder(pair.root, path), Ok(Done::Applied))),
        FolderAction::RemoveHere(path) => Ok(matches!(files::remove_empty_folder(pair.root, path), Ok(Done::Applied))),
        FolderAction::MakeThere(path) => ask(channel, KIND_FOLDER, format!("make\n{path}").as_bytes(), &[], 0).map(|a| a.kind == KIND_OK),
        FolderAction::RemoveThere(path) => ask(channel, KIND_FOLDER, format!("remove\n{path}").as_bytes(), &[], 0).map(|a| a.kind == KIND_OK),
    };
    match applied {
        Ok(true) => report.folders += 1,
        Ok(false) | Err(SyncError::Refused(_)) => {}
        Err(other) => return Err(other),
    }
    Ok(())
}

/// The two texts joined against the text both devices had after their last sync, or `None`.
fn join_texts(pair: &Pair, path: &str, mine: &[u8], theirs: &[u8]) -> Option<Vec<u8>> {
    let base = super::basetext::read(pair.root, &tag(pair), path)?;
    let (mine, theirs) = (std::str::from_utf8(mine).ok()?, std::str::from_utf8(theirs).ok()?);
    crate::textmerge::merge(&base, mine, theirs).map(String::into_bytes)
}

/// Merges the two folder colours files (settings_merge.rs) or lists of shares (shares.rs), and
/// writes the result here and there. A file that cannot be merged falls back to the old rule:
/// the newer one wins whole.
#[allow(clippy::too_many_arguments)]
fn merge_settings<S: Read + Write>(channel: &mut Channel<S>, pair: &Pair, path: &str, local_wins: bool, local: &Manifest, remote: &Manifest, report: &mut Report) -> Result<()> {
    let (mine, theirs) = (state(local, path)?, state(remote, path)?);
    let Some(here) = files::read_expected(pair.root, &place(pair, path)?, &mine.hash)? else {
        report.left_for_next += 1;
        return Ok(());
    };
    let Some(there) = get_there(channel, path, &theirs.hash)? else {
        report.left_for_next += 1;
        return Ok(());
    };
    let base = read_small(&merge_base_path(pair.root, pair.peer_key, path));
    let merge = if path == SHARES_FILE { super::shares::merge } else { super::settings_merge::merge };
    let merged = merge(base.as_deref(), &here, &there, local_wins).unwrap_or_else(|| if local_wins { here.clone() } else { there.clone() });
    if merged != here {
        match files::put(pair.root, &place(pair, path)?, Expect::Hash(&mine.hash), &merged, None)? {
            Done::Applied => report.received += 1,
            Done::Changed => {
                report.left_for_next += 1;
                return Ok(());
            }
        }
    }
    if merged != there {
        let kind = put_there(channel, path, Expect::Hash(&theirs.hash), &merged)?;
        count(report, kind, |r| r.sent += 1)?;
    }
    Ok(())
}

/// A small file kept by the sync, or `None` when it is missing or too big to be one.
fn read_small(path: &Path) -> Option<Vec<u8>> {
    let meta = fs::symlink_metadata(path).ok()?;
    (meta.is_file() && meta.len() <= 4 * 1024 * 1024).then(|| fs::read(path).ok()).flatten()
}

/// Both sides changed the file. The older version is saved as `copy` here first (so it exists
/// before anything on the other device changes), then both devices end up with the same two
/// files: the newer version at `path` and the older one at `copy`.
#[allow(clippy::too_many_arguments)]
fn conflict<S: Read + Write>(channel: &mut Channel<S>, pair: &Pair, path: &str, copy: &str, winner: Side, local: &Manifest, remote: &Manifest, report: &mut Report) -> Result<()> {
    let (mine, theirs) = (state(local, path)?, state(remote, path)?);
    let Some(mine_bytes) = files::read_expected(pair.root, &place(pair, path)?, &mine.hash)? else {
        report.left_for_next += 1;
        return Ok(());
    };
    let Some(their_bytes) = get_there(channel, path, &theirs.hash)? else {
        report.left_for_next += 1;
        return Ok(());
    };
    // A page changed on both sides is joined word by word when the text both had last is known
    // and the two changes do not touch the same place (basetext.rs, textmerge.rs).
    if path.ends_with(".md") {
        if let Some(merged) = join_texts(pair, path, &mine_bytes, &their_bytes) {
            if merged != mine_bytes && files::put(pair.root, &place(pair, path)?, Expect::Hash(&mine.hash), &merged, None)? == Done::Changed {
                report.left_for_next += 1;
                return Ok(());
            }
            if merged != their_bytes {
                let kind = put_there(channel, path, Expect::Hash(&theirs.hash), &merged)?;
                if kind != KIND_OK {
                    report.left_for_next += 1;
                    return Ok(());
                }
            }
            report.merged += 1;
            return Ok(());
        }
    }
    let (keep, older, older_modified) = match winner {
        Side::Local => (&mine_bytes, &their_bytes, theirs.modified),
        Side::Remote => (&their_bytes, &mine_bytes, mine.modified),
    };
    // 1. The older version is safe here, under its own name.
    if files::put(pair.root, &place(pair, copy)?, Expect::Absent, older, Some(older_modified))? == Done::Changed {
        report.left_for_next += 1;
        return Ok(());
    }
    // 2. The newer version takes the name here (when it is the other device's).
    if winner == Side::Remote && files::put(pair.root, &place(pair, path)?, Expect::Hash(&mine.hash), keep, Some(theirs.modified))? == Done::Changed {
        report.left_for_next += 1;
        return Ok(());
    }
    // 3. The other device gets the copy and the newer version.
    let copy_answer = put_there(channel, copy, Expect::Absent, older)?;
    if copy_answer != KIND_OK && copy_answer != KIND_CHANGED {
        report.left_for_next += 1;
        return Ok(());
    }
    if winner == Side::Local {
        let kind = put_there(channel, path, Expect::Hash(&theirs.hash), keep)?;
        if kind != KIND_OK {
            report.left_for_next += 1;
            return Ok(());
        }
    }
    report.conflicts += 1;
    report.conflict_copies.push(place(pair, copy)?);
    Ok(())
}
