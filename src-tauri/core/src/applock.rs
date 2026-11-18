//! The app lock: a PIN or passcode asked before ScaleNote shows anything (off unless turned on).
//!
//! What it protects: someone who picks up an unlocked device cannot open ScaleNote and read or
//! change pages in it. What it does not do: the pages are still ordinary files on the device
//! (that is the point of the app), so it is not encryption. The settings screen says so.
//!
//! The PIN or passcode itself is never stored. A file in the app's own private folder (never in a
//! vault) keeps a random salt and a slow hash of it (PBKDF2 with SHA-256), so the file alone does
//! not give it away quickly. After 5 wrong tries each further try has to wait, twice as long each
//! time (30 seconds up to 15 minutes); the count is in the file, so restarting does not reset it.
//!
//! File format 1 (plain `key value` lines, written privately and atomically):
//!   format 1 / kind pin|passcode / salt <hex> / iterations <n> / hash <hex> /
//!   failures <n> / wait_until <unix seconds> / biometric yes|no

use crate::atomic::write_atomic;
use crate::sync::hex;
use sha2::Sha256;
use std::fs;
use std::io;
use std::path::Path;

pub const FILE_NAME: &str = "app-lock.txt";
pub const PIN_MIN: usize = 4;
pub const PIN_MAX: usize = 12;
pub const PASSCODE_MIN: usize = 6;
pub const PASSCODE_MAX: usize = 64;
/// Tries that are free; after that each wrong one makes the next wait.
pub const FREE_TRIES: u32 = 5;
const FIRST_WAIT: u64 = 30;
const LONGEST_WAIT: u64 = 15 * 60;
const MAX_FILE_BYTES: u64 = 4096;
#[cfg(not(test))]
const ITERATIONS: u32 = 300_000;
// The tests run unoptimised; fewer rounds keep them quick. The count is stored in the file, so
// both kinds of file are read the same way.
#[cfg(test)]
const ITERATIONS: u32 = 1_000;
const ITERATIONS_RANGE: std::ops::RangeInclusive<u32> = 1_000..=10_000_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    /// Digits only, typed on a number pad.
    Pin,
    /// Any characters.
    Passcode,
}

impl Kind {
    pub fn parse(text: &str) -> Option<Kind> {
        match text {
            "pin" => Some(Kind::Pin),
            "passcode" => Some(Kind::Passcode),
            _ => None,
        }
    }
    pub fn name(self) -> &'static str {
        match self {
            Kind::Pin => "pin",
            Kind::Passcode => "passcode",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LockFile {
    pub kind: Kind,
    salt: [u8; 16],
    iterations: u32,
    hash: [u8; 32],
    failures: u32,
    wait_until: u64,
    pub biometric: bool,
}

/// What a try to unlock gave.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Attempt {
    Unlocked,
    /// Wrong; `wait` seconds before the next try is allowed (0: none).
    Wrong { wait: u64 },
    /// Not tried: too many wrong tries, `seconds` still to wait.
    Wait { seconds: u64 },
}

/// Why a new PIN or passcode is not accepted, as a code for the language file.
pub fn check_secret(kind: Kind, secret: &str) -> Result<(), &'static str> {
    let count = secret.chars().count();
    match kind {
        Kind::Pin if !secret.chars().all(|c| c.is_ascii_digit()) => Err("lock_pin_digits"),
        Kind::Pin if count < PIN_MIN => Err("lock_too_short"),
        Kind::Pin if count > PIN_MAX => Err("lock_too_long"),
        Kind::Passcode if secret.chars().any(char::is_control) => Err("lock_odd_characters"),
        Kind::Passcode if count < PASSCODE_MIN => Err("lock_too_short"),
        Kind::Passcode if count > PASSCODE_MAX => Err("lock_too_long"),
        _ => Ok(()),
    }
}

fn hash_of(secret: &str, salt: &[u8; 16], iterations: u32) -> [u8; 32] {
    let mut out = [0u8; 32];
    pbkdf2::pbkdf2_hmac::<Sha256>(secret.as_bytes(), salt, iterations, &mut out);
    out
}

/// Compares in a time that does not depend on where the first difference is.
fn same(a: &[u8; 32], b: &[u8; 32]) -> bool {
    a.iter().zip(b.iter()).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

fn wait_after(failures: u32) -> u64 {
    if failures < FREE_TRIES {
        return 0;
    }
    let doublings = (failures - FREE_TRIES).min(10);
    (FIRST_WAIT << doublings).min(LONGEST_WAIT)
}

impl LockFile {
    fn new(kind: Kind, secret: &str, biometric: bool) -> io::Result<LockFile> {
        let mut salt = [0u8; 16];
        getrandom::fill(&mut salt).map_err(|_| io::Error::other("no random numbers"))?;
        Ok(LockFile { kind, salt, iterations: ITERATIONS, hash: hash_of(secret, &salt, ITERATIONS), failures: 0, wait_until: 0, biometric })
    }

    fn to_text(&self) -> String {
        format!(
            "format 1\nkind {}\nsalt {}\niterations {}\nhash {}\nfailures {}\nwait_until {}\nbiometric {}\n",
            self.kind.name(),
            hex::encode(&self.salt),
            self.iterations,
            hex::encode(&self.hash),
            self.failures,
            self.wait_until,
            if self.biometric { "yes" } else { "no" }
        )
    }

    fn from_text(text: &str) -> Option<LockFile> {
        let mut values = std::collections::HashMap::new();
        for line in text.lines() {
            let (key, value) = line.split_once(' ')?;
            values.insert(key, value);
        }
        if values.get("format") != Some(&"1") {
            return None;
        }
        let salt: [u8; 16] = hex::decode(values.get("salt")?)?.try_into().ok()?;
        let hash: [u8; 32] = hex::decode(values.get("hash")?)?.try_into().ok()?;
        let iterations: u32 = values.get("iterations")?.parse().ok()?;
        if !ITERATIONS_RANGE.contains(&iterations) {
            return None;
        }
        Some(LockFile {
            kind: Kind::parse(values.get("kind")?)?,
            salt,
            iterations,
            hash,
            failures: values.get("failures")?.parse().ok()?,
            wait_until: values.get("wait_until")?.parse().ok()?,
            biometric: *values.get("biometric")? == "yes",
        })
    }
}

/// The lock file of this device, or None when there is no lock. A damaged file counts as no
/// lock: it sits in the app's own private folder, so whoever could damage it could also read
/// the pages directly, and a lock that can never be opened would cost the person their pages.
pub fn read(path: &Path) -> io::Result<Option<LockFile>> {
    let meta = match fs::symlink_metadata(path) {
        Ok(meta) => meta,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error),
    };
    if !meta.is_file() || meta.len() > MAX_FILE_BYTES {
        return Ok(None);
    }
    Ok(LockFile::from_text(&fs::read_to_string(path)?))
}

fn write(path: &Path, file: &LockFile) -> io::Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    write_atomic(path, file.to_text().as_bytes())?;
    // Only this user may read it (Linux, Android). Windows keeps the app folder per user already.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o600))?;
    }
    Ok(())
}

/// Turns the lock on, or gives it a new PIN or passcode. Unlocking with a fingerprint or face
/// stays as it was.
pub fn set(path: &Path, kind: Kind, secret: &str) -> Result<(), String> {
    check_secret(kind, secret).map_err(str::to_string)?;
    let biometric = read(path).ok().flatten().is_some_and(|f| f.biometric);
    let file = LockFile::new(kind, secret, biometric).map_err(|_| "io".to_string())?;
    write(path, &file).map_err(|_| "io".to_string())
}

/// Turns unlocking with a fingerprint or face on or off (the lock must be on).
pub fn set_biometric(path: &Path, on: bool) -> io::Result<bool> {
    let Some(mut file) = read(path)? else { return Ok(false) };
    file.biometric = on;
    write(path, &file)?;
    Ok(true)
}

/// Turns the lock off.
pub fn remove(path: &Path) -> io::Result<()> {
    match fs::remove_file(path) {
        Err(error) if error.kind() != io::ErrorKind::NotFound => Err(error),
        _ => Ok(()),
    }
}

/// Tries a PIN or passcode at time `now` (unix seconds). Every result is saved, so a wrong try
/// still counts after a restart.
pub fn verify(path: &Path, secret: &str, now: u64) -> io::Result<Attempt> {
    let Some(mut file) = read(path)? else { return Ok(Attempt::Unlocked) };
    if file.wait_until > now {
        return Ok(Attempt::Wait { seconds: file.wait_until - now });
    }
    if same(&hash_of(secret, &file.salt, file.iterations), &file.hash) {
        if file.failures != 0 || file.wait_until != 0 {
            file.failures = 0;
            file.wait_until = 0;
            write(path, &file)?;
        }
        return Ok(Attempt::Unlocked);
    }
    file.failures = file.failures.saturating_add(1);
    let wait = wait_after(file.failures);
    file.wait_until = if wait > 0 { now + wait } else { 0 };
    write(path, &file)?;
    Ok(Attempt::Wrong { wait })
}

/// After unlocking another way (a fingerprint), the count of wrong tries starts again.
pub fn clear_failures(path: &Path) -> io::Result<()> {
    if let Some(mut file) = read(path)? {
        if file.failures != 0 || file.wait_until != 0 {
            file.failures = 0;
            file.wait_until = 0;
            write(path, &file)?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn place(label: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("sn-lock-{label}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).expect("dir");
        dir.join(FILE_NAME)
    }

    #[test]
    fn a_pin_and_a_passcode_must_have_the_right_shape() {
        assert_eq!(check_secret(Kind::Pin, "1234"), Ok(()));
        assert_eq!(check_secret(Kind::Pin, "123"), Err("lock_too_short"));
        assert_eq!(check_secret(Kind::Pin, "12a4"), Err("lock_pin_digits"));
        assert_eq!(check_secret(Kind::Pin, "１２３４"), Err("lock_pin_digits"), "only plain digits");
        assert_eq!(check_secret(Kind::Pin, &"1".repeat(13)), Err("lock_too_long"));
        assert_eq!(check_secret(Kind::Passcode, "horse battery"), Ok(()));
        assert_eq!(check_secret(Kind::Passcode, "short"), Err("lock_too_short"));
        assert_eq!(check_secret(Kind::Passcode, "tab\there"), Err("lock_odd_characters"));
        assert_eq!(check_secret(Kind::Passcode, &"é".repeat(64)), Ok(()), "counted in characters");
        assert_eq!(check_secret(Kind::Passcode, &"x".repeat(65)), Err("lock_too_long"));
    }

    #[test]
    fn the_secret_is_never_stored_and_only_the_right_one_unlocks() {
        let path = place("verify");
        assert_eq!(read(&path).expect("read"), None, "no lock yet");
        set(&path, Kind::Pin, "482913").expect("set");
        let text = fs::read_to_string(&path).expect("file");
        assert!(!text.contains("482913"));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(fs::metadata(&path).expect("meta").permissions().mode() & 0o777, 0o600);
        }
        assert_eq!(verify(&path, "482913", 100).expect("ok"), Attempt::Unlocked);
        assert_eq!(verify(&path, "482914", 100).expect("wrong"), Attempt::Wrong { wait: 0 });
        // Two locks with the same PIN get different salts and hashes.
        let other = place("verify-2");
        set(&other, Kind::Pin, "482913").expect("set");
        assert_ne!(fs::read_to_string(&other).expect("other"), text);
        let _ = fs::remove_dir_all(path.parent().expect("dir"));
        let _ = fs::remove_dir_all(other.parent().expect("dir"));
    }

    #[test]
    fn wrong_tries_make_the_next_ones_wait_longer_and_survive_a_restart() {
        let path = place("wait");
        set(&path, Kind::Pin, "1111").expect("set");
        for _ in 0..FREE_TRIES - 1 {
            assert_eq!(verify(&path, "0000", 1000).expect("try"), Attempt::Wrong { wait: 0 });
        }
        assert_eq!(verify(&path, "0000", 1000).expect("fifth"), Attempt::Wrong { wait: 30 });
        // Even the right PIN is not tried while waiting, and the count is in the file.
        assert_eq!(verify(&path, "1111", 1010).expect("waiting"), Attempt::Wait { seconds: 20 });
        assert_eq!(verify(&path, "0000", 1030).expect("sixth"), Attempt::Wrong { wait: 60 });
        assert_eq!(verify(&path, "0000", 1090).expect("seventh"), Attempt::Wrong { wait: 120 });
        assert_eq!(wait_after(60), LONGEST_WAIT, "never longer than 15 minutes");
        assert_eq!(verify(&path, "1111", 1210).expect("right"), Attempt::Unlocked);
        assert_eq!(verify(&path, "0000", 1210).expect("count restarted"), Attempt::Wrong { wait: 0 });
        let _ = fs::remove_dir_all(path.parent().expect("dir"));
    }

    #[test]
    fn a_new_pin_replaces_the_old_and_turning_off_removes_the_file() {
        let path = place("change");
        set(&path, Kind::Pin, "1111").expect("set");
        set_biometric(&path, true).expect("bio");
        set(&path, Kind::Passcode, "a longer passcode").expect("change");
        let file = read(&path).expect("read").expect("there");
        assert_eq!(file.kind, Kind::Passcode);
        assert!(file.biometric, "the fingerprint choice is kept");
        assert_eq!(verify(&path, "1111", 0).expect("old"), Attempt::Wrong { wait: 0 });
        assert_eq!(verify(&path, "a longer passcode", 0).expect("new"), Attempt::Unlocked);
        assert_eq!(set(&path, Kind::Pin, "12"), Err("lock_too_short".to_string()));
        remove(&path).expect("off");
        remove(&path).expect("twice is fine");
        assert_eq!(read(&path).expect("read"), None);
        assert!(!set_biometric(&path, true).expect("no lock"), "nothing to change without a lock");
        let _ = fs::remove_dir_all(path.parent().expect("dir"));
    }

    #[test]
    fn a_damaged_or_odd_file_is_no_lock_rather_than_a_lock_that_cannot_open() {
        let path = place("odd");
        for text in ["", "format 2\n", "garbage", "format 1\nkind pin\nsalt zz\n", &"x".repeat(5000)] {
            fs::write(&path, text).expect("write");
            assert_eq!(read(&path).expect("read"), None, "{text:.20}");
        }
        set(&path, Kind::Pin, "1234").expect("set");
        let text = fs::read_to_string(&path).expect("text").replace("iterations 1000", "iterations 1");
        fs::write(&path, text).expect("weak");
        assert_eq!(read(&path).expect("read"), None, "a file asking for a weak hash is not trusted");
        let _ = fs::remove_dir_all(path.parent().expect("dir"));
    }
}
