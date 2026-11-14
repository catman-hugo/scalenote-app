// Where this device's private sync key is kept.
//
// Windows: the system's own secure storage (Credential Manager), so the key is protected by
// the user's account and never sits in a plain file.
// Everything else (Linux, Android): a file that only this user can read, inside the app's own
// private data folder, never in a vault. Linux's secret service and Android's keystore need
// extra system parts that a plain desktop or a phone may not have; connecting them is planned
// (Android in 0.5.4) and the choice is recorded in DECISIONS.md.

use scalenote_core::sync::identity::{FileSecretStore, SecretStore};
use std::path::Path;

#[cfg(windows)]
mod windows_store {
    use scalenote_core::sync::identity::SecretStore;
    use std::io;

    const SERVICE: &str = "ScaleNote";
    const ACCOUNT: &str = "sync-device-key";

    pub struct CredentialStore;

    // The error text of the library never contains the secret, but it is turned into a plain
    // message anyway so nothing else about the storage leaks into logs.
    fn failed(_: keyring::Error) -> io::Error {
        io::Error::other("the system's secure storage could not be used")
    }

    impl SecretStore for CredentialStore {
        fn load(&self) -> io::Result<Option<Vec<u8>>> {
            let entry = keyring::Entry::new(SERVICE, ACCOUNT).map_err(failed)?;
            match entry.get_secret() {
                Ok(secret) => Ok(Some(secret)),
                Err(keyring::Error::NoEntry) => Ok(None),
                Err(other) => Err(failed(other)),
            }
        }

        fn save(&self, secret: &[u8]) -> io::Result<()> {
            let entry = keyring::Entry::new(SERVICE, ACCOUNT).map_err(failed)?;
            entry.set_secret(secret).map_err(failed)
        }
    }
}

pub fn make_store(data_dir: &Path) -> Box<dyn SecretStore> {
    #[cfg(windows)]
    {
        let _ = data_dir;
        Box::new(windows_store::CredentialStore)
    }
    #[cfg(not(windows))]
    {
        Box::new(FileSecretStore::new(data_dir.join("keys").join("device.key")))
    }
}

// On Windows the file store is not used; this keeps the import from being reported as unused.
#[cfg(windows)]
#[allow(dead_code)]
fn _file_store_is_the_fallback(path: &Path) -> FileSecretStore {
    FileSecretStore::new(path.to_path_buf())
}
