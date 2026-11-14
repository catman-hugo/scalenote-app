//! Works out what a sync has to do, without touching any file.
//!
//! Three lists are compared: what this device has now (`local`), what the other side has now
//! (`remote`), and what both sides had the last time they were the same (`base`; empty the very
//! first time). Because the base is known, a file that is missing on one side can be told apart:
//! either it is new on the other side (copy it) or it was deleted here (delete it there too).
//!
//! The rules, in the order that matters for not losing anything:
//! - A change on one side only goes to the other side.
//! - A file changed on both sides is a conflict: the newer version keeps the name, the older one
//!   is kept next to it under a "conflict" name on both sides. Nothing is merged and nothing is
//!   thrown away.
//! - A file deleted on one side and edited on the other is kept (the edit wins over the delete).
//! - A deleted file that was not edited is deleted on the other side too, but that always means
//!   "move to the trash" (the caller does that), never a hard delete.
//! - The first sync has no base, so nothing is ever deleted: files only on one side are copied.
//! - A file that was left out of a list on purpose (too big, a link, unreadable) is not in the
//!   plan at all, so it can never be mistaken for a deleted file.
//! - Two names that differ only by upper/lower case cannot both live on Windows. If an action
//!   would create one next to the other, it is not planned and the name is reported instead.

use super::manifest::{safe_path, FileState, Manifest, MAX_NAME_BYTES};
use std::collections::{BTreeMap, BTreeSet};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Side {
    Local,
    Remote,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Action {
    /// Copy the local file to the remote side (new or changed here).
    Push { path: String },
    /// Copy the remote file here (new or changed there).
    Pull { path: String },
    /// Deleted on the remote side: move the local file to the trash.
    DeleteLocal { path: String },
    /// Deleted here: move the remote file to the trash.
    DeleteRemote { path: String },
    /// Changed on both sides. The `winner`'s version stays at `path`; the other side's version
    /// is saved as `copy` on both sides.
    Conflict { path: String, copy: String, winner: Side },
}

impl Action {
    pub fn path(&self) -> &str {
        match self {
            Action::Push { path } | Action::Pull { path } | Action::DeleteLocal { path } | Action::DeleteRemote { path } | Action::Conflict { path, .. } => path,
        }
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Plan {
    pub actions: Vec<Action>,
    /// Names that could not be handled because another name differs only in upper/lower case.
    pub clashes: Vec<String>,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct PlanSummary {
    pub push: usize,
    pub pull: usize,
    pub delete_local: usize,
    pub delete_remote: usize,
    pub conflicts: usize,
    pub clashes: usize,
}

impl PlanSummary {
    /// Whether the sync has nothing to do and nothing to report.
    pub fn is_empty(&self) -> bool {
        self.push + self.pull + self.delete_local + self.delete_remote + self.conflicts + self.clashes == 0
    }
}

/// What the planner needs besides the three lists.
pub struct PlanInput<'a> {
    pub base: &'a Manifest,
    pub local: &'a Manifest,
    pub remote: &'a Manifest,
    /// Paths left out of the local / remote list on purpose. They are ignored completely.
    pub local_skipped: &'a BTreeSet<String>,
    pub remote_skipped: &'a BTreeSet<String>,
    /// Used in the name of a conflict copy; already made safe for a file name.
    pub device: &'a str,
    /// Used in the name of a conflict copy, for example `2026-11-14`.
    pub date: &'a str,
}

impl Plan {
    pub fn summary(&self) -> PlanSummary {
        let mut s = PlanSummary { clashes: self.clashes.len(), ..PlanSummary::default() };
        for action in &self.actions {
            match action {
                Action::Push { .. } => s.push += 1,
                Action::Pull { .. } => s.pull += 1,
                Action::DeleteLocal { .. } => s.delete_local += 1,
                Action::DeleteRemote { .. } => s.delete_remote += 1,
                Action::Conflict { .. } => s.conflicts += 1,
            }
        }
        s
    }
}

enum Verdict {
    Nothing,
    Push,
    Pull,
    DeleteLocal,
    DeleteRemote,
    Conflict,
}

fn judge(base: Option<&FileState>, local: Option<&FileState>, remote: Option<&FileState>) -> Verdict {
    match (local, remote) {
        (None, None) => Verdict::Nothing,
        (Some(l), Some(r)) if l.same_content(r) => Verdict::Nothing,
        (Some(l), Some(r)) => match base {
            None => Verdict::Conflict,
            Some(b) => match (l.same_content(b), r.same_content(b)) {
                (false, true) => Verdict::Push,
                (true, false) => Verdict::Pull,
                _ => Verdict::Conflict,
            },
        },
        (Some(l), None) => match base {
            None => Verdict::Push,
            // Deleted there: delete here only when nobody edited the file since.
            Some(b) if l.same_content(b) => Verdict::DeleteLocal,
            Some(_) => Verdict::Push,
        },
        (None, Some(r)) => match base {
            None => Verdict::Pull,
            Some(b) if r.same_content(b) => Verdict::DeleteRemote,
            Some(_) => Verdict::Pull,
        },
    }
}

fn lowercase_names(manifest: &Manifest) -> BTreeMap<String, String> {
    manifest.files.keys().map(|p| (p.to_lowercase(), p.clone())).collect()
}

/// Whether making `path` on a side that already holds `names` would put it next to a name that
/// differs only by case.
fn clashes_with(names: &BTreeMap<String, String>, path: &str) -> bool {
    names.get(&path.to_lowercase()).is_some_and(|existing| existing != path)
}

pub fn make_plan(input: &PlanInput) -> Plan {
    let mut paths: BTreeSet<&String> = BTreeSet::new();
    paths.extend(input.base.files.keys());
    paths.extend(input.local.files.keys());
    paths.extend(input.remote.files.keys());

    let local_names = lowercase_names(input.local);
    let remote_names = lowercase_names(input.remote);
    // Every name in use anywhere (any case), so a conflict copy never lands on an existing name.
    let mut taken: BTreeSet<String> = paths.iter().map(|p| p.to_lowercase()).collect();
    taken.extend(input.local_skipped.iter().map(|p| p.to_lowercase()));
    taken.extend(input.remote_skipped.iter().map(|p| p.to_lowercase()));

    let mut plan = Plan::default();
    for path in paths {
        if input.local_skipped.contains(path) || input.remote_skipped.contains(path) {
            continue;
        }
        let verdict = judge(input.base.files.get(path), input.local.files.get(path), input.remote.files.get(path));
        let path = path.clone();
        match verdict {
            Verdict::Nothing => {}
            Verdict::Push if clashes_with(&remote_names, &path) => plan.clashes.push(path),
            Verdict::Pull if clashes_with(&local_names, &path) => plan.clashes.push(path),
            Verdict::Push => plan.actions.push(Action::Push { path }),
            Verdict::Pull => plan.actions.push(Action::Pull { path }),
            Verdict::DeleteLocal => plan.actions.push(Action::DeleteLocal { path }),
            Verdict::DeleteRemote => plan.actions.push(Action::DeleteRemote { path }),
            Verdict::Conflict => {
                let copy = conflict_name(&path, input.device, input.date, &taken);
                taken.insert(copy.to_lowercase());
                let winner = newer_side(input.local.files.get(&path), input.remote.files.get(&path));
                plan.actions.push(Action::Conflict { path, copy, winner });
            }
        }
    }
    plan
}

/// The side whose version is newer by time; a tie goes to the local side.
fn newer_side(local: Option<&FileState>, remote: Option<&FileState>) -> Side {
    match (local, remote) {
        (Some(l), Some(r)) if r.modified > l.modified => Side::Remote,
        _ => Side::Local,
    }
}

/// The name for the older version of a conflicted file: `Note (conflict alice 2026-11-14).md`.
/// It stays in the same folder, keeps the extension, and is never one of the `taken` names
/// (compared in lower case). A number is added when the name is already in use.
pub fn conflict_name(path: &str, device: &str, date: &str, taken: &BTreeSet<String>) -> String {
    let (folder, file) = match path.rfind('/') {
        Some(i) => (&path[..=i], &path[i + 1..]),
        None => ("", path),
    };
    // A dot at the very start is part of the name, not an extension.
    let (stem, extension) = match file.rfind('.') {
        Some(i) if i > 0 => (&file[..i], &file[i..]),
        _ => (file, ""),
    };
    let mut number = 1;
    loop {
        let label = if number == 1 { format!(" (conflict {device} {date})") } else { format!(" (conflict {device} {date} {number})") };
        let mut stem: String = stem.to_string();
        // Cut the original name, never the label, so the result still fits in a name.
        while stem.len() + label.len() + extension.len() > MAX_NAME_BYTES && !stem.is_empty() {
            stem.pop();
        }
        let candidate = format!("{folder}{stem}{label}{extension}");
        if safe_path(&candidate) && !taken.contains(&candidate.to_lowercase()) {
            return candidate;
        }
        number += 1;
        // A path that is too long for any name cannot get shorter by counting; stop trying.
        if number > 10_000 {
            return format!("{folder}conflict-{}{extension}", number);
        }
    }
}
