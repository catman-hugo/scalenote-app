//! Pairing two devices with a one-time code.
//!
//! One device (the host) shows an 8-digit code; the person types it on the other (the joiner).
//! The code is short, so it must not be possible to try many guesses, and it must not be
//! possible to learn it by listening. Two things make that so:
//!
//! 1. SPAKE2 (a password-authenticated key exchange): both devices turn the code into a shared
//!    key without sending the code or anything that can be tested against guesses offline. A
//!    wrong guess only shows itself as a key that does not match, and each connection can try
//!    exactly one code.
//! 2. The code is one-shot: three connection attempts, or two minutes, whichever comes first,
//!    and then the host stops accepting it. A guess has a 1 in 100 million chance, so an
//!    attacker on the same network gets about a 3 in 100 million chance per code shown.
//!
//! After the key is shared, each device sends a confirmation tag (HMAC) over both devices'
//! public keys and its own name, made with that key. So a device in the middle that relays
//! two separate connections ends up with different keys on each side and the tags do not
//! match. Only when both tags are right does each side add the other to its trust list.

use super::channel::Channel;
use super::device::clean_name;
use super::identity::KEY_LEN;
use super::trust::Peer;
use super::{Result, SyncError};
use hmac::{Hmac, Mac};
use sha2::Sha256;
use spake2::{Ed25519Group, Identity as SpakeIdentity, Password, Spake2};
use std::io::{Read, Write};
use std::time::{Duration, Instant};

pub const CODE_DIGITS: usize = 8;
pub const MAX_ATTEMPTS: u8 = 3;
pub const CODE_LIFETIME: Duration = Duration::from_secs(120);

/// The first byte of the first pairing message; the service uses it to recognise a pairing.
pub const KIND_START: u8 = 1;
const KIND_REPLY: u8 = 2;
const KIND_CONFIRM: u8 = 3;
const KIND_CONFIRMED: u8 = 4;
pub const KIND_REFUSED: u8 = 0xFF;
const SPAKE_MESSAGE_LEN: usize = 33;
const TAG_LEN: usize = 32;
const JOINER_ID: &[u8] = b"scalenote-pairing-1 joiner";
const HOST_ID: &[u8] = b"scalenote-pairing-1 host";

type HmacSha256 = Hmac<Sha256>;

/// The code the host shows and still accepts. Lives in memory only; it is never written down.
pub struct PairingOffer {
    code: String,
    opened: Instant,
    attempts_left: u8,
}

/// The host's side of the one-time code: at most one code is open at a time.
pub struct CodeBook {
    offer: Option<PairingOffer>,
    lifetime: Duration,
}

impl Default for CodeBook {
    fn default() -> Self {
        CodeBook { offer: None, lifetime: CODE_LIFETIME }
    }
}

/// A fresh code of `CODE_DIGITS` digits from the system's random numbers.
pub fn new_code() -> Result<String> {
    let mut bytes = [0u8; 8];
    getrandom::fill(&mut bytes).map_err(|_| SyncError::Damaged("no random numbers available"))?;
    let modulus = 10u64.pow(CODE_DIGITS as u32);
    // 2^64 is not a multiple of 10^8, but the leftover is about 1 in 10^11: far below anything
    // that helps a guess.
    Ok(format!("{:0width$}", u64::from_le_bytes(bytes) % modulus, width = CODE_DIGITS))
}

/// Takes what a person typed ("1234 5678", "1234-5678") and returns the 8 digits, or `None`.
pub fn clean_code(typed: &str) -> Option<String> {
    let digits: String = typed.chars().filter(|c| !c.is_whitespace() && *c != '-').collect();
    (digits.len() == CODE_DIGITS && digits.bytes().all(|b| b.is_ascii_digit())).then_some(digits)
}

impl CodeBook {
    /// Opens a new code (any earlier one stops working) and returns it for showing.
    pub fn open(&mut self, now: Instant) -> Result<String> {
        let code = new_code()?;
        self.offer = Some(PairingOffer { code: code.clone(), opened: now, attempts_left: MAX_ATTEMPTS });
        Ok(code)
    }

    /// A shorter life, for tests only.
    #[cfg(test)]
    pub(crate) fn set_lifetime(&mut self, lifetime: Duration) {
        self.lifetime = lifetime;
    }

    pub fn close(&mut self) {
        self.offer = None;
    }

    /// Seconds the open code is still good for.
    pub fn seconds_left(&self, now: Instant) -> Option<u64> {
        let offer = self.offer.as_ref()?;
        self.lifetime.checked_sub(now.duration_since(offer.opened)).map(|left| left.as_secs())
    }

    /// Whether a code is open and still good.
    pub fn is_open(&self, now: Instant) -> bool {
        self.offer.as_ref().is_some_and(|o| o.attempts_left > 0 && now.duration_since(o.opened) < self.lifetime)
    }

    /// Uses up one attempt and returns the code to check against, or `None` when no code is
    /// open, it is too old or its attempts are used up. The attempt is counted BEFORE the
    /// check, so a connection that is cut halfway still costs one.
    pub fn take_attempt(&mut self, now: Instant) -> Option<String> {
        if !self.is_open(now) {
            self.offer = None;
            return None;
        }
        let offer = self.offer.as_mut()?;
        offer.attempts_left -= 1;
        Some(offer.code.clone())
    }
}

fn tag(key: &[u8], label: &[u8], first: &[u8; KEY_LEN], second: &[u8; KEY_LEN], name: &str) -> Result<HmacSha256> {
    let mut mac = HmacSha256::new_from_slice(key).map_err(|_| SyncError::Channel("tag key"))?;
    mac.update(label);
    mac.update(first);
    mac.update(second);
    mac.update(name.as_bytes());
    Ok(mac)
}

/// A confirmation message: kind, 32-byte tag, then the sender's name.
fn confirmation(kind: u8, key: &[u8], label: &[u8], first: &[u8; KEY_LEN], second: &[u8; KEY_LEN], name: &str) -> Result<Vec<u8>> {
    let mut out = vec![kind];
    out.extend_from_slice(&tag(key, label, first, second, name)?.finalize().into_bytes());
    out.extend_from_slice(name.as_bytes());
    Ok(out)
}

/// Checks a confirmation message; returns the sender's cleaned name when the tag is right.
fn check_confirmation(message: &[u8], kind: u8, key: &[u8], label: &[u8], first: &[u8; KEY_LEN], second: &[u8; KEY_LEN]) -> Result<String> {
    if message.len() < 1 + TAG_LEN || message[0] != kind {
        return Err(SyncError::Refused("unexpected message"));
    }
    let name = std::str::from_utf8(&message[1 + TAG_LEN..]).map_err(|_| SyncError::Refused("name"))?;
    // The name is part of what the tag covers, so it has to arrive exactly as sent.
    if clean_name(name) != name {
        return Err(SyncError::Refused("name"));
    }
    tag(key, label, first, second, name)?.verify_slice(&message[1..1 + TAG_LEN]).map_err(|_| SyncError::Refused("code not accepted"))?;
    Ok(name.to_string())
}

/// The host's half. `code` is what `CodeBook::take_attempt` returned (`None`: refuse at once).
/// Returns the new trusted device; the caller adds it to the trust list and closes the code.
pub fn host<S: Read + Write>(channel: &mut Channel<S>, code: Option<&str>, own_name: &str, today: &str) -> Result<Peer> {
    let start = channel.recv()?;
    host_from(channel, start, code, own_name, today)
}

/// The same, for a caller that has already read the first message (the service does, to tell a
/// pairing from other requests).
pub fn host_from<S: Read + Write>(channel: &mut Channel<S>, start: Vec<u8>, code: Option<&str>, own_name: &str, today: &str) -> Result<Peer> {
    let Some(code) = code else {
        let _ = channel.send(&[KIND_REFUSED]);
        return Err(SyncError::Refused("no open code"));
    };
    if start.len() != 1 + SPAKE_MESSAGE_LEN || start[0] != KIND_START {
        return Err(SyncError::Refused("unexpected message"));
    }
    let (state, reply) = Spake2::<Ed25519Group>::start_b(&Password::new(code.as_bytes()), &SpakeIdentity::new(JOINER_ID), &SpakeIdentity::new(HOST_ID));
    let mut message = vec![KIND_REPLY];
    message.extend_from_slice(&reply);
    channel.send(&message)?;
    let key = state.finish(&start[1..]).map_err(|_| SyncError::Refused("code not accepted"))?;
    let joiner_key = *channel.remote();
    let own_key = own_public(channel)?;
    let joiner_name = match check_confirmation(&channel.recv()?, KIND_CONFIRM, &key, b"joiner", &joiner_key, &own_key) {
        Ok(name) => name,
        Err(error) => {
            let _ = channel.send(&[KIND_REFUSED]);
            return Err(error);
        }
    };
    channel.send(&confirmation(KIND_CONFIRMED, &key, b"host", &own_key, &joiner_key, own_name)?)?;
    Ok(Peer { name: joiner_name, public: joiner_key, added: today.to_string() })
}

/// The joiner's half: `code` is what the person typed (already cleaned).
pub fn join<S: Read + Write>(channel: &mut Channel<S>, code: &str, own_name: &str, today: &str) -> Result<Peer> {
    let (state, first) = Spake2::<Ed25519Group>::start_a(&Password::new(code.as_bytes()), &SpakeIdentity::new(JOINER_ID), &SpakeIdentity::new(HOST_ID));
    let mut message = vec![KIND_START];
    message.extend_from_slice(&first);
    channel.send(&message)?;
    let reply = channel.recv()?;
    if reply == [KIND_REFUSED] {
        return Err(SyncError::Refused("the other device is not waiting for a code"));
    }
    if reply.len() != 1 + SPAKE_MESSAGE_LEN || reply[0] != KIND_REPLY {
        return Err(SyncError::Refused("unexpected message"));
    }
    let key = state.finish(&reply[1..]).map_err(|_| SyncError::Refused("code not accepted"))?;
    let host_key = *channel.remote();
    let own_key = own_public(channel)?;
    channel.send(&confirmation(KIND_CONFIRM, &key, b"joiner", &own_key, &host_key, own_name)?)?;
    let answer = channel.recv()?;
    if answer == [KIND_REFUSED] {
        return Err(SyncError::Refused("code not accepted"));
    }
    let host_name = check_confirmation(&answer, KIND_CONFIRMED, &key, b"host", &host_key, &own_key)?;
    Ok(Peer { name: host_name, public: host_key, added: today.to_string() })
}

// The channel knows the other side's key; this side's own key is kept next to it.
fn own_public<S: Read + Write>(channel: &Channel<S>) -> Result<[u8; KEY_LEN]> {
    Ok(*channel.local())
}
