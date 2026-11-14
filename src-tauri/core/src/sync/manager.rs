//! Everything the app needs from sync, behind one object: the device's name and switch, its
//! keys and the listening service. The app (and later the server program) creates one at
//! startup. If the keys or settings cannot be read, sync is reported as unavailable with a
//! reason instead of stopping the app: notes never depend on sync.

use super::device::{self, SyncSettings};
use super::identity::{self, SecretStore};
use super::service::Service;
use super::Result;
use std::path::Path;

pub struct Manager {
    dir: std::path::PathBuf,
    service: Option<Service>,
    /// Why sync is not available, as a short code for the interface to turn into a sentence.
    problem: Option<&'static str>,
}

impl Manager {
    pub fn start(dir: &Path, store: &dyn SecretStore) -> Manager {
        let build = || -> std::result::Result<Service, &'static str> {
            let settings = device::load(dir).map_err(|_| "settings")?.settings;
            let identity = identity::load_or_create(store).map_err(|_| "keys")?;
            Service::new(dir, identity, &settings.name, settings.enabled).map_err(|_| "service")
        };
        match build() {
            Ok(service) => Manager { dir: dir.to_path_buf(), service: Some(service), problem: None },
            Err(problem) => Manager { dir: dir.to_path_buf(), service: None, problem: Some(problem) },
        }
    }

    /// The service, or `None` when sync is not available (see `problem`).
    pub fn service(&self) -> Option<&Service> {
        self.service.as_ref()
    }

    pub fn problem(&self) -> Option<&'static str> {
        self.problem
    }

    /// The device's name and switch, read from the settings file.
    pub fn settings(&self) -> Result<SyncSettings> {
        Ok(device::load(&self.dir)?.settings)
    }

    /// Changes the name and/or the switch; the service follows at once (turning sync off closes
    /// the port and the pairing code). Returns what was saved.
    pub fn update(&self, name: Option<&str>, enabled: Option<bool>) -> Result<SyncSettings> {
        let saved = device::update(&self.dir, name, enabled)?;
        if let Some(service) = &self.service {
            service.set_name(&saved.name);
            service.set_enabled(saved.enabled)?;
        }
        Ok(saved)
    }

    pub fn shutdown(&self) {
        if let Some(service) = &self.service {
            service.shutdown();
        }
    }
}
