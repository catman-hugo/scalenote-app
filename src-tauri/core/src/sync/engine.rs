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

use super::channel::Channel;
use super::exchange::*;
use super::files::{self, Done, Expect, MAX_TRANSFER_BYTES};
use super::identity::KEY_LEN;
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
    /// Files bigger than one transfer takes; reported and not moved.
    pub too_big: Vec<String>,
    /// File names for the preview (the actions, with sizes), capped for display.
    pub files_here: usize,
    pub files_there: usize,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Report {
    pub sent: usize,
    pub received: usize,
    pub deleted_here: usize,
    pub deleted_there: usize,
    pub conflicts: usize,
    /// The names of the conflict copies made, so the interface can offer to review them.
    pub conflict_copies: Vec<String>,
    /// Files that changed while the sync ran and were left for the next one.
    pub left_for_next: usize,
    pub too_big: Vec<String>,
    pub clashes: Vec<String>,
}

impl Report {
    /// How many files were changed on either side (the "3 changed" of the status line).
    pub fn changed(&self) -> usize {
        self.sent + self.received + self.deleted_here + self.deleted_there + self.conflicts
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
    pair.root.join(BASE_DIR).join(format!("sync-base-{}.txt", &hex::encode(pair.peer_key)[..16]))
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
        return Err(SyncError::Refused("the other device said no"));
    }
    Ok(answer)
}

fn fetch_listing<S: Read + Write>(channel: &mut Channel<S>) -> Result<(Manifest, BTreeSet<String>)> {
    let answer = ask(channel, KIND_LIST, &[], &[], MAX_LISTING_BYTES)?;
    if answer.kind != KIND_LISTING {
        return Err(SyncError::Damaged("answer to the list request"));
    }
    decode_listing(&answer.body)
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
            // Deleting the settings file would leave folders without their colours; skipped.
            Action::DeleteLocal { .. } | Action::DeleteRemote { .. } if path == SETTINGS_FILE => {}
            Action::Conflict { winner, .. } if path == SETTINGS_FILE => {
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

fn preview_from(plan: Plan, big: Vec<String>, first: bool, local: &Manifest, remote: &Manifest, skipped_here: usize, skipped_there: usize) -> Preview {
    let summary = plan.summary();
    Preview { plan, summary, first, skipped_here, skipped_there, too_big: big, files_here: local.files.len(), files_there: remote.files.len() }
}

/// What a sync would do. Changes nothing, here or there.
pub fn compare<S: Read + Write>(channel: &mut Channel<S>, pair: &Pair) -> Result<Preview> {
    let (preview, _, _) = make_preview(channel, pair)?;
    send_blob(channel, KIND_BYE, &[], &[])?;
    Ok(preview)
}

fn make_preview<S: Read + Write>(channel: &mut Channel<S>, pair: &Pair) -> Result<(Preview, Manifest, Manifest)> {
    let scan = Manifest::scan(pair.root)?;
    let local_skipped: BTreeSet<String> = scan.skipped.iter().map(|s| s.path.clone()).collect();
    let (remote, remote_skipped) = fetch_listing(channel)?;
    let base = load_base(pair);
    let first = base.is_none();
    let empty = Manifest::default();
    let plan = make_plan(&PlanInput {
        base: base.as_ref().unwrap_or(&empty),
        local: &scan.manifest,
        remote: &remote,
        local_skipped: &local_skipped,
        remote_skipped: &remote_skipped,
        device: pair.peer_name,
        date: pair.today,
    });
    let (plan, big) = finish_plan(plan, &scan.manifest, &remote, &local_skipped, &remote_skipped, pair);
    let preview = preview_from(plan, big, first, &scan.manifest, &remote, local_skipped.len(), remote_skipped.len());
    Ok((preview, scan.manifest, remote))
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
    progress(Progress { done: total, total, path: String::new() });
    finish(channel, pair)?;
    Ok(Outcome::Done(report))
}

/// After the actions: list both sides again and save what is now the same on both.
fn finish<S: Read + Write>(channel: &mut Channel<S>, pair: &Pair) -> Result<()> {
    let local = Manifest::scan(pair.root)?.manifest;
    let (remote, _) = fetch_listing(channel)?;
    let mut same = Manifest::default();
    for (path, state) in &local.files {
        if remote.files.get(path).is_some_and(|other| other.same_content(state)) {
            same.files.insert(path.clone(), state.clone());
        }
    }
    save_base(pair, &same)?;
    send_blob(channel, KIND_BYE, &[], &[])
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
        Action::Push { path } => {
            let mine = state(local, path)?;
            let expect = remote.files.get(path).map_or(Expect::Absent, |s| Expect::Hash(&s.hash));
            let Some(bytes) = files::read_expected(pair.root, path, &mine.hash)? else {
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
            match files::put(pair.root, path, expect, &bytes, Some(theirs.modified))? {
                Done::Applied => report.received += 1,
                Done::Changed => report.left_for_next += 1,
            }
            Ok(())
        }
        Action::DeleteLocal { path } => {
            let mine = state(local, path)?;
            match files::remove(pair.root, path, &mine.hash)? {
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

/// Both sides changed the file. The older version is saved as `copy` here first (so it exists
/// before anything on the other device changes), then both devices end up with the same two
/// files: the newer version at `path` and the older one at `copy`.
#[allow(clippy::too_many_arguments)]
fn conflict<S: Read + Write>(channel: &mut Channel<S>, pair: &Pair, path: &str, copy: &str, winner: Side, local: &Manifest, remote: &Manifest, report: &mut Report) -> Result<()> {
    let (mine, theirs) = (state(local, path)?, state(remote, path)?);
    let Some(mine_bytes) = files::read_expected(pair.root, path, &mine.hash)? else {
        report.left_for_next += 1;
        return Ok(());
    };
    let Some(their_bytes) = get_there(channel, path, &theirs.hash)? else {
        report.left_for_next += 1;
        return Ok(());
    };
    let (keep, older, older_modified) = match winner {
        Side::Local => (&mine_bytes, &their_bytes, theirs.modified),
        Side::Remote => (&their_bytes, &mine_bytes, mine.modified),
    };
    // 1. The older version is safe here, under its own name.
    if files::put(pair.root, copy, Expect::Absent, older, Some(older_modified))? == Done::Changed {
        report.left_for_next += 1;
        return Ok(());
    }
    // 2. The newer version takes the name here (when it is the other device's).
    if winner == Side::Remote && files::put(pair.root, path, Expect::Hash(&mine.hash), keep, Some(theirs.modified))? == Done::Changed {
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
    report.conflict_copies.push(copy.to_string());
    Ok(())
}
