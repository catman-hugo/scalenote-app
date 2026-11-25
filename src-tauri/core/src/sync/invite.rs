//! Invitations to a share (0.6.4, slice 4): the only thing a device that is not paired may ask.
//!
//! The owner's device connects to a device of the person it heard nearby (discovery, people
//! note) over the same encrypted channel as sync, checks it is the device that was heard, and
//! sends one invitation. The receiving device keeps it as "invited" until its person answers.
//! The answer goes back the same way, to the device the invitation came from.
//!
//! Both messages come from devices that are not paired, so they are untrusted:
//! - one message, at most `MAX_BYTES`, plain JSON read into fixed fields; names are cleaned and
//!   the item must be a plain portable name (no folders, no `..`);
//! - an invitation is only taken by a device whose person has a name and is findable, or already
//!   shares something with the inviting person; it must be meant for that person's account;
//! - the device that sends it must be one of the keys the owner lists (it is added if missing:
//!   the encrypted channel proves the key, the list only names the owner's other devices);
//! - at most `MAX_PER_MINUTE` invitations and answers are taken per minute, and at most
//!   `MAX_WAITING` invitations wait for an answer at a time;
//! - an answer is only taken for a share this person owns, from a person invited to it, with the
//!   share's random id (only ever sent to the invited device, encrypted).
//! Nothing in either message is run or opened; no file is made until the share is synced.

use super::account::{clean_person_name, ID_LEN};
use super::hex;
use super::identity::KEY_LEN;
use super::shares::{Person, Share, State, MAX_KEYS};
use serde_json::{json, Value};
use std::collections::{BTreeMap, VecDeque};
use std::time::{Duration, Instant};

/// Sent by the owner's device: an invitation. Answered with `KIND_INVITE_OK` or refused.
pub const KIND_INVITE: u8 = 0x60;
/// Sent by the invited device: yes or no. Answered with `KIND_INVITE_OK` or refused.
pub const KIND_INVITE_ANSWER: u8 = 0x61;
pub const KIND_INVITE_OK: u8 = 0x62;
pub const MAX_BYTES: usize = 16 * 1024;
pub const MAX_PER_MINUTE: usize = 10;
pub const MAX_WAITING: usize = 20;

/// An invitation as it travels.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Invitation {
    pub id: [u8; ID_LEN],
    pub item: String,
    pub folder: bool,
    pub owner: [u8; ID_LEN],
    pub owner_name: String,
    /// The owner's devices (this one and its paired devices).
    pub keys: Vec<[u8; KEY_LEN]>,
    /// Whom it is for.
    pub to: [u8; ID_LEN],
    /// Where the owner's device listens, for the answer.
    pub port: u16,
}

/// An answer as it travels.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Answer {
    pub id: [u8; ID_LEN],
    pub account: [u8; ID_LEN],
    pub name: String,
    pub accept: bool,
    /// The answering person's devices.
    pub keys: Vec<[u8; KEY_LEN]>,
}

fn keys_to_json(keys: &[[u8; KEY_LEN]]) -> Vec<String> {
    keys.iter().take(MAX_KEYS).map(|k| hex::encode(k)).collect()
}

fn keys_from(value: &Value) -> Option<Vec<[u8; KEY_LEN]>> {
    let Value::Array(list) = value else { return None };
    if list.len() > MAX_KEYS {
        return None;
    }
    list.iter().map(|k| k.as_str().and_then(hex::decode::<KEY_LEN>)).collect()
}

fn id_from(value: Option<&Value>) -> Option<[u8; ID_LEN]> {
    value?.as_str().and_then(hex::decode::<ID_LEN>)
}

/// Reads one message's JSON object, within the size limit.
fn object(bytes: &[u8]) -> Option<serde_json::Map<String, Value>> {
    if bytes.len() > MAX_BYTES {
        return None;
    }
    match serde_json::from_slice::<Value>(bytes).ok()? {
        Value::Object(map) => Some(map),
        _ => None,
    }
}

impl Invitation {
    pub fn encode(&self) -> Vec<u8> {
        let value = json!({
            "id": hex::encode(&self.id),
            "item": self.item,
            "kind": if self.folder { "folder" } else { "page" },
            "owner": hex::encode(&self.owner),
            "owner_name": self.owner_name,
            "keys": keys_to_json(&self.keys),
            "to": hex::encode(&self.to),
            "port": self.port,
        });
        serde_json::to_vec(&value).unwrap_or_default()
    }

    pub fn decode(bytes: &[u8]) -> Option<Invitation> {
        let map = object(bytes)?;
        let item = map.get("item")?.as_str()?.to_string();
        let folder = match map.get("kind")?.as_str()? {
            "folder" => true,
            "page" => false,
            _ => return None,
        };
        if !super::shares::item_name_ok(&item) || (!folder && !item.ends_with(".md")) {
            return None;
        }
        let port = u16::try_from(map.get("port")?.as_u64()?).ok().filter(|p| *p != 0)?;
        Some(Invitation {
            id: id_from(map.get("id"))?,
            item,
            folder,
            owner: id_from(map.get("owner"))?,
            owner_name: clean_person_name(map.get("owner_name")?.as_str()?)?,
            keys: keys_from(map.get("keys")?)?,
            to: id_from(map.get("to"))?,
            port,
        })
    }

    /// The share record this invitation becomes on the invited device, with the sending device's
    /// key among the owner's. `me` is the invited person (account id and name).
    pub fn to_share(&self, sender: &[u8; KEY_LEN], me: ([u8; ID_LEN], &str)) -> Share {
        let mut keys = self.keys.clone();
        if !keys.contains(sender) {
            keys.truncate(MAX_KEYS - 1);
            keys.push(*sender);
        }
        let mut people = BTreeMap::new();
        people.insert(self.owner, Person { name: self.owner_name.clone(), keys });
        people.insert(me.0, Person { name: me.1.to_string(), keys: Vec::new() });
        Share { id: self.id, item: self.item.clone(), folder: self.folder, owner: self.owner, people, path: String::new(), state: State::Invited, told: true }
    }
}

impl Answer {
    pub fn encode(&self) -> Vec<u8> {
        let value = json!({
            "id": hex::encode(&self.id),
            "account": hex::encode(&self.account),
            "name": self.name,
            "accept": self.accept,
            "keys": keys_to_json(&self.keys),
        });
        serde_json::to_vec(&value).unwrap_or_default()
    }

    pub fn decode(bytes: &[u8]) -> Option<Answer> {
        let map = object(bytes)?;
        Some(Answer {
            id: id_from(map.get("id"))?,
            account: id_from(map.get("account"))?,
            name: clean_person_name(map.get("name")?.as_str()?)?,
            accept: map.get("accept")?.as_bool()?,
            keys: keys_from(map.get("keys")?)?,
        })
    }
}

/// Counts invitations and answers from devices that are not paired, to refuse a flood.
#[derive(Default)]
pub struct Limiter {
    recent: VecDeque<Instant>,
}

impl Limiter {
    /// Whether one more may be taken now (and counts it if so).
    pub fn take(&mut self, now: Instant) -> bool {
        while self.recent.front().is_some_and(|t| now.duration_since(*t) > Duration::from_secs(60)) {
            self.recent.pop_front();
        }
        if self.recent.len() >= MAX_PER_MINUTE {
            return false;
        }
        self.recent.push_back(now);
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn invitation() -> Invitation {
        Invitation { id: [3; ID_LEN], item: "Biology".to_string(), folder: true, owner: [1; ID_LEN], owner_name: "Rowan".to_string(), keys: vec![[7; KEY_LEN]], to: [2; ID_LEN], port: 47821 }
    }

    #[test]
    fn messages_read_back_the_same() {
        let sent = invitation();
        assert_eq!(Invitation::decode(&sent.encode()), Some(sent));
        let answer = Answer { id: [3; ID_LEN], account: [2; ID_LEN], name: "Mila".to_string(), accept: true, keys: vec![[8; KEY_LEN]] };
        assert_eq!(Answer::decode(&answer.encode()), Some(answer));
    }

    #[test]
    fn bad_invitations_are_refused() {
        let good = String::from_utf8(invitation().encode()).expect("text");
        for (from, to) in [
            ("\"Biology\"", "\"../etc\""),
            ("\"Biology\"", "\"a/b\""),
            ("\"Biology\"", "\".hidden\""),
            ("\"folder\"", "\"page\""), // a page must end in .md
            ("\"folder\"", "\"script\""),
            ("\"Rowan\"", "\"   \""),
            ("47821", "0"),
            ("47821", "70000"),
            ("\"0303", "\"zz03"),
        ] {
            let bad = good.replacen(from, to, 1);
            assert_ne!(bad, good, "{from} not in the message");
            assert!(Invitation::decode(bad.as_bytes()).is_none(), "{bad}");
        }
        assert!(Invitation::decode(b"not json").is_none());
        assert!(Invitation::decode(&vec![b' '; MAX_BYTES + 1]).is_none());
        let many_keys = invitation();
        let mut text: Value = serde_json::from_slice(&many_keys.encode()).expect("json");
        text["keys"] = json!(vec![hex::encode(&[9u8; KEY_LEN]); MAX_KEYS + 1]);
        assert!(Invitation::decode(&serde_json::to_vec(&text).expect("bytes")).is_none());
    }

    #[test]
    fn the_sending_device_is_always_one_of_the_owners_devices() {
        let share = invitation().to_share(&[9; KEY_LEN], ([2; ID_LEN], "Mila"));
        assert_eq!(share.people[&[1; ID_LEN]].keys, vec![[7; KEY_LEN], [9; KEY_LEN]]);
        assert_eq!(share.state, State::Invited);
    }

    #[test]
    fn a_flood_is_cut_off_and_allowed_again_after_a_minute() {
        let mut limiter = Limiter::default();
        let start = Instant::now();
        for _ in 0..MAX_PER_MINUTE {
            assert!(limiter.take(start));
        }
        assert!(!limiter.take(start));
        assert!(limiter.take(start + Duration::from_secs(61)));
    }
}
