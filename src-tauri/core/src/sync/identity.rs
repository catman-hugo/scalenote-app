//! A device's long-lived key pair: who it is to the devices it is paired with.
//!
//! The public key is the device's identity (shown as a short fingerprint so a person can compare
//! it). The private key never leaves the device, is never logged and never goes into a vault:
//! it is kept through a `SecretStore`. The app uses the system's secure storage where there is
//! one; `FileSecretStore` (a file only this user can read, in the app's own folder) is for
//! places that have none. Losing the private key is not a disaster, but every pairing has to
//! be done again, so a damaged key is reported and never silently replaced.

use super::{Result, SyncError};
use crate::atomic::TEMP_SUFFIX;
use sha2::{Digest, Sha256};
use std::fs;
use std::io::{self, Write};
use std::path::PathBuf;
use zeroize::Zeroize;

/// The one encrypted-connection recipe every device uses. A device that speaks anything else
/// cannot connect, which also means there is nothing to negotiate or downgrade.
pub const NOISE_PARAMS: &str = "Noise_XX_25519_ChaChaPoly_SHA256";
pub const KEY_LEN: usize = 32;

pub struct Identity {
    private: Vec<u8>,
    public: [u8; KEY_LEN],
}

impl Identity {
    pub fn generate() -> Result<Identity> {
        let params = NOISE_PARAMS.parse().map_err(|_| SyncError::Channel("noise recipe"))?;
        let pair = snow::Builder::new(params).generate_keypair().map_err(|_| SyncError::Channel("key generation"))?;
        Identity::from_parts(pair.private, &pair.public)
    }

    fn from_parts(private: Vec<u8>, public: &[u8]) -> Result<Identity> {
        let public: [u8; KEY_LEN] = public.try_into().map_err(|_| SyncError::Damaged("public key"))?;
        if private.len() != KEY_LEN {
            return Err(SyncError::Damaged("private key"));
        }
        Ok(Identity { private, public })
    }

    pub fn public(&self) -> &[u8; KEY_LEN] {
        &self.public
    }

    /// The private key bytes, for the connection code only.
    pub(crate) fn private(&self) -> &[u8] {
        &self.private
    }

    /// What is kept in the secret store: private key, then public key.
    fn to_secret(&self) -> Vec<u8> {
        let mut out = self.private.clone();
        out.extend_from_slice(&self.public);
        out
    }

    fn from_secret(mut bytes: Vec<u8>) -> Result<Identity> {
        if bytes.len() != KEY_LEN * 2 {
            bytes.zeroize();
            return Err(SyncError::Damaged("stored key"));
        }
        let public = bytes.split_off(KEY_LEN);
        Identity::from_parts(bytes, &public)
    }
}

impl Drop for Identity {
    fn drop(&mut self) {
        self.private.zeroize();
    }
}

// The private key must never reach a log through a debug print.
impl std::fmt::Debug for Identity {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "Identity({})", fingerprint(&self.public))
    }
}

/// A short form of a public key that people can compare: 20 hex digits in five groups.
pub fn fingerprint(public: &[u8; KEY_LEN]) -> String {
    let digest = Sha256::digest(public);
    let hex = super::hex::encode(&digest[..10]);
    hex.as_bytes().chunks(4).map(|c| String::from_utf8_lossy(c).into_owned()).collect::<Vec<_>>().join(" ")
}

/// Where the private key is kept. The system's secure storage implements this in the app.
pub trait SecretStore {
    fn load(&self) -> io::Result<Option<Vec<u8>>>;
    fn save(&self, secret: &[u8]) -> io::Result<()>;
}

/// Reads the key pair, or makes and keeps a new one when there is none yet.
pub fn load_or_create(store: &dyn SecretStore) -> Result<Identity> {
    match store.load()? {
        Some(bytes) => Identity::from_secret(bytes),
        None => {
            let identity = Identity::generate()?;
            let mut secret = identity.to_secret();
            let saved = store.save(&secret);
            secret.zeroize();
            saved?;
            Ok(identity)
        }
    }
}

/// A file that only the current user can read. Used where the system has no secure storage
/// (a server without a desktop, and Android until its own keystore is connected). The file is
/// written to a temporary name that is already private, then renamed, so the key is never
/// readable by others, not even for a moment.
pub struct FileSecretStore {
    path: PathBuf,
}

impl FileSecretStore {
    pub fn new(path: PathBuf) -> FileSecretStore {
        FileSecretStore { path }
    }
}

impl SecretStore for FileSecretStore {
    fn load(&self) -> io::Result<Option<Vec<u8>>> {
        match fs::metadata(&self.path) {
            Ok(meta) if meta.is_file() && meta.len() <= 1024 => fs::read(&self.path).map(Some),
            Ok(_) => Err(io::Error::new(io::ErrorKind::InvalidData, "key file is not a small file")),
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
            Err(error) => Err(error),
        }
    }

    fn save(&self, secret: &[u8]) -> io::Result<()> {
        if let Some(parent) = self.path.parent() {
            fs::create_dir_all(parent)?;
        }
        let mut temp = self.path.clone().into_os_string();
        temp.push(TEMP_SUFFIX);
        let temp = PathBuf::from(temp);
        let mut options = fs::OpenOptions::new();
        options.write(true).create(true).truncate(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&temp)?;
        file.write_all(secret)?;
        file.sync_all()?;
        drop(file);
        fs::rename(&temp, &self.path)
    }
}
