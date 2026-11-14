//! The groundwork of syncing a vault between a person's own devices (version 0.5).
//!
//! Nothing in here touches a network. This part only answers questions about folders:
//! what did every file look like (`manifest`), what has to happen so two copies of a vault
//! become the same without losing a word (`plan`), who is this device (`device`).
//! The network parts that come later (pairing, finding each other, the transfer) are built on
//! these rules, so every rule about not losing a note is tested here, on real folders.

pub mod device;
pub mod manifest;
pub mod plan;

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
}

impl fmt::Display for SyncError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            SyncError::Io(error) => write!(f, "{error}"),
            SyncError::TooManyFiles => write!(f, "too many files to sync"),
            SyncError::Damaged(what) => write!(f, "damaged: {what}"),
        }
    }
}

impl std::error::Error for SyncError {}

impl From<io::Error> for SyncError {
    fn from(error: io::Error) -> Self {
        SyncError::Io(error)
    }
}

pub type Result<T> = std::result::Result<T, SyncError>;

#[cfg(test)]
mod tests;
