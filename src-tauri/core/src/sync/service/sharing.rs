//! Sharing with other people, the network side (0.6.4, slice 4): sending an invitation to a
//! person heard nearby, taking one from a device that is not paired, and the answer both ways.
//! What is checked on each untrusted message is listed in invite.rs.

use super::super::account::ID_LEN;
use super::super::channel::Channel;
use super::super::identity::KEY_LEN;
use super::super::engine::{Outcome, Pair};
use super::super::invite::{Answer, Invitation, KIND_INVITE, KIND_INVITE_ANSWER, KIND_INVITE_OK, KIND_SHARE_OPEN, MAX_WAITING};
use super::super::space::ShareMap;
use super::super::shares::{Share, Shares, State, MAX_KEYS};
use super::super::{Result, SyncError};
use super::{connect_to, lock, record, record_changed, EventKind, Service, Shared, IO_TIMEOUT, KIND_REFUSED};
use std::net::{IpAddr, TcpStream};
use std::path::PathBuf;
use std::sync::atomic::Ordering;
use std::time::Instant;

/// The notes folder open now, where the list of shares is.
fn vault(shared: &Shared) -> Result<PathBuf> {
    lock(&shared.state).vault.clone().ok_or(SyncError::Refused("no notes folder"))
}

/// This person's devices as far as this device knows: itself and its paired devices.
fn own_keys(shared: &Shared) -> Vec<[u8; KEY_LEN]> {
    let state = lock(&shared.state);
    let mut keys = vec![*shared.identity.public()];
    keys.extend(state.trust.peers().iter().map(|p| p.public).filter(|k| k != shared.identity.public()));
    keys.truncate(MAX_KEYS);
    keys
}

/// Opens an encrypted connection to `address` and checks the device there is one of `keys`.
fn open_to(shared: &Shared, address: &str, keys: &[[u8; KEY_LEN]]) -> Result<Channel<TcpStream>> {
    let stream = connect_to(address)?;
    stream.set_read_timeout(Some(IO_TIMEOUT))?;
    stream.set_write_timeout(Some(IO_TIMEOUT))?;
    let channel = Channel::connect(stream, &shared.identity)?;
    if !keys.contains(channel.remote()) {
        return Err(SyncError::Refused("not the device that was heard"));
    }
    Ok(channel)
}

/// Sends one message and waits for the OK.
fn ask(channel: &mut Channel<TcpStream>, kind: u8, body: &[u8]) -> Result<()> {
    let mut message = vec![kind];
    message.extend_from_slice(body);
    channel.send(&message)?;
    match channel.recv()?.first().copied() {
        Some(KIND_INVITE_OK) => Ok(()),
        _ => Err(SyncError::Refused("not taken")),
    }
}

/// Says no to an untrusted message, notes it in the recent events, and gives the reason.
fn refuse(shared: &Shared, channel: &mut Channel<TcpStream>, reason: &'static str) -> Result<()> {
    let _ = channel.send(&[KIND_REFUSED]);
    record(&mut lock(&shared.state), EventKind::Refused, "");
    Err(SyncError::Refused(reason))
}

/// Reads, changes and saves the list of shares under the shares lock.
fn change_shares<T>(shared: &Shared, change: impl FnOnce(&mut Shares, &std::path::Path) -> Result<T>) -> Result<T> {
    let root = vault(shared)?;
    let _guard = lock(&shared.shares);
    let mut shares = Shares::load(&root)?;
    let result = change(&mut shares, &root)?;
    shares.save(&root)?;
    Ok(result)
}

impl Service {
    /// The list of shares of the notes folder open now.
    pub fn shares(&self) -> Result<Shares> {
        let root = vault(&self.shared)?;
        let _guard = lock(&self.shared.shares);
        Shares::load(&root)
    }

    /// Shares a page (`….md`) or folder with a person heard by `people_nearby`: the share is
    /// written as offered, then the invitation is sent to that person's device. If it cannot be
    /// delivered, the person is taken out again and the reason is returned.
    pub fn share_with(&self, path: &str, folder: bool, person: &[u8; ID_LEN]) -> Result<[u8; ID_LEN]> {
        let shared = &self.shared;
        let (account, heard) = {
            let state = lock(&shared.state);
            (state.account.clone(), state.heard.get(person).cloned())
        };
        let heard = heard.ok_or(SyncError::Refused("person not nearby"))?;
        let keys = own_keys(shared);
        let id = change_shares(shared, |shares, _| shares.offer(&account, &keys, path, folder, heard.account, &heard.name))?;
        let item = path.rsplit('/').next().unwrap_or(path).to_string();
        let owner = account.id.ok_or(SyncError::Refused("name is empty"))?;
        let port = shared.port.load(Ordering::Relaxed);
        let invitation = Invitation { id, item, folder, owner, owner_name: account.name.clone(), keys, to: heard.account, port };
        let sent = open_to(shared, &heard.address, &[heard.key]).and_then(|mut channel| ask(&mut channel, KIND_INVITE, &invitation.encode()));
        if let Err(error) = sent {
            change_shares(shared, |shares, _| {
                shares.withdraw(&id, &heard.account);
                Ok(())
            })?;
            return Err(error);
        }
        Ok(id)
    }

    /// This person's answer to an invitation. Saved here first; then the owner's device is told.
    /// Returns whether it could be told now (if not, `tell_owners` tries again later).
    pub fn answer_invitation(&self, id: &[u8; ID_LEN], accept: bool) -> Result<bool> {
        let account = lock(&self.shared.state).account.clone();
        let keys = own_keys(&self.shared);
        change_shares(&self.shared, |shares, _| shares.answer(id, accept, &account, &keys).map(|_| ()))?;
        Ok(self.tell_owner(id))
    }

    /// Sends the answers the owners' devices have not heard yet. Returns how many arrived.
    pub fn tell_owners(&self) -> usize {
        let waiting: Vec<[u8; ID_LEN]> = match self.shares() {
            Ok(shares) => shares.list.values().filter(|s| !s.told).map(|s| s.id).collect(),
            Err(_) => return 0,
        };
        waiting.iter().filter(|id| self.tell_owner(id)).count()
    }

    /// Tells the owner's device the answer saved for share `id`, and notes that it was told.
    fn tell_owner(&self, id: &[u8; ID_LEN]) -> bool {
        let shared = &self.shared;
        let Ok(shares) = self.shares() else { return false };
        let Some(share) = shares.list.get(id) else { return false };
        let account = lock(&shared.state).account.clone();
        let (Some(me), Some(address)) = (account.id, lock(&shared.state).invited_from.get(id).cloned()) else { return false };
        let owner_keys = share.people.get(&share.owner).map(|p| p.keys.clone()).unwrap_or_default();
        let answer = Answer { id: *id, account: me, name: account.name, accept: share.state == State::Active, keys: own_keys(shared) };
        let told = open_to(shared, &address, &owner_keys).and_then(|mut channel| ask(&mut channel, KIND_INVITE_ANSWER, &answer.encode())).is_ok();
        if told {
            let _ = change_shares(shared, |shares, _| {
                shares.mark_told(id);
                Ok(())
            });
        }
        told
    }

    /// Stops sharing (owner) or leaves a share (member). Every copy stays where it is.
    pub fn end_share(&self, id: &[u8; ID_LEN]) -> Result<()> {
        let account = lock(&self.shared.state).account.clone();
        change_shares(&self.shared, |shares, _| shares.end(id, &account))
    }
}

/// Whether one more message from a device that is not paired may be taken now.
fn within_limits(shared: &Shared) -> bool {
    lock(&shared.state).limiter.take(Instant::now())
}

/// An invitation from another person's device (see invite.rs for every check).
pub(super) fn take_invitation(shared: &Shared, channel: &mut Channel<TcpStream>, body: &[u8], from_ip: Option<IpAddr>) -> Result<()> {
    if !within_limits(shared) {
        return refuse(shared, channel, "too many invitations");
    }
    let Some(invitation) = Invitation::decode(body) else { return refuse(shared, channel, "invitation") };
    let account = lock(&shared.state).account.clone();
    let (Some(me), Some(ip)) = (account.id.filter(|_| account.is_set()), from_ip) else { return refuse(shared, channel, "no name") };
    if invitation.to != me || invitation.owner == me {
        return refuse(shared, channel, "not for this person");
    }
    let sender = *channel.remote();
    let taken = change_shares(shared, |shares, root| {
        let knows_them = shares.list.values().any(|s| s.owner == invitation.owner && s.state == State::Active);
        if !account.findable && !knows_them {
            return Err(SyncError::Refused("not findable"));
        }
        if !shares.list.contains_key(&invitation.id) && shares.waiting() >= MAX_WAITING {
            return Err(SyncError::Refused("too many invitations"));
        }
        let share: Share = invitation.to_share(&sender, (me, &account.name));
        shares.receive(share, &|path| root.join(path).exists())
    });
    if let Err(SyncError::Refused(reason)) = taken {
        return refuse(shared, channel, reason);
    }
    taken?;
    lock(&shared.state).invited_from.insert(invitation.id, std::net::SocketAddr::new(ip, invitation.port).to_string());
    channel.send(&[KIND_INVITE_OK])
}

/// A person's answer to an invitation this person sent.
pub(super) fn take_answer(shared: &Shared, channel: &mut Channel<TcpStream>, body: &[u8]) -> Result<()> {
    if !within_limits(shared) {
        return refuse(shared, channel, "too many answers");
    }
    let Some(answer) = Answer::decode(body) else { return refuse(shared, channel, "answer") };
    let me = lock(&shared.state).account.id;
    let sender = *channel.remote();
    let taken = change_shares(shared, |shares, _| {
        let share = shares.list.get(&answer.id).ok_or(SyncError::Refused("no such share"))?;
        if Some(share.owner) != me || answer.account == share.owner || !share.people.contains_key(&answer.account) {
            return Err(SyncError::Refused("not invited"));
        }
        if answer.accept {
            let mut keys = answer.keys.clone();
            if !keys.contains(&sender) {
                keys.truncate(MAX_KEYS - 1);
                keys.push(sender);
            }
            shares.accepted(&answer.id, answer.account, &keys)
        } else {
            shares.withdraw(&answer.id, &answer.account);
            Ok(())
        }
    });
    if let Err(SyncError::Refused(reason)) = taken {
        return refuse(shared, channel, reason);
    }
    taken?;
    channel.send(&[KIND_INVITE_OK])
}

/// What one share sync did with one person's device.
pub struct ShareResult {
    pub person: String,
    pub outcome: std::result::Result<super::super::engine::Report, &'static str>,
}

impl Service {
    /// Syncs share `id` with one reachable device of each other person in it. People whose
    /// devices cannot be reached now are left for later (their result says so).
    pub fn sync_share(&self, id: &[u8; ID_LEN]) -> Result<Vec<ShareResult>> {
        let shared = &self.shared;
        let share = self.shares()?.list.get(id).cloned().ok_or(SyncError::Refused("no such share"))?;
        if share.state != State::Active {
            return Err(SyncError::Refused("share not active"));
        }
        let account = lock(&shared.state).account.clone();
        let me = account.id.ok_or(SyncError::Refused("name is empty"))?;
        let root = vault(shared)?;
        let others: Vec<(String, Vec<[u8; KEY_LEN]>)> = share.people.iter().filter(|(who, _)| **who != me).map(|(_, p)| (p.name.clone(), p.keys.clone())).collect();
        let addresses = self.share_device_addresses(&share);
        let mut results = Vec::new();
        for (person, keys) in others {
            let candidates: Vec<(&[u8; KEY_LEN], &String)> = keys.iter().filter_map(|k| addresses.get(k).map(|a| (k, a))).collect();
            let mut outcome = Err("not reachable");
            for (key, address) in candidates {
                match self.sync_share_with(&share, &root, &account.name, &person, key, address) {
                    Ok(report) => {
                        outcome = Ok(report);
                        break;
                    }
                    Err(error) => outcome = Err(error.code()),
                }
            }
            results.push(ShareResult { person, outcome });
        }
        Ok(results)
    }

    /// Where the devices of this share's people can be reached: those heard on the network now,
    /// and those reached or heard before.
    fn share_device_addresses(&self, share: &Share) -> std::collections::HashMap<[u8; KEY_LEN], String> {
        let shared = &self.shared;
        let mut found: std::collections::HashMap<[u8; KEY_LEN], String> = std::collections::HashMap::new();
        {
            let state = lock(&shared.state);
            found.extend(state.share_addresses.iter().map(|(k, a)| (*k, a.clone())));
            for person in state.heard.values() {
                found.insert(person.key, person.address.clone());
            }
            if let Some(address) = state.invited_from.get(&share.id) {
                if let Some(owner) = share.people.get(&share.owner) {
                    for key in &owner.keys {
                        found.entry(*key).or_insert_with(|| address.clone());
                    }
                }
            }
        }
        let route = lock(&shared.route).clone();
        if let Ok(heard) = super::discovery::find(&route, super::SHARE_LOOK, shared.identity.public()) {
            for device in heard {
                found.insert(device.key, device.address);
            }
        }
        found
    }

    /// One share sync with one device of another person.
    fn sync_share_with(&self, share: &Share, root: &std::path::Path, own_name: &str, person: &str, key: &[u8; KEY_LEN], address: &str) -> Result<super::super::engine::Report> {
        let shared = &self.shared;
        let _session = self.take_session()?;
        let mut channel = open_to(shared, address, &[*key])?;
        channel.stream().set_read_timeout(Some(super::SYNC_TIMEOUT))?;
        channel.stream().set_write_timeout(Some(super::SYNC_TIMEOUT))?;
        let mut open = vec![KIND_SHARE_OPEN];
        open.extend_from_slice(&share.id);
        channel.send(&open)?;
        if channel.recv()?.first() != Some(&KIND_INVITE_OK) {
            return Err(SyncError::Refused("share refused"));
        }
        lock(&shared.state).share_addresses.insert(*key, address.to_string());
        let scan = super::super::manifest::Manifest::scan(root)?.manifest;
        let map = ShareMap::new(share, root, &scan);
        let today = super::today();
        let pair = Pair { root, peer_key: key, own_name, peer_name: person, today: &today, shares: false, map: Some(&map) };
        let outcome = super::super::engine::run(&mut channel, &pair, true, &mut |_| {});
        let mut state = lock(&shared.state);
        match outcome {
            Ok(Outcome::Done(report)) => {
                record_changed(&mut state, EventKind::Synced, person, report.changed());
                Ok(report)
            }
            Ok(Outcome::NeedsApproval(_)) => Err(SyncError::Refused("share refused")),
            Err(error) => {
                record(&mut state, EventKind::SyncFailed, person);
                Err(error)
            }
        }
    }

    /// Syncs every active share. For the automatic rounds.
    pub fn sync_shares(&self) -> Vec<ShareResult> {
        let ids: Vec<[u8; ID_LEN]> = match self.shares() {
            Ok(shares) => shares.list.values().filter(|s| s.state == State::Active).map(|s| s.id).collect(),
            Err(_) => return Vec::new(),
        };
        ids.iter().filter_map(|id| self.sync_share(id).ok()).flatten().collect()
    }
}

/// The answering side of a share sync: only for a device of a person in that active share, and
/// then only that share's files.
pub(super) fn serve_share(shared: &Shared, channel: &mut Channel<TcpStream>, body: &[u8]) -> Result<()> {
    let Ok(id) = <[u8; ID_LEN]>::try_from(body) else { return refuse(shared, channel, "share") };
    let remote = *channel.remote();
    let (root, allowed) = {
        let state = lock(&shared.state);
        (state.vault.clone(), state.enabled && !state.paused)
    };
    let Some(root) = root else { return refuse(shared, channel, "no notes folder") };
    let share = {
        let _guard = lock(&shared.shares);
        Shares::load(&root).ok().and_then(|s| s.list.get(&id).cloned())
    };
    let Some(share) = share.filter(|s| s.allows(&remote)) else { return refuse(shared, channel, "not in the share") };
    if !allowed {
        return refuse(shared, channel, "sync is paused");
    }
    let guard = match shared.session.try_lock() {
        Ok(guard) => guard,
        Err(std::sync::TryLockError::Poisoned(poisoned)) => poisoned.into_inner(),
        Err(std::sync::TryLockError::WouldBlock) => {
            let _ = channel.send(&[super::KIND_NO]);
            return Err(SyncError::Refused("sync is busy"));
        }
    };
    channel.stream().set_read_timeout(Some(super::SYNC_TIMEOUT))?;
    channel.stream().set_write_timeout(Some(super::SYNC_TIMEOUT))?;
    channel.send(&[KIND_INVITE_OK])?;
    let scan = super::super::manifest::Manifest::scan(&root)?.manifest;
    let map = ShareMap::new(&share, &root, &scan);
    let first = channel.recv()?;
    let person = share.people.iter().find(|(_, p)| p.keys.contains(&remote)).map(|(_, p)| p.name.clone()).unwrap_or_default();
    let (own_name, today) = (lock(&shared.state).account.name.clone(), super::today());
    let pair = Pair { root: &root, peer_key: &remote, own_name: &own_name, peer_name: &person, today: &today, shares: false, map: Some(&map) };
    let keep = |said: &super::super::manifest::Manifest| super::super::engine::keep_share_base(&pair, said);
    let result = super::super::exchange::serve(channel, first, &root, true, super::super::exchange::Scope::Share(&map, &keep));
    drop(guard);
    let mut state = lock(&shared.state);
    match &result {
        Ok(changed) => record_changed(&mut state, EventKind::Synced, &person, *changed),
        Err(_) => record(&mut state, EventKind::SyncFailed, &person),
    }
    result.map(|_| ())
}
