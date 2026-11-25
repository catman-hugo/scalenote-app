//! Sharing with other people, the network side (0.6.4, slice 4): sending an invitation to a
//! person heard nearby, taking one from a device that is not paired, and the answer both ways.
//! What is checked on each untrusted message is listed in invite.rs.

use super::super::account::ID_LEN;
use super::super::channel::Channel;
use super::super::identity::KEY_LEN;
use super::super::invite::{Answer, Invitation, KIND_INVITE, KIND_INVITE_ANSWER, KIND_INVITE_OK, MAX_WAITING};
use super::super::shares::{Share, Shares, State, MAX_KEYS};
use super::super::{Result, SyncError};
use super::{connect_to, lock, record, EventKind, Service, Shared, IO_TIMEOUT, KIND_REFUSED};
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
