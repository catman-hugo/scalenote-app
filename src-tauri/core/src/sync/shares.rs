//! The list of shares (0.6.4, slice 3): what this person shares with others and what others
//! share with them. Kept in the notes folder at `.scalenote/shares.json`, so all of a person's
//! own devices have the same list: it is synced between them like the folder colours, merged
//! share by share (settings_merge.rs, `merge_keyed`).
//!
//! One share is one page or folder and the people in it. Per share:
//! - `id`: random, the same on every device of every person in the share;
//! - `item`: the page or folder's own name (the "share space" starts there);
//! - `owner`: the account id of the person who shared it; only the owner stops it or adds people;
//! - `people`: everyone in it, by account id, with their name and the device keys known for them
//!   (a device answers a share sync only for these keys, slice 5);
//! - `path`: where it is in this person's notes. The owner's is where the page or folder already
//!   was; a member's is `Shared with me/<owner>/<item>`;
//! - `state`: see `State`.
//!
//! The file is written by this app and synced from the person's own devices, but a share record
//! first arrives from another person (an invitation), so every record is checked when it is read:
//! sizes, names, safe paths, key lengths. A record that fails is left out of what the app uses,
//! but the file itself is only ever replaced by a whole, valid list (atomic write).

use super::account::{clean_person_name, Account, ID_LEN};
use super::hex;
use super::identity::KEY_LEN;
use super::manifest::{portable_name, safe_path};
use super::{Result, SyncError};
use crate::atomic::write_atomic;
use serde_json::{json, Map, Value};
use std::collections::BTreeMap;
use std::fs;
use std::path::Path;

/// Where the list is kept, relative to the notes folder. Synced between own devices.
pub const SHARES_FILE: &str = ".scalenote/shares.json";
/// The folder a member's shares are put in.
pub const SHARED_FOLDER: &str = "Shared with me";
const FORMAT: u64 = 1;
pub const MAX_SHARES: usize = 500;
pub const MAX_PEOPLE: usize = 50;
pub const MAX_KEYS: usize = 16;
const MAX_FILE_BYTES: u64 = 2 * 1024 * 1024;

/// Where a share stands, as seen by this person.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum State {
    /// Owner: asked the other person, no answer yet.
    Offered,
    /// Member: was asked, has not answered yet.
    Invited,
    /// Both: being synced.
    Active,
    /// Member: said no. Nothing was copied.
    Declined,
    /// Member: left. Their copy stays theirs, it is no longer synced.
    Left,
    /// Owner: stopped sharing. Every copy stays where it is, nothing is synced any more.
    Stopped,
}

impl State {
    fn word(self) -> &'static str {
        match self {
            State::Offered => "offered",
            State::Invited => "invited",
            State::Active => "active",
            State::Declined => "declined",
            State::Left => "left",
            State::Stopped => "stopped",
        }
    }

    fn from_word(word: &str) -> Option<State> {
        [State::Offered, State::Invited, State::Active, State::Declined, State::Left, State::Stopped].into_iter().find(|s| s.word() == word)
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Person {
    pub name: String,
    pub keys: Vec<[u8; KEY_LEN]>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Share {
    pub id: [u8; ID_LEN],
    pub item: String,
    pub folder: bool,
    pub owner: [u8; ID_LEN],
    pub people: BTreeMap<[u8; ID_LEN], Person>,
    pub path: String,
    pub state: State,
    /// Member: the owner's device has heard the answer. Until then it is sent again when the
    /// owner's device can be reached (always true for the owner).
    pub told: bool,
}

impl Share {
    /// Whether `key` is a device of someone in this share, and the share is being synced.
    pub fn allows(&self, key: &[u8; KEY_LEN]) -> bool {
        self.state == State::Active && self.people.values().any(|p| p.keys.contains(key))
    }

    /// Whether `path` (a vault path) is this share's page or inside its folder.
    pub fn covers(&self, path: &str) -> bool {
        if self.folder {
            path.strip_prefix(&self.path).is_some_and(|rest| rest.starts_with('/'))
        } else {
            path == self.path
        }
    }

    fn to_value(&self) -> Value {
        let people: Map<String, Value> = self
            .people
            .iter()
            .map(|(id, p)| (hex::encode(id), json!({ "name": p.name, "keys": p.keys.iter().map(|k| hex::encode(k)).collect::<Vec<_>>() })))
            .collect();
        json!({
            "item": self.item,
            "kind": if self.folder { "folder" } else { "page" },
            "owner": hex::encode(&self.owner),
            "people": people,
            "path": self.path,
            "state": self.state.word(),
            "told": self.told,
        })
    }

    /// A record as read from the file, or `None` when anything in it is not as it must be.
    fn from_value(id: &str, value: &Value) -> Option<Share> {
        let id = hex::decode::<ID_LEN>(id)?;
        let item = value.get("item")?.as_str()?;
        if !item_name_ok(item) {
            return None;
        }
        let folder = match value.get("kind")?.as_str()? {
            "folder" => true,
            "page" => false,
            _ => return None,
        };
        let owner = hex::decode::<ID_LEN>(value.get("owner")?.as_str()?)?;
        let Value::Object(list) = value.get("people")? else { return None };
        if list.is_empty() || list.len() > MAX_PEOPLE {
            return None;
        }
        let mut people = BTreeMap::new();
        for (account, person) in list {
            let account = hex::decode::<ID_LEN>(account)?;
            let name = clean_person_name(person.get("name")?.as_str()?)?;
            let Value::Array(raw_keys) = person.get("keys")? else { return None };
            if raw_keys.len() > MAX_KEYS {
                return None;
            }
            let keys = raw_keys.iter().map(|k| k.as_str().and_then(hex::decode::<KEY_LEN>)).collect::<Option<Vec<_>>>()?;
            people.insert(account, Person { name, keys });
        }
        if !people.contains_key(&owner) {
            return None;
        }
        let path = value.get("path")?.as_str()?.to_string();
        if !safe_path(&path) || path.starts_with(".scalenote") {
            return None;
        }
        let state = State::from_word(value.get("state")?.as_str()?)?;
        // Missing means told: records only ever lack it when nothing is waiting.
        let told = value.get("told").and_then(Value::as_bool).unwrap_or(true);
        Some(Share { id, item: item.to_string(), folder, owner, people, path, state, told })
    }
}

/// A page or folder name that may be the start of a share: one portable name, not hidden.
pub(crate) fn item_name_ok(name: &str) -> bool {
    !name.is_empty() && name.len() <= 255 && portable_name(name) && !name.starts_with('.')
}

/// A person's name made into a folder name that works on every system: characters that are not
/// allowed in file names become `-`.
pub fn folder_name_for(person: &str) -> String {
    let swapped: String = person.chars().map(|c| if matches!(c, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|') { '-' } else { c }).collect();
    let trimmed = swapped.trim_matches(|c: char| c == '.' || c == ' ');
    if trimmed.is_empty() || !portable_name(trimmed) {
        "Someone".to_string()
    } else {
        trimmed.to_string()
    }
}

/// All the shares of this notes folder.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Shares {
    pub list: BTreeMap<[u8; ID_LEN], Share>,
}

impl Shares {
    /// Reads the list. A missing file is an empty list. A file that cannot be read as a list at
    /// all is an error, so it is never overwritten by a list that forgot what was in it.
    pub fn load(root: &Path) -> Result<Shares> {
        let path = root.join(SHARES_FILE);
        let meta = match fs::symlink_metadata(&path) {
            Ok(meta) => meta,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Shares::default()),
            Err(error) => return Err(error.into()),
        };
        if !meta.is_file() || meta.len() > MAX_FILE_BYTES {
            return Err(SyncError::Damaged("shares file"));
        }
        Shares::from_json(&fs::read(&path)?).ok_or(SyncError::Damaged("shares file"))
    }

    /// The list in a file's text. Records that are not as they must be are left out.
    pub fn from_json(text: &[u8]) -> Option<Shares> {
        let Value::Object(whole) = serde_json::from_slice::<Value>(text).ok()? else { return None };
        if whole.get("format").and_then(Value::as_u64) != Some(FORMAT) {
            return None;
        }
        let Value::Object(records) = whole.get("shares")? else { return None };
        let list = records.iter().filter_map(|(id, value)| Share::from_value(id, value)).take(MAX_SHARES).map(|s| (s.id, s)).collect();
        Some(Shares { list })
    }

    pub fn to_json(&self) -> Vec<u8> {
        let records: Map<String, Value> = self.list.values().map(|s| (hex::encode(&s.id), s.to_value())).collect();
        // serde_json cannot fail on a Value made of strings and objects.
        serde_json::to_vec_pretty(&json!({ "format": FORMAT, "shares": records })).unwrap_or_default()
    }

    pub fn save(&self, root: &Path) -> Result<()> {
        fs::create_dir_all(root.join(".scalenote"))?;
        write_atomic(&root.join(SHARES_FILE), &self.to_json())?;
        Ok(())
    }

    /// The share that `path` is in, if any.
    pub fn of_path(&self, path: &str) -> Option<&Share> {
        self.list.values().find(|s| matches!(s.state, State::Offered | State::Active) && (s.covers(path) || s.path == path))
    }

    /// Starts sharing `path` (a page `….md` or a folder) with `to`. The record waits as offered
    /// until the other person accepts. Sharing the same item with a second person adds them to
    /// the same share.
    pub fn offer(&mut self, own: &Account, own_keys: &[[u8; KEY_LEN]], path: &str, folder: bool, to: [u8; ID_LEN], to_name: &str) -> Result<[u8; ID_LEN]> {
        let Some(own_id) = own.id.filter(|_| own.is_set()) else { return Err(SyncError::Refused("name is empty")) };
        let item = path.rsplit('/').next().unwrap_or(path);
        if !safe_path(path) || !item_name_ok(item) || (!folder && !path.ends_with(".md")) {
            return Err(SyncError::Refused("not shareable"));
        }
        if to == own_id {
            return Err(SyncError::Refused("not shareable"));
        }
        let name = clean_person_name(to_name).ok_or(SyncError::Refused("not shareable"))?;
        if let Some(share) = self.list.values_mut().find(|s| s.path == path && s.owner == own_id && s.state != State::Stopped) {
            if share.people.len() >= MAX_PEOPLE {
                return Err(SyncError::Refused("too many people"));
            }
            share.people.entry(to).or_insert(Person { name, keys: Vec::new() });
            return Ok(share.id);
        }
        if self.list.len() >= MAX_SHARES {
            return Err(SyncError::Refused("too many shares"));
        }
        if self.list.values().any(|s| s.state != State::Stopped && (s.covers(path) || (folder && path_inside(&s.path, path)))) {
            // A share inside a share (or around one) would sync the same pages twice.
            return Err(SyncError::Refused("already shared"));
        }
        let mut id = [0u8; ID_LEN];
        getrandom::fill(&mut id).map_err(|_| SyncError::Refused("no random numbers"))?;
        let mut people = BTreeMap::new();
        people.insert(own_id, Person { name: own.name.clone(), keys: own_keys.iter().take(MAX_KEYS).copied().collect() });
        people.insert(to, Person { name, keys: Vec::new() });
        self.list.insert(id, Share { id, item: item.to_string(), folder, owner: own_id, people, path: path.to_string(), state: State::Offered, told: true });
        Ok(id)
    }

    /// An invitation from another person (slice 4 checks where it came from). It is kept as
    /// invited, with the place it will have here: `Shared with me/<owner>/<item>`, made unique.
    pub fn receive(&mut self, mut share: Share, taken: &dyn Fn(&str) -> bool) -> Result<()> {
        if self.list.contains_key(&share.id) {
            return Ok(());
        }
        if self.list.len() >= MAX_SHARES {
            return Err(SyncError::Refused("too many shares"));
        }
        let owner = share.people.get(&share.owner).map(|p| p.name.clone()).ok_or(SyncError::Damaged("invitation"))?;
        let base = format!("{SHARED_FOLDER}/{}", folder_name_for(&owner));
        share.path = self.free_place(&base, &share.item, taken);
        share.state = State::Invited;
        self.list.insert(share.id, share);
        Ok(())
    }

    /// A place under `base` for `item` that no file and no other share uses: `Biology`, then
    /// `Biology 2`, … (before the `.md` for a page).
    fn free_place(&self, base: &str, item: &str, taken: &dyn Fn(&str) -> bool) -> String {
        let (stem, ext) = match item.strip_suffix(".md") {
            Some(stem) => (stem, ".md"),
            None => (item, ""),
        };
        for n in 1..1000 {
            let name = if n == 1 { item.to_string() } else { format!("{stem} {n}{ext}") };
            let candidate = format!("{base}/{name}");
            if !taken(&candidate) && !self.list.values().any(|s| s.path.eq_ignore_ascii_case(&candidate)) {
                return candidate;
            }
        }
        format!("{base}/{stem} {}{ext}", self.list.len() + 1000)
    }

    /// The member's answer. Accepting adds this person's devices to the share.
    pub fn answer(&mut self, id: &[u8; ID_LEN], accept: bool, own: &Account, own_keys: &[[u8; KEY_LEN]]) -> Result<&Share> {
        let own_id = own.id.ok_or(SyncError::Refused("name is empty"))?;
        let share = self.list.get_mut(id).ok_or(SyncError::Refused("no such share"))?;
        if share.state != State::Invited {
            return Err(SyncError::Refused("already answered"));
        }
        if accept {
            let person = share.people.entry(own_id).or_insert(Person { name: own.name.clone(), keys: Vec::new() });
            add_keys(person, own_keys);
            share.state = State::Active;
        } else {
            share.state = State::Declined;
        }
        share.told = false;
        Ok(share)
    }

    /// The owner hears that a person accepted, with the keys of that person's devices.
    pub fn accepted(&mut self, id: &[u8; ID_LEN], who: [u8; ID_LEN], keys: &[[u8; KEY_LEN]]) -> Result<()> {
        let share = self.list.get_mut(id).ok_or(SyncError::Refused("no such share"))?;
        if share.state == State::Stopped {
            return Err(SyncError::Refused("share stopped"));
        }
        let person = share.people.get_mut(&who).ok_or(SyncError::Refused("not invited"))?;
        add_keys(person, keys);
        share.state = State::Active;
        Ok(())
    }

    /// The owner hears that a person said no, or an invitation could not be delivered: that
    /// person is taken out again, and a share nobody else is in is forgotten.
    pub fn withdraw(&mut self, id: &[u8; ID_LEN], who: &[u8; ID_LEN]) {
        let Some(share) = self.list.get_mut(id) else { return };
        if *who == share.owner {
            return;
        }
        share.people.remove(who);
        if share.people.len() == 1 && share.state == State::Offered {
            self.list.remove(id);
        }
    }

    /// The member's answer reached the owner's device.
    pub fn mark_told(&mut self, id: &[u8; ID_LEN]) {
        if let Some(share) = self.list.get_mut(id) {
            share.told = true;
        }
    }

    /// Invitations waiting for an answer here.
    pub fn waiting(&self) -> usize {
        self.list.values().filter(|s| s.state == State::Invited).count()
    }

    /// Stops a share (owner) or leaves it (member). Nobody's copy is touched.
    pub fn end(&mut self, id: &[u8; ID_LEN], own: &Account) -> Result<()> {
        let share = self.list.get_mut(id).ok_or(SyncError::Refused("no such share"))?;
        share.state = if Some(share.owner) == own.id { State::Stopped } else { State::Left };
        Ok(())
    }

    /// A page or folder was moved or renamed here: the share follows it.
    pub fn moved(&mut self, from: &str, to: &str) -> bool {
        let mut changed = false;
        for share in self.list.values_mut() {
            if share.path == from {
                share.path = to.to_string();
                changed = true;
            } else if let Some(rest) = share.path.strip_prefix(from).filter(|r| r.starts_with('/')) {
                share.path = format!("{to}{rest}");
                changed = true;
            }
        }
        changed
    }
}

/// Whether `inner` is inside the folder `outer`.
fn path_inside(inner: &str, outer: &str) -> bool {
    inner.strip_prefix(outer).is_some_and(|rest| rest.starts_with('/'))
}

fn add_keys(person: &mut Person, keys: &[[u8; KEY_LEN]]) {
    for key in keys {
        if !person.keys.contains(key) && person.keys.len() < MAX_KEYS {
            person.keys.push(*key);
        }
    }
}

/// Merges two devices' lists, share by share, against the list both had after their last sync.
/// `None` when one of them is not a list this version reads (then the newer file wins whole).
pub fn merge(base: Option<&[u8]>, local: &[u8], remote: &[u8], local_wins: bool) -> Option<Vec<u8>> {
    let merged = super::settings_merge::merge_keyed(base, local, remote, local_wins, "shares", MAX_SHARES)?;
    // Only a result that reads back as a list is used.
    Shares::from_json(&merged).map(|_| merged)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("sn-shares-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).expect("create scratch dir");
        dir
    }

    fn person(name: &str, id: u8) -> Account {
        Account { id: Some([id; ID_LEN]), name: name.to_string(), findable: true }
    }

    #[test]
    fn a_share_is_offered_accepted_and_ended_and_the_file_reads_back_the_same() {
        let dir = scratch("roundtrip");
        let (alice, bob) = (person("Alice", 1), person("Bob", 2));
        let mut owner = Shares::default();
        let id = owner.offer(&alice, &[[7; KEY_LEN]], "Biology", true, [2; ID_LEN], "Bob").expect("offer");
        assert_eq!(owner.list[&id].state, State::Offered);
        assert!(!owner.list[&id].allows(&[7; KEY_LEN]), "not synced before it is accepted");
        owner.save(&dir).expect("save");
        assert_eq!(Shares::load(&dir).expect("load"), owner);

        // Bob's devices get the record (slice 4 carries it); it lands in Shared with me/Alice.
        let mut member = Shares::default();
        member.receive(owner.list[&id].clone(), &|p| p == "Shared with me/Alice/Biology").expect("receive");
        assert_eq!(member.list[&id].path, "Shared with me/Alice/Biology 2", "a taken place is not used");
        assert_eq!(member.list[&id].state, State::Invited);
        member.answer(&id, true, &bob, &[[8; KEY_LEN]]).expect("accept");
        assert!(member.answer(&id, true, &bob, &[]).is_err(), "answered once");
        owner.accepted(&id, [2; ID_LEN], &[[8; KEY_LEN]]).expect("accepted");
        assert!(owner.list[&id].allows(&[8; KEY_LEN]));
        assert!(!owner.list[&id].allows(&[9; KEY_LEN]), "a stranger's device is not in it");
        assert!(owner.list[&id].covers("Biology/Cells.md") && !owner.list[&id].covers("Biology.md") && !owner.list[&id].covers("Biology 2/x.md"));

        member.end(&id, &bob).expect("leave");
        owner.end(&id, &alice).expect("stop");
        assert_eq!(member.list[&id].state, State::Left);
        assert_eq!(owner.list[&id].state, State::Stopped);
    }

    #[test]
    fn what_cannot_be_shared_is_refused() {
        let alice = person("Alice", 1);
        let mut shares = Shares::default();
        assert!(shares.offer(&Account::default(), &[], "A.md", false, [2; ID_LEN], "Bob").is_err(), "no name");
        assert!(shares.offer(&alice, &[], "A.md", false, [1; ID_LEN], "Alice").is_err(), "yourself");
        assert!(shares.offer(&alice, &[], "../A.md", false, [2; ID_LEN], "Bob").is_err());
        assert!(shares.offer(&alice, &[], "A.txt", false, [2; ID_LEN], "Bob").is_err());
        assert!(shares.offer(&alice, &[], "A.md", false, [2; ID_LEN], " \n ").is_err());
        shares.offer(&alice, &[], "Bio", true, [2; ID_LEN], "Bob").expect("folder");
        assert!(shares.offer(&alice, &[], "Bio/Cells.md", false, [3; ID_LEN], "Carol").is_err(), "inside a share");
        assert!(shares.offer(&alice, &[], "Bio", true, [3; ID_LEN], "Carol").is_ok(), "a second person joins the same share");
        assert_eq!(shares.list.len(), 1);
        assert_eq!(shares.list.values().next().map(|s| s.people.len()), Some(3));
    }

    #[test]
    fn records_from_elsewhere_are_checked_and_bad_ones_left_out() {
        let good = r#"{"item":"Bio","kind":"folder","owner":"01010101010101010101010101010101","people":{"01010101010101010101010101010101":{"name":"Alice","keys":[]}},"path":"Bio","state":"active"}"#;
        let bad = [
            r#"{"item":"..","kind":"folder","owner":"01010101010101010101010101010101","people":{"01010101010101010101010101010101":{"name":"A","keys":[]}},"path":"Bio","state":"active"}"#,
            r#"{"item":"Bio","kind":"folder","owner":"01010101010101010101010101010101","people":{"01010101010101010101010101010101":{"name":"A","keys":[]}},"path":"../../etc","state":"active"}"#,
            r#"{"item":"Bio","kind":"folder","owner":"01010101010101010101010101010101","people":{"01010101010101010101010101010101":{"name":"A","keys":[]}},"path":".scalenote/x","state":"active"}"#,
            r#"{"item":"Bio","kind":"folder","owner":"02020202020202020202020202020202","people":{"01010101010101010101010101010101":{"name":"A","keys":[]}},"path":"Bio","state":"active"}"#,
            r#"{"item":"Bio","kind":"folder","owner":"01010101010101010101010101010101","people":{"01010101010101010101010101010101":{"name":"A","keys":["abc"]}},"path":"Bio","state":"active"}"#,
            r#"{"item":"Bio","kind":"thing","owner":"01010101010101010101010101010101","people":{"01010101010101010101010101010101":{"name":"A","keys":[]}},"path":"Bio","state":"active"}"#,
            r#"{"item":"Bio","kind":"folder","owner":"01010101010101010101010101010101","people":{"01010101010101010101010101010101":{"name":"A","keys":[]}},"path":"Bio","state":"run"}"#,
        ];
        let mut text = format!(r#"{{"format":1,"shares":{{"0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a":{good}"#);
        for (n, record) in bad.iter().enumerate() {
            text.push_str(&format!(r#","{:032x}":{record}"#, n + 1));
        }
        text.push_str("}}");
        let shares = Shares::from_json(text.as_bytes()).expect("a list");
        assert_eq!(shares.list.len(), 1, "only the good record");
        for junk in [&b"junk"[..], b"{\"format\":2,\"shares\":{}}", b"{\"format\":1}"] {
            assert!(Shares::from_json(junk).is_none());
        }
        // A damaged file is an error, so it is never saved over.
        let dir = scratch("damaged");
        fs::create_dir_all(dir.join(".scalenote")).expect("dir");
        fs::write(&dir.join(SHARES_FILE), b"junk").expect("write");
        assert!(Shares::load(&dir).is_err());
    }

    #[test]
    fn two_devices_lists_are_merged_share_by_share() {
        let (alice, bob) = (person("Alice", 1), person("Bob", 2));
        let mut base = Shares::default();
        let first = base.offer(&alice, &[], "One", true, [2; ID_LEN], "Bob").expect("offer");
        let mut laptop = base.clone();
        let mut phone = base.clone();
        laptop.offer(&alice, &[], "Two.md", false, [2; ID_LEN], "Bob").expect("offer");
        phone.accepted(&first, [2; ID_LEN], &[[5; KEY_LEN]]).expect("accepted");
        let merged = merge(Some(&base.to_json()), &laptop.to_json(), &phone.to_json(), true).expect("merge");
        let merged = Shares::from_json(&merged).expect("list");
        assert_eq!(merged.list.len(), 2, "the new share from the laptop is kept");
        assert_eq!(merged.list[&first].state, State::Active, "the phone's change is kept");
        let _ = bob;
        assert!(merge(None, b"junk", &laptop.to_json(), true).is_none());
    }

    #[test]
    fn names_become_folder_names_that_work_everywhere() {
        assert_eq!(folder_name_for("Mila"), "Mila");
        assert_eq!(folder_name_for("a/b:c"), "a-b-c");
        assert_eq!(folder_name_for("..."), "Someone");
        assert_eq!(folder_name_for("CON"), "Someone");
    }

    #[test]
    fn a_moved_folder_takes_its_share_along() {
        let alice = person("Alice", 1);
        let mut shares = Shares::default();
        let id = shares.offer(&alice, &[], "School/Bio", true, [2; ID_LEN], "Bob").expect("offer");
        assert!(shares.moved("School", "Year 3"));
        assert_eq!(shares.list[&id].path, "Year 3/Bio");
        assert!(!shares.moved("Schoolbag", "x"));
        assert_eq!(shares.of_path("Year 3/Bio/a.md").map(|s| s.id), Some(id));
    }
}
