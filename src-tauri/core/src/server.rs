//! The home server's logic: its config file, the checks that keep vaults apart, and one sync
//! service per vault. There is no window and no network code here beyond the sync service
//! itself, so everything can be tested on any machine.
//!
//! How vaults are kept apart (the owner's rule: a device paired with one vault must not be able
//! to reach another). Each vault gets its own sync service, which means its own listening port,
//! its own device key and its own list of paired devices, all in its own folder inside the
//! server's private data folder. A device only ever holds the key and address of the vault it
//! was paired with, so there is nothing that could lead it to a neighbour.

use crate::sync::device;
use crate::sync::identity::{self, FileSecretStore};
use crate::sync::service::Service;
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::Duration;

/// A config file larger than this is not a config file.
const MAX_CONFIG_BYTES: u64 = 64 * 1024;
pub const MAX_VAULTS: usize = 20;
const MAX_NAME: usize = 40;
/// Written by `scalenote-server pair` and answered by the running server (see `Runner::poll_pairing`).
pub const PAIR_REQUEST: &str = "pair.request";
pub const PAIR_CODE: &str = "pair.code";

#[derive(Clone, Debug, PartialEq)]
pub struct VaultConfig {
    pub name: String,
    pub folder: PathBuf,
    pub port: u16,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Config {
    /// Keys, paired devices and settings. Private to the server's own user.
    pub data_dir: PathBuf,
    /// How this server shows up on the paired devices.
    pub device_name: String,
    pub vaults: Vec<VaultConfig>,
}

/// A vault name is used as a folder name in the data folder, so it is kept to plain characters.
pub fn valid_vault_name(name: &str) -> bool {
    !name.is_empty() && name.len() <= MAX_NAME && name.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-' || b == b'_')
}

/// Reads the config text. The format is a few `key = value` lines, then one `[vault name]`
/// section per vault with `folder` and `port`. Lines starting with `#` are comments.
///
/// ```text
/// data_dir = /var/lib/scalenote-server
/// name = Home server
///
/// [vault alice]
/// folder = /srv/scalenote/alice
/// port = 47821
/// ```
pub fn parse(text: &str) -> Result<Config, String> {
    let mut data_dir: Option<PathBuf> = None;
    let mut device_name = device::clean_name("Home server");
    let mut vaults: Vec<VaultConfig> = Vec::new();
    let mut current: Option<(String, Option<PathBuf>, Option<u16>, usize)> = None;

    fn finish(current: &mut Option<(String, Option<PathBuf>, Option<u16>, usize)>, vaults: &mut Vec<VaultConfig>) -> Result<(), String> {
        if let Some((name, folder, port, line)) = current.take() {
            let folder = folder.ok_or_else(|| format!("line {line}: vault \"{name}\" has no folder"))?;
            let port = port.ok_or_else(|| format!("line {line}: vault \"{name}\" has no port"))?;
            vaults.push(VaultConfig { name, folder, port });
        }
        Ok(())
    }

    for (index, raw) in text.lines().enumerate() {
        let number = index + 1;
        let line = raw.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        if let Some(rest) = line.strip_prefix('[') {
            finish(&mut current, &mut vaults)?;
            let inner = rest.strip_suffix(']').ok_or_else(|| format!("line {number}: a section must end with ]"))?;
            let name = inner.strip_prefix("vault ").ok_or_else(|| format!("line {number}: the only section is [vault name]"))?.trim();
            if !valid_vault_name(name) {
                return Err(format!("line {number}: a vault name uses a to z, 0 to 9, - and _ (up to {MAX_NAME} characters)"));
            }
            current = Some((name.to_string(), None, None, number));
            continue;
        }
        let (key, value) = line.split_once('=').ok_or_else(|| format!("line {number}: expected key = value"))?;
        let (key, value) = (key.trim(), value.trim());
        match (&mut current, key) {
            (None, "data_dir") => data_dir = Some(absolute(value, number)?),
            (None, "name") => device_name = device::clean_name(value),
            (Some(vault), "folder") => vault.1 = Some(absolute(value, number)?),
            (Some(vault), "port") => vault.2 = Some(value.parse::<u16>().ok().filter(|p| *p >= 1024).ok_or_else(|| format!("line {number}: the port must be a number from 1024 to 65535"))?),
            _ => return Err(format!("line {number}: unknown setting \"{key}\" here")),
        }
    }
    finish(&mut current, &mut vaults)?;

    let data_dir = data_dir.ok_or("the config has no data_dir")?;
    if vaults.is_empty() {
        return Err("the config lists no vault".into());
    }
    if vaults.len() > MAX_VAULTS {
        return Err(format!("at most {MAX_VAULTS} vaults"));
    }
    let mut names = HashSet::new();
    let mut ports = HashSet::new();
    for vault in &vaults {
        if !names.insert(vault.name.clone()) {
            return Err(format!("the vault name \"{}\" is used twice", vault.name));
        }
        if !ports.insert(vault.port) {
            return Err(format!("the port {} is used by two vaults", vault.port));
        }
    }
    Ok(Config { data_dir, device_name, vaults })
}

fn absolute(value: &str, line: usize) -> Result<PathBuf, String> {
    let path = PathBuf::from(value);
    if value.is_empty() || !path.is_absolute() {
        return Err(format!("line {line}: write the full path, starting with /"));
    }
    Ok(path)
}

pub fn read_config(path: &Path) -> Result<Config, String> {
    let meta = fs::metadata(path).map_err(|e| format!("cannot read the config file: {e}"))?;
    if !meta.is_file() || meta.len() > MAX_CONFIG_BYTES {
        return Err("the config is not a small text file".into());
    }
    let text = fs::read_to_string(path).map_err(|e| format!("cannot read the config file: {e}"))?;
    parse(&text)
}

/// Checks that touch the disk: every vault folder exists, no folder is inside another (or the
/// same), and the data folder is separate from all of them. Two vaults sharing files would
/// break the rule that they are apart.
pub fn check_folders(config: &Config) -> Result<(), String> {
    let mut real: Vec<(String, PathBuf)> = Vec::new();
    for vault in &config.vaults {
        let path = fs::canonicalize(&vault.folder).map_err(|_| format!("the folder of vault \"{}\" does not exist: {}", vault.name, vault.folder.display()))?;
        if !path.is_dir() {
            return Err(format!("the folder of vault \"{}\" is not a folder", vault.name));
        }
        real.push((vault.name.clone(), path));
    }
    for (i, (a_name, a)) in real.iter().enumerate() {
        for (b_name, b) in real.iter().skip(i + 1) {
            if a.starts_with(b) || b.starts_with(a) {
                return Err(format!("the folders of vaults \"{a_name}\" and \"{b_name}\" overlap; each vault needs its own folder"));
            }
        }
    }
    if let Ok(data) = fs::canonicalize(&config.data_dir) {
        for (name, path) in &real {
            if data.starts_with(path) || path.starts_with(&data) {
                return Err(format!("the data folder and the folder of vault \"{name}\" overlap; keys must never sit inside a vault"));
            }
        }
    }
    Ok(())
}

/// Makes the data folder if it is missing (private from the start) and refuses to run when
/// other users could read it: the device keys are in it.
pub fn prepare_data_dir(path: &Path) -> Result<(), String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::{DirBuilderExt, MetadataExt, PermissionsExt};
        if !path.exists() {
            fs::DirBuilder::new().recursive(true).mode(0o700).create(path).map_err(|e| format!("cannot make the data folder: {e}"))?;
        }
        let meta = fs::symlink_metadata(path).map_err(|e| format!("cannot read the data folder: {e}"))?;
        if !meta.is_dir() {
            return Err("the data folder is not a real folder (a link does not count)".into());
        }
        // Group and others must have no access at all.
        if meta.mode() & 0o077 != 0 {
            return Err(format!("the data folder {} can be read by other users (mode {:o}). Run: chmod 700 {}", path.display(), meta.permissions().mode() & 0o777, path.display()));
        }
        Ok(())
    }
    #[cfg(not(unix))]
    {
        let _ = path;
        Err("the home server runs on Linux only".into())
    }
}

struct Running {
    name: String,
    folder: PathBuf,
    dir: PathBuf,
    service: Service,
}

/// All vaults of one server, each with its own service.
pub struct Runner {
    running: Vec<Running>,
}

impl Runner {
    /// Starts one service per vault. A vault that cannot start is reported and left out; the
    /// others still run (the second person's notes do not stop because of the first one's disk).
    pub fn start(config: &Config) -> (Runner, Vec<String>) {
        let mut running = Vec::new();
        let mut problems = Vec::new();
        for vault in &config.vaults {
            match start_one(config, vault) {
                Ok(item) => running.push(item),
                Err(reason) => problems.push(format!("vault \"{}\" did not start: {reason}", vault.name)),
            }
        }
        (Runner { running }, problems)
    }

    pub fn names(&self) -> Vec<String> {
        self.running.iter().map(|r| r.name.clone()).collect()
    }

    /// The port a vault listens on once it is listening (after a pairing is opened or a device
    /// is paired). `None` while it is silent.
    pub fn listening_port(&self, name: &str) -> Option<u16> {
        self.running.iter().find(|r| r.name == name).and_then(|r| r.service.status().listening_port)
    }

    pub fn service(&self, name: &str) -> Option<&Service> {
        self.running.iter().find(|r| r.name == name).map(|r| &r.service)
    }

    /// Answers `scalenote-server pair NAME`: where a request file is found, opens pairing for
    /// that vault and writes the code to a private file for the command to print. The code file is
    /// removed again once the code has expired or pairing was closed.
    pub fn poll_pairing(&self) -> Vec<String> {
        let mut notes = Vec::new();
        for item in &self.running {
            let request = item.dir.join(PAIR_REQUEST);
            let code_file = item.dir.join(PAIR_CODE);
            if request.exists() {
                let _ = fs::remove_file(&request);
                match item.service.start_pairing() {
                    Ok(code) => match write_private(&code_file, code.as_bytes()) {
                        Ok(()) => notes.push(format!("vault \"{}\": pairing is open", item.name)),
                        Err(e) => notes.push(format!("vault \"{}\": cannot write the code: {e}", item.name)),
                    },
                    Err(e) => notes.push(format!("vault \"{}\": pairing did not open: {}", item.name, e.code())),
                }
            } else if code_file.exists() && item.service.status().pairing_seconds_left.is_none() {
                let _ = fs::remove_file(&code_file);
            }
        }
        notes
    }

    /// One round of automatic syncing for every vault; returns a line per result for the log.
    pub fn sync_tick(&self, look: Duration) -> Vec<String> {
        let mut lines = Vec::new();
        for item in &self.running {
            for result in item.service.auto_sync_tick(look) {
                match result.outcome {
                    Ok(report) => lines.push(format!("vault \"{}\": synced with {}, {} files changed", item.name, result.name, report.changed())),
                    Err(code) => lines.push(format!("vault \"{}\": sync with {} failed: {code}", item.name, result.name)),
                }
            }
        }
        lines
    }

    pub fn shutdown(&self) {
        for item in &self.running {
            item.service.shutdown();
        }
    }

    pub fn folder_of(&self, name: &str) -> Option<&Path> {
        self.running.iter().find(|r| r.name == name).map(|r| r.folder.as_path())
    }
}

fn start_one(config: &Config, vault: &VaultConfig) -> Result<Running, String> {
    let dir = config.data_dir.join(&vault.name);
    fs::create_dir_all(&dir).map_err(|e| format!("cannot make its data folder: {e}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&dir, fs::Permissions::from_mode(0o700));
    }
    let store = FileSecretStore::new(dir.join("device.key"));
    let identity = identity::load_or_create(&store).map_err(|_| "its device key cannot be read or made".to_string())?;
    let settings = device::load(&dir).map_err(|_| "its settings cannot be read".to_string())?.settings;
    // The same server name on every vault would be confusing on a phone that holds two of them.
    let shown = device::clean_name(&format!("{} ({})", config.device_name, vault.name));
    let service = Service::on_port(&dir, identity, &shown, settings.enabled, vault.port).map_err(|e| format!("its sync service did not start: {}", e.code()))?;
    service.set_vault(Some(vault.folder.clone()));
    Ok(Running { name: vault.name.clone(), folder: vault.folder.clone(), dir, service })
}

fn write_private(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    use std::io::Write;
    let mut options = fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(path)?;
    file.write_all(bytes)?;
    file.sync_all()
}

#[cfg(test)]
#[path = "server_tests.rs"]
mod tests;
