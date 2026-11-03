//! ScaleNote vault logic.
//!
//! This crate has no window, web view or network code in it. That is deliberate: the
//! part of the app that touches the user's notes must be testable on any machine, and
//! every rule about not losing a note is checked here by tests that call the real
//! functions.

pub mod atomic;
pub mod logger;
pub mod names;
pub mod vault;

pub use vault::{Entry, EntryKind, NoteContent, NoteVersion, Tree, Vault, VaultError};
