//! A person's account for sharing (0.6.4, slice 2): a name and a random id, the same on all of
//! the person's paired devices. There is no server: the account only exists on these devices.
//!
//! - The name is what other people see when they share something with you, and what you pick
//!   when you share with them. It is chosen in Settings, Sync.
//! - The id tells two people with the same name apart. It is made at random the first time a
//!   name is set, and paired devices pass it on to each other (`greeting_part` / `read_greeting`):
//!   a device without an account takes the one of a paired device that has one.
//! - "Findable" lets people nearby see the name, so they can share with you. It is off until
//!   switched on (anything that shows something about you on its own is opt-in).
//!
//! Kept in the app's own folder (`account.txt`), never in the notes.

use super::hex;
use super::{Result, SyncError};
use crate::atomic::write_atomic;
use std::fs;
use std::path::Path;

pub const ID_LEN: usize = 16;
const HEADER: &str = "scalenote-account 1";
const MAX_FILE_BYTES: u64 = 4096;
/// Longest name, in characters.
pub const MAX_NAME_CHARS: usize = 40;

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Account {
    pub id: Option<[u8; ID_LEN]>,
    pub name: String,
    pub findable: bool,
}

/// A name as it may be shown: trimmed, without control characters, at most 40 characters.
/// `None` when nothing is left.
pub fn clean_person_name(raw: &str) -> Option<String> {
    let cleaned: String = raw.chars().filter(|c| !c.is_control()).collect::<String>().split_whitespace().collect::<Vec<_>>().join(" ");
    let cut: String = cleaned.chars().take(MAX_NAME_CHARS).collect();
    (!cut.is_empty()).then_some(cut)
}

impl Account {
    /// Whether the account has a name (and so an id).
    pub fn is_set(&self) -> bool {
        self.id.is_some() && !self.name.is_empty()
    }

    pub fn load(path: &Path) -> Account {
        let Ok(meta) = fs::symlink_metadata(path) else { return Account::default() };
        if !meta.is_file() || meta.len() > MAX_FILE_BYTES {
            return Account::default();
        }
        let Ok(text) = fs::read_to_string(path) else { return Account::default() };
        let mut lines = text.lines();
        if lines.next() != Some(HEADER) {
            return Account::default();
        }
        let id = lines.next().and_then(hex::decode::<ID_LEN>);
        let name = lines.next().and_then(clean_person_name).unwrap_or_default();
        let findable = lines.next() == Some("findable");
        if id.is_none() || name.is_empty() {
            return Account::default();
        }
        Account { id, name, findable }
    }

    pub fn save(&self, path: &Path) -> Result<()> {
        let id = self.id.map(|id| hex::encode(&id)).unwrap_or_default();
        let text = format!("{HEADER}\n{id}\n{}\n{}\n", self.name, if self.findable { "findable" } else { "hidden" });
        write_atomic(path, text.as_bytes())?;
        Ok(())
    }

    /// Sets the name; makes the id the first time.
    pub fn set_name(&mut self, raw: &str) -> Result<()> {
        let name = clean_person_name(raw).ok_or(SyncError::Refused("name is empty"))?;
        if self.id.is_none() {
            let mut id = [0u8; ID_LEN];
            getrandom::fill(&mut id).map_err(|_| SyncError::Refused("no randomness"))?;
            self.id = Some(id);
        }
        self.name = name;
        Ok(())
    }

    /// The part of the hello to paired devices that carries the account: ` acct=<id>.<name as hex>`.
    /// Empty when there is no account. The name is hex so that spaces cannot split the hello.
    pub fn greeting_part(&self) -> String {
        match (self.id, self.is_set()) {
            (Some(id), true) => format!(" acct={}.{}", hex::encode(&id), hex::encode(self.name.as_bytes())),
            _ => String::new(),
        }
    }

    /// The account in a paired device's hello, if it sent a valid one.
    pub fn read_greeting(text: &str) -> Option<Account> {
        let value = text.split(' ').find_map(|part| part.strip_prefix("acct="))?;
        let (id, name) = value.split_once('.')?;
        let id = hex::decode::<ID_LEN>(id)?;
        if name.len() > MAX_NAME_CHARS * 8 || name.len() % 2 != 0 {
            return None;
        }
        let bytes: Option<Vec<u8>> = (0..name.len()).step_by(2).map(|i| u8::from_str_radix(&name[i..i + 2], 16).ok()).collect();
        let name = clean_person_name(&String::from_utf8(bytes?).ok()?)?;
        Some(Account { id: Some(id), name, findable: false })
    }

    /// Takes a paired device's account when this device has none yet. True when it changed.
    pub fn adopt(&mut self, theirs: &Account) -> bool {
        if self.is_set() || !theirs.is_set() {
            return false;
        }
        self.id = theirs.id;
        self.name = theirs.name.clone();
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_are_cleaned_and_cut() {
        assert_eq!(clean_person_name("  Mila \n van  Dam "), Some("Mila van Dam".to_string()));
        assert_eq!(clean_person_name("\u{7}"), None);
        assert_eq!(clean_person_name(&"x".repeat(80)).map(|n| n.chars().count()), Some(40));
    }

    #[test]
    fn an_account_is_saved_passed_on_in_the_hello_and_taken_by_a_device_without_one() {
        let dir = std::env::temp_dir().join(format!("sn-account-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).expect("dir");
        let path = dir.join("account.txt");
        let mut mine = Account::default();
        assert_eq!(mine.greeting_part(), "");
        mine.set_name("Rowan Ä").expect("name");
        mine.findable = true;
        mine.save(&path).expect("save");
        assert_eq!(Account::load(&path), mine);
        let hello = format!("0.6.4 ts=100.64.0.1:1{}", mine.greeting_part());
        let theirs = Account::read_greeting(&hello).expect("read");
        assert_eq!((theirs.id, theirs.name.as_str(), theirs.findable), (mine.id, "Rowan Ä", false));
        let mut other_device = Account::default();
        assert!(other_device.adopt(&theirs));
        assert!(!other_device.adopt(&Account::default()));
        assert!(Account::read_greeting("0.6.4 acct=zz.41").is_none());
        assert!(Account::read_greeting("0.6.3").is_none());
        fs::write(&path, "junk").expect("damage");
        assert_eq!(Account::load(&path), Account::default());
        let _ = fs::remove_dir_all(&dir);
    }
}
