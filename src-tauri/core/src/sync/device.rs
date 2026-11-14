//! This device's own sync identity and its on/off switch.
//!
//! Both live OUTSIDE the vault, in the app's own settings folder, so a vault that is copied or
//! opened in another app never carries a device's identity with it. The identity is a random
//! id (to tell devices apart) and a name the owner can change (shown in lists and in the names
//! of conflict copies). Sync is on by default; the switch only says whether this device may
//! take part. Turning it off never deletes anything.
//!
//! Keys for pairing come later (0.5.1) and will go into the system's secure storage, not here.

use super::{Result, SyncError};
use crate::atomic::write_atomic;
use std::fs;
use std::io;
use std::path::Path;

const FILE_NAME: &str = "sync-device.txt";
const HEADER: &str = "scalenote-device 1";
pub const MAX_DEVICE_NAME_CHARS: usize = 40;
const DEFAULT_NAME: &str = "this-device";
/// A settings file bigger than this is not ours; it is ignored and replaced.
const MAX_FILE_BYTES: u64 = 4096;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SyncSettings {
    /// 32 lower case hex digits, random, made once.
    pub id: String,
    pub name: String,
    pub enabled: bool,
}

/// What `load` gives back: the settings, and whether they had to be made just now.
pub struct Loaded {
    pub settings: SyncSettings,
    pub created: bool,
}

/// A name that is safe to show and to put inside a file name: letters, digits, `-` and `_`
/// only; spaces become `-`; everything else is dropped. Empty means the default name.
pub fn clean_name(raw: &str) -> String {
    let mut out = String::new();
    for c in raw.trim().chars() {
        if out.chars().count() >= MAX_DEVICE_NAME_CHARS {
            break;
        }
        if c.is_alphanumeric() || c == '-' || c == '_' {
            out.push(c);
        } else if c == ' ' && !out.ends_with('-') {
            out.push('-');
        }
    }
    let out = out.trim_matches('-').to_string();
    if out.is_empty() { DEFAULT_NAME.to_string() } else { out }
}

fn new_id() -> Result<String> {
    let mut bytes = [0u8; 16];
    getrandom::fill(&mut bytes).map_err(|_| SyncError::Damaged("no random numbers available"))?;
    let mut id = String::with_capacity(32);
    for byte in bytes {
        id.push_str(&format!("{byte:02x}"));
    }
    Ok(id)
}

fn is_id(text: &str) -> bool {
    text.len() == 32 && text.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

fn to_text(settings: &SyncSettings) -> String {
    format!("{HEADER}\nid {}\nname {}\nenabled {}\n", settings.id, settings.name, settings.enabled)
}

fn parse(text: &str) -> Option<SyncSettings> {
    let mut lines = text.lines();
    if lines.next()? != HEADER {
        return None;
    }
    let id = lines.next()?.strip_prefix("id ")?;
    let name = lines.next()?.strip_prefix("name ")?;
    let enabled = match lines.next()?.strip_prefix("enabled ")? {
        "true" => true,
        "false" => false,
        _ => return None,
    };
    if lines.next().is_some() || !is_id(id) {
        return None;
    }
    // The name is cleaned again so a hand-edited file cannot put odd characters into file names.
    Some(SyncSettings { id: id.to_string(), name: clean_name(name), enabled })
}

/// Reads the settings from `dir`, or makes new ones (new id, default name, sync on) when there
/// are none or the file is not readable. A damaged file is replaced, never trusted.
pub fn load(dir: &Path) -> Result<Loaded> {
    let path = dir.join(FILE_NAME);
    let existing = match fs::metadata(&path) {
        Ok(meta) if meta.is_file() && meta.len() <= MAX_FILE_BYTES => fs::read_to_string(&path).ok().and_then(|t| parse(&t)),
        Ok(_) => None,
        Err(error) if error.kind() == io::ErrorKind::NotFound => None,
        Err(error) => return Err(error.into()),
    };
    if let Some(settings) = existing {
        return Ok(Loaded { settings, created: false });
    }
    let settings = SyncSettings { id: new_id()?, name: DEFAULT_NAME.to_string(), enabled: true };
    save(dir, &settings)?;
    Ok(Loaded { settings, created: true })
}

pub fn save(dir: &Path, settings: &SyncSettings) -> Result<()> {
    fs::create_dir_all(dir)?;
    write_atomic(&dir.join(FILE_NAME), to_text(settings).as_bytes())?;
    Ok(())
}

/// Changes the name (cleaned) and/or the switch, and saves. Returns the new settings.
pub fn update(dir: &Path, name: Option<&str>, enabled: Option<bool>) -> Result<SyncSettings> {
    let mut settings = load(dir)?.settings;
    if let Some(name) = name {
        settings.name = clean_name(name);
    }
    if let Some(enabled) = enabled {
        settings.enabled = enabled;
    }
    save(dir, &settings)?;
    Ok(settings)
}

/// Shorthand used by the app: the device type for `Device` below is the same thing.
pub type Device = SyncSettings;
