//! The encrypted connection between two devices.
//!
//! It is the Noise protocol (snow), pattern XX: both devices prove they hold their private key,
//! each learns the other's public key, and everything after that is encrypted and checked. This
//! module does NOT decide who is trusted: it only hands the other device's public key to the
//! caller, who looks it up in the trust list (see service.rs). Pairing is the one exchange that
//! is allowed with a device that is not trusted yet.
//!
//! On the wire every message is a 2-byte length followed by that many bytes. Nothing larger
//! than one Noise message (65,535 bytes) is ever read, and a message that is not exactly what
//! the protocol expects ends the connection.

use super::identity::{Identity, KEY_LEN, NOISE_PARAMS};
use super::{Result, SyncError};
use snow::{Builder, TransportState};
use std::io::{Read, Write};

/// Plaintext bytes in one message. Noise adds a 16-byte tag and allows 65,535 in all.
pub const MAX_MESSAGE: usize = 60_000;
/// The three handshake messages are about 32, 96 and 64 bytes; anything much bigger is not ours.
const MAX_HANDSHAKE: usize = 512;

pub struct Channel<S: Read + Write> {
    stream: S,
    transport: TransportState,
    remote: [u8; KEY_LEN],
    local: [u8; KEY_LEN],
}

fn write_frame<S: Write>(stream: &mut S, bytes: &[u8]) -> Result<()> {
    let length = u16::try_from(bytes.len()).map_err(|_| SyncError::Channel("message too long"))?;
    // One write for the length and the bytes: two small writes in a row make a network wait for
    // the first to be acknowledged (a delay of tens of milliseconds for every message).
    let mut frame = Vec::with_capacity(bytes.len() + 2);
    frame.extend_from_slice(&length.to_be_bytes());
    frame.extend_from_slice(bytes);
    stream.write_all(&frame)?;
    stream.flush()?;
    Ok(())
}

fn read_frame<S: Read>(stream: &mut S, limit: usize) -> Result<Vec<u8>> {
    let mut length = [0u8; 2];
    stream.read_exact(&mut length)?;
    let length = u16::from_be_bytes(length) as usize;
    if length > limit {
        return Err(SyncError::Channel("message too long"));
    }
    let mut bytes = vec![0u8; length];
    stream.read_exact(&mut bytes)?;
    Ok(bytes)
}

impl<S: Read + Write> Channel<S> {
    /// Starts the connection from this side (the one that called the other device).
    pub fn connect(stream: S, identity: &Identity) -> Result<Channel<S>> {
        Channel::handshake(stream, identity, true)
    }

    /// Answers a connection that another device started.
    pub fn accept(stream: S, identity: &Identity) -> Result<Channel<S>> {
        Channel::handshake(stream, identity, false)
    }

    fn handshake(mut stream: S, identity: &Identity, initiator: bool) -> Result<Channel<S>> {
        let params = NOISE_PARAMS.parse().map_err(|_| SyncError::Channel("noise recipe"))?;
        let builder = Builder::new(params).local_private_key(identity.private()).map_err(|_| SyncError::Channel("own key"))?;
        let mut state = if initiator { builder.build_initiator() } else { builder.build_responder() }.map_err(|_| SyncError::Channel("handshake start"))?;
        let mut buffer = [0u8; MAX_HANDSHAKE];
        while !state.is_handshake_finished() {
            if state.is_my_turn() {
                let length = state.write_message(&[], &mut buffer).map_err(|_| SyncError::Channel("handshake write"))?;
                write_frame(&mut stream, &buffer[..length])?;
            } else {
                let message = read_frame(&mut stream, MAX_HANDSHAKE)?;
                let mut payload = [0u8; MAX_HANDSHAKE];
                // The handshake carries no payload, so anything that decrypts to one is wrong.
                let length = state.read_message(&message, &mut payload).map_err(|_| SyncError::Channel("handshake failed"))?;
                if length != 0 {
                    return Err(SyncError::Channel("handshake payload"));
                }
            }
        }
        let remote: [u8; KEY_LEN] = state.get_remote_static().and_then(|k| k.try_into().ok()).ok_or(SyncError::Channel("no remote key"))?;
        let transport = state.into_transport_mode().map_err(|_| SyncError::Channel("transport"))?;
        Ok(Channel { stream, transport, remote, local: *identity.public() })
    }

    /// The other device's public key, proven by the handshake.
    pub fn remote(&self) -> &[u8; KEY_LEN] {
        &self.remote
    }

    /// This device's own public key.
    pub fn local(&self) -> &[u8; KEY_LEN] {
        &self.local
    }

    pub fn send(&mut self, data: &[u8]) -> Result<()> {
        if data.len() > MAX_MESSAGE {
            return Err(SyncError::Channel("message too long"));
        }
        let mut buffer = vec![0u8; data.len() + 16];
        let length = self.transport.write_message(data, &mut buffer).map_err(|_| SyncError::Channel("encrypt"))?;
        write_frame(&mut self.stream, &buffer[..length])
    }

    pub fn recv(&mut self) -> Result<Vec<u8>> {
        let message = read_frame(&mut self.stream, MAX_MESSAGE + 16)?;
        let mut payload = vec![0u8; message.len()];
        let length = self.transport.read_message(&message, &mut payload).map_err(|_| SyncError::Channel("decrypt"))?;
        payload.truncate(length);
        Ok(payload)
    }

    /// Gives back the underlying stream, for example to set a time limit on it.
    pub fn stream(&self) -> &S {
        &self.stream
    }
}
