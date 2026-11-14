//! The devices this device trusts: the "Paired devices" list.
//!
//! A device is trusted by its public key, not by its name or address, so a device that merely
//! uses the same name is not trusted. Nothing secret is in this file (public keys only), but it
//! is still read as untrusted input: size and count limits, exact format, cleaned names.

use super::device::{clean_name, MAX_DEVICE_NAME_CHARS};
use super::identity::KEY_LEN;
use super::{hex, Result, SyncError};
use crate::atomic::write_atomic;
use std::fs;
use std::io;
use std::path::Path;

const HEADER: &str = "scalenote-trust 1";
pub const MAX_PEERS: usize = 64;
const MAX_FILE_BYTES: u64 = 64 * 1024;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Peer {
    /// A name the person can read in the list; cleaned so it is safe in file names too.
    pub name: String,
    pub public: [u8; KEY_LEN],
    /// The day it was paired, for example `2026-11-14`.
    pub added: String,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct TrustList {
    peers: Vec<Peer>,
}

impl TrustList {
    pub fn peers(&self) -> &[Peer] {
        &self.peers
    }

    pub fn is_empty(&self) -> bool {
        self.peers.is_empty()
    }

    pub fn contains(&self, public: &[u8; KEY_LEN]) -> bool {
        self.peers.iter().any(|p| &p.public == public)
    }

    /// Adds a device, or updates the name of one that is already trusted (same key).
    pub fn add(&mut self, name: &str, public: [u8; KEY_LEN], added: &str) -> Result<()> {
        let name = clean_name(name);
        if let Some(existing) = self.peers.iter_mut().find(|p| p.public == public) {
            existing.name = name;
            return Ok(());
        }
        if self.peers.len() >= MAX_PEERS {
            return Err(SyncError::Refused("too many paired devices"));
        }
        self.peers.push(Peer { name, public, added: added.chars().filter(|c| c.is_ascii_digit() || *c == '-').take(10).collect() });
        Ok(())
    }

    /// Removes a device. Returns whether it was in the list.
    pub fn remove(&mut self, public: &[u8; KEY_LEN]) -> bool {
        let before = self.peers.len();
        self.peers.retain(|p| &p.public != public);
        self.peers.len() != before
    }

    pub fn to_text(&self) -> String {
        let mut out = format!("{HEADER}\n");
        for peer in &self.peers {
            out.push_str(&format!("{} {} {}\n", hex::encode(&peer.public), peer.added, peer.name));
        }
        out
    }

    pub fn from_text(text: &str) -> Result<TrustList> {
        let mut lines = text.lines();
        if lines.next() != Some(HEADER) {
            return Err(SyncError::Damaged("trust list header"));
        }
        let mut list = TrustList::default();
        for line in lines {
            let mut parts = line.splitn(3, ' ');
            let (Some(key), Some(added), Some(name)) = (parts.next(), parts.next(), parts.next()) else {
                return Err(SyncError::Damaged("trust list line"));
            };
            let Some(public) = hex::decode::<KEY_LEN>(key) else {
                return Err(SyncError::Damaged("trust list key"));
            };
            if name.is_empty() || name.chars().count() > MAX_DEVICE_NAME_CHARS || list.contains(&public) {
                return Err(SyncError::Damaged("trust list entry"));
            }
            list.add(name, public, added)?;
        }
        Ok(list)
    }

    /// Reads the list; a missing file is an empty list, a damaged one is an error (so a broken
    /// file is never mistaken for "nobody is trusted" and then overwritten).
    pub fn load(path: &Path) -> Result<TrustList> {
        match fs::metadata(path) {
            Ok(meta) if meta.is_file() && meta.len() <= MAX_FILE_BYTES => {
                let text = fs::read_to_string(path).map_err(|_| SyncError::Damaged("trust list text"))?;
                TrustList::from_text(&text)
            }
            Ok(_) => Err(SyncError::Damaged("trust list file")),
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(TrustList::default()),
            Err(error) => Err(error.into()),
        }
    }

    pub fn save(&self, path: &Path) -> Result<()> {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        write_atomic(path, self.to_text().as_bytes())?;
        Ok(())
    }
}
