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

/// The listing: the list of files as text, then the names that were left out on purpose.
/// Body layout: `<manifest length as 8 digits>` `<manifest text>` `<one skipped path per line>`.
pub fn encode_listing(manifest: &Manifest, skipped: &[String]) -> Vec<u8> {
    let text = manifest.to_text();
    let mut body = format!("{:08}", text.len()).into_bytes();
    body.extend_from_slice(text.as_bytes());
    for path in skipped {
        body.extend_from_slice(path.as_bytes());
        body.push(b'\n');
    }
    body
}

pub fn decode_listing(body: &[u8]) -> Result<(Manifest, BTreeSet<String>)> {
    let digits = body.get(..8).and_then(|d| std::str::from_utf8(d).ok()).ok_or(SyncError::Damaged("listing"))?;
    let length: usize = digits.parse().map_err(|_| SyncError::Damaged("listing"))?;
    let end = 8usize.checked_add(length).filter(|e| *e <= body.len()).ok_or(SyncError::Damaged("listing"))?;
    let manifest = Manifest::from_text(std::str::from_utf8(&body[8..end]).map_err(|_| SyncError::Damaged("listing"))?)?;
    let rest = std::str::from_utf8(&body[end..]).map_err(|_| SyncError::Damaged("listing"))?;
    let mut skipped = BTreeSet::new();
    for line in rest.lines() {
        // Names that are not safe paths could never be planned anyway; they are dropped.
        if safe_path(line) && skipped.len() < super::manifest::MAX_FILES {
            skipped.insert(line.to_string());
        }
    }
    Ok((manifest, skipped))
}

/// How many bytes a listing may have: the manifest limit plus room for the skipped names.
pub const MAX_LISTING_BYTES: u64 = MAX_MANIFEST_BYTES as u64 + 16 * 1024 * 1024;

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
pub fn serve<S: Read + Write>(channel: &mut Channel<S>, head: Vec<u8>, root: &Path, allowed: bool) -> Result<usize> {
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
                let scan = Manifest::scan(root)?;
                let skipped: Vec<String> = scan.skipped.iter().map(|s| s.path.clone()).collect();
                send_blob(channel, KIND_LISTING, &[], &encode_listing(&scan.manifest, &skipped))?;
            }
            KIND_GET => {
                let path = std::str::from_utf8(&request.meta).map_err(|_| SyncError::Refused("path not allowed"))?;
                match files::current_hash(root, path)? {
                    None => answer(channel, KIND_MISSING)?,
                    Some(_) => match read_with_hash(root, path)? {
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
                match files::put(root, path, expect, &request.body, None) {
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
                match files::remove(root, path, hash) {
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
