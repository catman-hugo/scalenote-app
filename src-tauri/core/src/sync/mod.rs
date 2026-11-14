//! The groundwork of syncing a vault between a person's own devices (version 0.5).
//!
//! Nothing in here touches a network. This part only answers questions about folders:
//! what did every file look like (`manifest`), what has to happen so two copies of a vault
//! become the same without losing a word (`plan`), who is this device (`device`).
//! The network parts that come later (pairing, finding each other, the transfer) are built on
//! these rules, so every rule about not losing a note is tested here, on real folders.

pub mod channel;
pub mod device;
pub mod hex;
pub mod identity;
pub mod manifest;
pub mod pairing;
pub mod plan;
pub mod manager;
pub mod service;
pub mod trust;

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
            SyncError::Io(_) => "sync_unreachable",
            SyncError::TooManyFiles | SyncError::Damaged(_) => "io",
            SyncError::Refused("the code is not 8 digits") => "pair_bad_code",
            SyncError::Refused("sync is off") => "sync_off",
            SyncError::Refused("sync is not available") => "sync_unavailable",
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
mod tests_pairing;

#[cfg(test)]
mod tests_service;
