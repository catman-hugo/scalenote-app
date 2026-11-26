//! What two paired devices say to each other during a sync, and the answering side.
//!
//! The device that starts a sync (the caller) asks, the other one (the server) answers. Every
//! request is one "blob": a kind byte, a short note (a path, a hash), and a body that may be as
//! big as a file. A blob travels as one head message and then chunks, because one encrypted
//! message holds at most 60,000 bytes. Everything received is untrusted: the size of a body is
//! limited before anything is stored, a path must be a safe path, and nothing is run.
//!
//! Requests: `LIST` (send me your list of files), `GET path`, `PUT path` (with the file),
//! `DEL path`, `BYE`. A `PUT` and a `DEL` say which content they expect to find; if the file is
//! different by now the answer is `CHANGED` and nothing is touched, so a note the person typed
//! a moment ago can never be overwritten by a sync that planned on an older list.

use super::channel::{Channel, MAX_MESSAGE};
use super::files::{self, Done, Expect, MAX_TRANSFER_BYTES};
use super::space::ShareMap;
use super::keep::{self, KeepRules, Kinds, MAX_RULES};
use super::manifest::{hash_bytes, safe_path, Manifest, MAX_MANIFEST_BYTES};
use super::{Result, SyncError};
use std::collections::BTreeSet;
use std::io::{Read, Write};
use std::path::Path;

pub const KIND_LIST: u8 = 0x30;
pub const KIND_GET: u8 = 0x31;
pub const KIND_PUT: u8 = 0x32;
pub const KIND_DEL: u8 = 0x33;
pub const KIND_BYE: u8 = 0x34;
/// Share syncs only (0.6.4): the calling device's list of what both now have alike, sent just
/// before the goodbye, so the answering device can join edits and see deletions next time it
/// starts the sync itself. Never sent to apps before 0.6.4 (they are never in a share).
pub const KIND_BASE: u8 = 0x35;
/// Whole-folder syncs only (0.6.7): make a folder, or remove it when it is empty
/// (foldersync.rs). The note is `make\npath` or `remove\npath`. Only sent to a device whose
/// listing has a folder list, so never to older apps.
pub const KIND_FOLDER: u8 = 0x36;

pub const KIND_OK: u8 = 0x40;
pub const KIND_LISTING: u8 = 0x41;
pub const KIND_FILE: u8 = 0x42;
pub const KIND_MISSING: u8 = 0x43;
pub const KIND_CHANGED: u8 = 0x44;
pub const KIND_NO: u8 = 0x45;
/// The reason sent with a "no" when the asking device is tied to another folder on this one
/// (see folders.rs). Older apps send a "no" without a reason; both mean the sync did not happen.
pub const NO_OTHER_FOLDER: &[u8] = b"other-folder";

const KIND_CHUNK: u8 = 0x50;
/// A note (path and hashes) is never longer than this.
const MAX_META: usize = 1200;
/// How many requests one connection may make. A sync of a very big vault needs many; a loop
/// that never ends is cut off.
const MAX_REQUESTS: usize = 2_000_000;

/// The kinds that start a sync request (what `handle_connection` hands to `serve`).
pub fn is_sync_kind(kind: u8) -> bool {
    matches!(kind, KIND_LIST | KIND_GET | KIND_PUT | KIND_DEL | KIND_BYE)
}

pub struct Blob {
    pub kind: u8,
    pub meta: Vec<u8>,
    pub body: Vec<u8>,
}

/// Sends one blob: a head message, then the body in chunks.
pub fn send_blob<S: Read + Write>(channel: &mut Channel<S>, kind: u8, meta: &[u8], body: &[u8]) -> Result<()> {
    if meta.len() > MAX_META {
        return Err(SyncError::Channel("note too long"));
    }
    let mut head = vec![kind];
    head.extend_from_slice(&(meta.len() as u16).to_be_bytes());
    head.extend_from_slice(meta);
    head.extend_from_slice(&(body.len() as u64).to_be_bytes());
    channel.send(&head)?;
    for chunk in body.chunks(MAX_MESSAGE - 1) {
        let mut message = Vec::with_capacity(chunk.len() + 1);
        message.push(KIND_CHUNK);
        message.extend_from_slice(chunk);
        channel.send(&message)?;
    }
    Ok(())
}

/// Reads the rest of a blob whose head message is `head`. A body bigger than `max_body` ends
/// the connection before it is read.
pub fn recv_blob_from<S: Read + Write>(channel: &mut Channel<S>, head: &[u8], max_body: u64) -> Result<Blob> {
    let kind = *head.first().ok_or(SyncError::Channel("empty message"))?;
    let meta_length = u16::from_be_bytes(head.get(1..3).and_then(|b| b.try_into().ok()).ok_or(SyncError::Channel("short head"))?) as usize;
    if meta_length > MAX_META || head.len() != 3 + meta_length + 8 {
        return Err(SyncError::Channel("bad head"));
    }
    let meta = head[3..3 + meta_length].to_vec();
    let body_length = u64::from_be_bytes(head[3 + meta_length..].try_into().map_err(|_| SyncError::Channel("bad head"))?);
    if body_length > max_body {
        return Err(SyncError::Channel("body too big"));
    }
    // Do not trust the announced size for the first allocation.
    let mut body = Vec::with_capacity(body_length.min(1 << 20) as usize);
    while (body.len() as u64) < body_length {
        let chunk = channel.recv()?;
        if chunk.first() != Some(&KIND_CHUNK) || chunk.len() < 2 || body.len() as u64 + (chunk.len() as u64 - 1) > body_length {
            return Err(SyncError::Channel("bad chunk"));
        }
        body.extend_from_slice(&chunk[1..]);
    }
    Ok(Blob { kind, meta, body })
}

pub fn recv_blob<S: Read + Write>(channel: &mut Channel<S>, max_body: u64) -> Result<Blob> {
    let head = channel.recv()?;
    recv_blob_from(channel, &head, max_body)
}

/// The listing: the list of files as text, then the names that were left out.
/// Body layout: `<manifest length as 8 digits>` `<manifest text>` `<one skipped path per line>`.
///
/// Since 0.6 a device that keeps only part of the vault adds, after the skipped names:
/// - the line `/not-kept`, then the files it removed to free space (one per line), and
/// - its choices as `/keep <kinds> <path>` lines and `/linked <path>` lines (keep.rs).
///
/// Lines starting with `/` are never safe paths, so an app older than 0.6 drops them, and reads
/// the removed files after `/not-kept` as ordinary skipped names: it leaves them alone instead
/// of taking them for deleted files. That is what keeps an older device safe.
pub fn encode_listing(manifest: &Manifest, skipped: &[String]) -> Vec<u8> {
    encode_listing_full(&Listing { manifest: manifest.clone(), skipped: skipped.iter().cloned().collect(), ..Listing::default() })
}

/// Everything a device says about its files in answer to `LIST`.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Listing {
    pub manifest: Manifest,
    /// Left out for a reason (too big, a link, an odd name).
    pub skipped: BTreeSet<String>,
    /// Removed to free space, and not here again yet.
    pub not_kept: BTreeSet<String>,
    /// What the device keeps. Empty choices (also from apps before 0.6) mean "everything".
    pub rules: KeepRules,
    /// Every visible folder (0.6.7, foldersync.rs). `None` when the device did not say: an older
    /// app, or a share sync. Then folders are left alone; an empty list is not "no folders".
    pub folders: Option<BTreeSet<String>>,
}

pub fn encode_listing_full(listing: &Listing) -> Vec<u8> {
    let text = listing.manifest.to_text();
    let mut body = format!("{:08}", text.len()).into_bytes();
    body.extend_from_slice(text.as_bytes());
    let mut line = |text: &str| {
        body.extend_from_slice(text.as_bytes());
        body.push(b'\n');
    };
    for path in &listing.skipped {
        line(path);
    }
    if !listing.not_kept.is_empty() {
        line("/not-kept");
        for path in &listing.not_kept {
            line(path);
        }
    }
    for (path, kinds) in &listing.rules.choices {
        line(&format!("/keep {} {path}", kinds.to_letters()));
    }
    for path in &listing.rules.linked {
        line(&format!("/linked {path}"));
    }
    // Older apps skip lines starting with `/` that they do not know, so this costs them nothing.
    if let Some(folders) = &listing.folders {
        line("/folders");
        for path in folders {
            line(&format!("/folder {path}"));
        }
    }
    body
}

pub fn decode_listing(body: &[u8]) -> Result<(Manifest, BTreeSet<String>)> {
    let listing = decode_listing_full(body)?;
    let mut skipped = listing.skipped;
    skipped.extend(listing.not_kept);
    Ok((listing.manifest, skipped))
}

/// Reads a listing. The choices of the other device are checked like everything else from a
/// network: a damaged choice line ends the sync, because guessing what a device keeps could make
/// this side delete files there.
pub fn decode_listing_full(body: &[u8]) -> Result<Listing> {
    let digits = body.get(..8).and_then(|d| std::str::from_utf8(d).ok()).ok_or(SyncError::Damaged("listing"))?;
    let length: usize = digits.parse().map_err(|_| SyncError::Damaged("listing"))?;
    let end = 8usize.checked_add(length).filter(|e| *e <= body.len()).ok_or(SyncError::Damaged("listing"))?;
    let manifest = Manifest::from_text(std::str::from_utf8(&body[8..end]).map_err(|_| SyncError::Damaged("listing"))?)?;
    let rest = std::str::from_utf8(&body[end..]).map_err(|_| SyncError::Damaged("listing"))?;
    let mut listing = Listing { manifest, ..Listing::default() };
    let mut in_not_kept = false;
    let mut count = 0usize;
    for line in rest.lines() {
        count += 1;
        if count > 2 * super::manifest::MAX_FILES + MAX_RULES {
            return Err(SyncError::Damaged("listing too long"));
        }
        if line == "/not-kept" {
            in_not_kept = true;
        } else if let Some(choice) = line.strip_prefix("/keep ") {
            let (letters, path) = choice.split_once(' ').ok_or(SyncError::Damaged("listing choice"))?;
            let kinds = Kinds::from_letters(letters).ok_or(SyncError::Damaged("listing choice"))?;
            listing.rules.set(path, Some(kinds)).map_err(|_| SyncError::Damaged("listing choice"))?;
        } else if let Some(path) = line.strip_prefix("/linked ") {
            if !safe_path(path) || listing.rules.linked.len() >= super::manifest::MAX_FILES {
                return Err(SyncError::Damaged("listing choice"));
            }
            listing.rules.linked.insert(path.to_string());
        } else if line == "/folders" {
            listing.folders.get_or_insert_with(BTreeSet::new);
        } else if let Some(path) = line.strip_prefix("/folder ") {
            let folders = listing.folders.get_or_insert_with(BTreeSet::new);
            if !safe_path(path) || folders.len() >= super::foldersync::MAX_FOLDERS {
                return Err(SyncError::Damaged("listing folder"));
            }
            folders.insert(path.to_string());
        } else if line.starts_with('/') {
            // A kind of line from a newer app: not understood, so left alone.
        } else if safe_path(line) {
            // Names that are not safe paths could never be planned anyway; they are dropped.
            if in_not_kept {
                listing.not_kept.insert(line.to_string());
            } else {
                listing.skipped.insert(line.to_string());
            }
        }
    }
    Ok(listing)
}

/// The listing of this device's vault: its files, and what it keeps (keep.rs).
pub fn own_listing(root: &Path) -> Result<Listing> {
    let scan = Manifest::scan(root)?;
    let skipped = scan.skipped.iter().map(|s| s.path.clone()).collect();
    let not_kept = keep::still_removed(root, &scan.manifest);
    let rules = KeepRules::load_with_links(root, &scan.manifest);
    Ok(Listing { manifest: scan.manifest, skipped, not_kept, rules, folders: Some(scan.folders) })
}

/// How many bytes a listing may have: the manifest limit plus room for the skipped names and,
/// since 0.6, the removed files and choices.
pub const MAX_LISTING_BYTES: u64 = MAX_MANIFEST_BYTES as u64 + 32 * 1024 * 1024;

/// A request's note, split into the expectation and the path: `expected\npath`.
fn split_expect(meta: &[u8]) -> Option<(Expect<'_>, &str)> {
    let text = std::str::from_utf8(meta).ok()?;
    let (expect, path) = text.split_once('\n')?;
    Some((Expect::from_wire(expect)?, path))
}

fn answer<S: Read + Write>(channel: &mut Channel<S>, kind: u8) -> Result<()> {
    send_blob(channel, kind, &[], &[])
}

/// Answers requests until the other device says goodbye or something is wrong. `head` is the
/// first message, already read. Returns how many files were written or removed here.
/// `allowed` is false when this device has paused sync: every request is then turned down.
/// What a connection may see and change.
pub enum Scope<'a> {
    /// One's own device: the whole notes folder. `shares`: whether it knows the list of shares
    /// (engine.rs, `Pair::shares`).
    Whole { shares: bool },
    /// Another person's device: one share, by its share-space names only (space.rs). The list
    /// the caller sends at the end (`KIND_BASE`) is handed to the function before the answer, so
    /// it is kept before the caller goes on.
    Share(&'a ShareMap, &'a dyn Fn(&Manifest) -> Result<()>),
}

impl Scope<'_> {
    /// Where a requested name is here, if this connection may touch it at all. `listed_only`:
    /// reading, changing and removing need a listed name; making a new file needs only a name
    /// of the share (a new attachment a changed page links to).
    fn place(&self, path: &str, listed_only: bool) -> Option<String> {
        match self {
            Scope::Whole { .. } => Some(path.to_string()),
            Scope::Share(map, _) if listed_only && !map.listed(path) => None,
            Scope::Share(map, _) => map.to_vault(path),
        }
    }
}

pub fn serve<S: Read + Write>(channel: &mut Channel<S>, head: Vec<u8>, root: &Path, allowed: bool, scope: Scope) -> Result<usize> {
    let mut changed = 0;
    let mut next = Some(head);
    for _ in 0..MAX_REQUESTS {
        let head = match next.take() {
            Some(head) => head,
            None => channel.recv()?,
        };
        let request = recv_blob_from(channel, &head, MAX_TRANSFER_BYTES + 1024)?;
        if request.kind == KIND_BYE {
            return Ok(changed);
        }
        if !allowed {
            answer(channel, KIND_NO)?;
            return Err(SyncError::Refused("sync is paused"));
        }
        match request.kind {
            KIND_LIST => {
                let listing = match &scope {
                    Scope::Whole { shares } => super::engine::listing_for(root, *shares)?,
                    Scope::Share(map, _) => super::engine::share_listing(root, map)?,
                };
                send_blob(channel, KIND_LISTING, &[], &encode_listing_full(&listing))?;
            }
            KIND_BASE => match &scope {
                Scope::Share(_, keep) => {
                    let text = std::str::from_utf8(&request.body).map_err(|_| SyncError::Damaged("base"))?;
                    keep(&Manifest::from_text(text)?)?;
                    answer(channel, KIND_OK)?;
                }
                Scope::Whole { .. } => return Err(SyncError::Refused("unknown request")),
            },
            KIND_GET => {
                let asked = std::str::from_utf8(&request.meta).map_err(|_| SyncError::Refused("path not allowed"))?;
                let Some(path) = scope.place(asked, true) else {
                    answer(channel, KIND_MISSING)?;
                    continue;
                };
                match files::current_hash(root, &path)? {
                    None => answer(channel, KIND_MISSING)?,
                    Some(_) => match read_with_hash(root, &path)? {
                        Some((hash, bytes)) => send_blob(channel, KIND_FILE, hash.as_bytes(), &bytes)?,
                        None => answer(channel, KIND_MISSING)?,
                    },
                }
            }
            KIND_PUT => {
                // The note is `expected\nnew hash\npath`.
                let text = std::str::from_utf8(&request.meta).map_err(|_| SyncError::Refused("path not allowed"))?;
                let (expect, rest) = text.split_once('\n').ok_or(SyncError::Refused("bad request"))?;
                let (new_hash, path) = rest.split_once('\n').ok_or(SyncError::Refused("bad request"))?;
                let expect = Expect::from_wire(expect).ok_or(SyncError::Refused("bad request"))?;
                // What arrived must be what was announced, or it is not stored.
                if hash_bytes(&request.body) != new_hash {
                    answer(channel, KIND_NO)?;
                    return Err(SyncError::Refused("file damaged on the way"));
                }
                let Some(path) = scope.place(path, !matches!(expect, Expect::Absent)) else {
                    answer(channel, KIND_NO)?;
                    continue;
                };
                match files::put(root, &path, expect, &request.body, None) {
                    Ok(Done::Applied) => {
                        changed += 1;
                        answer(channel, KIND_OK)?;
                    }
                    Ok(Done::Changed) => answer(channel, KIND_CHANGED)?,
                    Err(SyncError::Refused(_)) | Err(SyncError::Io(_)) => answer(channel, KIND_NO)?,
                    Err(other) => return Err(other),
                }
            }
            KIND_DEL => {
                let (expect, path) = split_expect(&request.meta).ok_or(SyncError::Refused("bad request"))?;
                let Expect::Hash(hash) = expect else { return Err(SyncError::Refused("bad request")) };
                let Some(path) = scope.place(path, true) else {
                    answer(channel, KIND_NO)?;
                    continue;
                };
                match files::remove(root, &path, hash) {
                    Ok(Done::Applied) => {
                        changed += 1;
                        answer(channel, KIND_OK)?;
                    }
                    Ok(Done::Changed) => answer(channel, KIND_CHANGED)?,
                    Err(SyncError::Refused(_)) | Err(SyncError::Io(_)) => answer(channel, KIND_NO)?,
                    Err(other) => return Err(other),
                }
            }
            KIND_FOLDER => {
                let text = std::str::from_utf8(&request.meta).map_err(|_| SyncError::Refused("bad request"))?;
                let (what, path) = text.split_once('\n').ok_or(SyncError::Refused("bad request"))?;
                // Folders are only synced between one's own devices; a share has its own names.
                if !matches!(scope, Scope::Whole { .. }) {
                    answer(channel, KIND_NO)?;
                    continue;
                }
                let done = match what {
                    "make" => files::make_folder(root, path),
                    "remove" => files::remove_empty_folder(root, path),
                    _ => return Err(SyncError::Refused("bad request")),
                };
                match done {
                    Ok(Done::Applied) => {
                        changed += 1;
                        answer(channel, KIND_OK)?;
                    }
                    Ok(Done::Changed) => answer(channel, KIND_CHANGED)?,
                    Err(SyncError::Refused(_)) | Err(SyncError::Io(_)) => answer(channel, KIND_NO)?,
                    Err(other) => return Err(other),
                }
            }
            _ => return Err(SyncError::Refused("unknown request")),
        }
    }
    Err(SyncError::Refused("too many requests"))
}

fn read_with_hash(root: &Path, path: &str) -> Result<Option<(String, Vec<u8>)>> {
    // Read once and hash what was read, so the hash always matches the bytes sent.
    let Some(hash) = files::current_hash(root, path)? else { return Ok(None) };
    Ok(files::read_expected(root, path, &hash)?.map(|bytes| (hash, bytes)))
}
