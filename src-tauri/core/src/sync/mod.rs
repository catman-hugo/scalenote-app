//! The groundwork of syncing a vault between a person's own devices (version 0.5).
//!
//! Nothing in here touches a network. This part only answers questions about folders:
//! what did every file look like (`manifest`), what has to happen so two copies of a vault
//! become the same without losing a word (`plan`), who is this device (`device`).
//! The network parts that come later (pairing, finding each other, the transfer) are built on
//! these rules, so every rule about not losing a note is tested here, on real folders.

pub mod channel;
pub mod conflicts;
pub mod device;
pub mod discovery;
pub mod engine;
pub mod exchange;
pub mod files;
pub mod folders;
pub mod hex;
pub mod identity;
pub mod invite;
pub mod account;
pub mod basetext;
pub mod keep;
pub mod networks;
pub mod settings_merge;
pub mod shares;
pub mod space;
pub mod manifest;
pub mod pairing;
pub mod plan;
pub mod manager;
pub mod service;
pub mod tailscale;
pub mod trust;
pub mod watch;

pub use device::{Device, Loaded, SyncSettings};
pub use manifest::{FileState, Manifest, Scan, Skip, SkipReason};
pub use plan::{conflict_name, make_plan, Action, Plan, PlanInput, PlanSummary, Side};

use std::fmt;
use std::io;

/// What can go wrong in the sync rules.
#[derive(Debug)]
pub enum SyncError {
    Io(io::Error),
    /// The vault has more files than a sync will take on (see `manifest::MAX_FILES`).
    TooManyFiles,
    /// A file that came from somewhere else (or was damaged) is not what it should be.
    Damaged(&'static str),
    /// The other device was turned away or sent something that is not allowed.
    Refused(&'static str),
    /// The encrypted connection failed (wrong keys, cut connection, damaged data).
    Channel(&'static str),
}

impl fmt::Display for SyncError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            SyncError::Io(error) => write!(f, "{error}"),
            SyncError::TooManyFiles => write!(f, "too many files to sync"),
            SyncError::Damaged(what) => write!(f, "damaged: {what}"),
            SyncError::Refused(why) => write!(f, "refused: {why}"),
            SyncError::Channel(why) => write!(f, "connection: {why}"),
        }
    }
}

impl std::error::Error for SyncError {
}

impl SyncError {
    /// A short code the interface turns into a sentence (same idea as `VaultError::code`).
    pub fn code(&self) -> &'static str {
        match self {
            SyncError::Io(error) if error.kind() == std::io::ErrorKind::AddrInUse => "sync_find_failed",
            SyncError::Io(_) => "sync_unreachable",
            SyncError::TooManyFiles | SyncError::Damaged(_) => "io",
            SyncError::Refused("the code is not 8 digits") => "pair_bad_code",
            SyncError::Refused("sync is off") => "sync_off",
            SyncError::Refused("sync is not available") => "sync_unavailable",
            SyncError::Refused("sync is paused") => "sync_paused",
            SyncError::Refused("sync is busy") => "sync_busy",
            SyncError::Refused("only on Wi-Fi") => "sync_wifi_only",
            SyncError::Refused("no vault is open") => "sync_no_vault",
            SyncError::Refused("device not found") => "sync_not_found",
            SyncError::Refused("not the paired device") => "sync_wrong_device",
            SyncError::Refused("the other device said no") => "sync_peer_refused",
            SyncError::Refused("paired with another folder") => "sync_other_folder",
            SyncError::Refused("the other device has it with another folder") => "sync_peer_other_folder",
            SyncError::Refused("not available offline") => "not_available_offline",
            SyncError::Refused("name is empty") => "account_name_empty",
            SyncError::Refused("not a choice") | SyncError::Refused("path not allowed") | SyncError::Refused("too many choices") => "offline_bad_choice",
            SyncError::Refused(_) => "pair_refused",
            SyncError::Channel(_) => "pair_failed",
        }
    }
}

impl From<io::Error> for SyncError {
    fn from(error: io::Error) -> Self {
        SyncError::Io(error)
    }
}

pub type Result<T> = std::result::Result<T, SyncError>;

#[cfg(test)]
mod tests;

#[cfg(test)]
mod tests_discovery;
#[cfg(test)]
mod tests_pairing;

#[cfg(test)]
mod tests_service;

#[cfg(test)]
mod tests_sync;

#[cfg(test)]
mod tests_conflicts;

#[cfg(test)]
mod tests_keep;
