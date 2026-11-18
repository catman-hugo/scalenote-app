// The app lock's commands (the rules and the file live in scalenote_core::applock, with tests).
//
// While the app is locked every command that reads or writes pages refuses with "locked"
// (see `with_vault` and `vault_root` in lib.rs), so nothing of the pages reaches the window until
// the right PIN, passcode or fingerprint was given. The app starts locked when a lock is set.

use crate::AppState;
use scalenote_core::applock::{self, Attempt, Kind};
use serde::Serialize;
use std::path::PathBuf;
use std::sync::atomic::Ordering;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::State;
use zeroize::Zeroize;

pub fn lock_path(state: &AppState) -> PathBuf {
    state.data_dir.join(applock::FILE_NAME)
}

/// For the commands that touch pages.
pub fn refuse_if_locked(state: &AppState) -> Result<(), String> {
    if state.locked.load(Ordering::SeqCst) {
        Err("locked".to_string())
    } else {
        Ok(())
    }
}

fn now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_secs())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LockStatus {
    enabled: bool,
    locked: bool,
    /// "pin" or "passcode", so the lock screen shows a number pad or a keyboard.
    kind: String,
    biometric: bool,
    /// Whether this device can unlock with a fingerprint or face (Android, when set up there).
    biometric_available: bool,
}

#[derive(Serialize)]
pub struct UnlockReply {
    ok: bool,
    /// Seconds before the next try is allowed (0: none).
    wait: u64,
}

fn biometric_available(app: &tauri::AppHandle) -> bool {
    #[cfg(mobile)]
    {
        use tauri_plugin_biometric::BiometricExt;
        app.biometric().status().map(|s| s.is_available).unwrap_or(false)
    }
    #[cfg(not(mobile))]
    {
        let _ = app;
        false
    }
}

#[tauri::command]
pub fn lock_status(app: tauri::AppHandle, state: State<AppState>) -> Result<LockStatus, String> {
    let file = applock::read(&lock_path(&state)).map_err(|_| "io".to_string())?;
    Ok(LockStatus {
        enabled: file.is_some(),
        locked: file.is_some() && state.locked.load(Ordering::SeqCst),
        kind: file.as_ref().map_or("pin", |f| f.kind.name()).to_string(),
        biometric: file.as_ref().is_some_and(|f| f.biometric),
        biometric_available: biometric_available(&app),
    })
}

/// Checks the current secret for a change (a new PIN, turning the lock off). Wrong tries count
/// like on the lock screen.
fn confirm(state: &AppState, current: &str) -> Result<(), String> {
    match applock::verify(&lock_path(state), current, now()).map_err(|_| "io".to_string())? {
        Attempt::Unlocked => Ok(()),
        Attempt::Wrong { .. } => Err("lock_wrong".to_string()),
        Attempt::Wait { .. } => Err("lock_wait".to_string()),
    }
}

/// Turns the lock on, or sets a new PIN or passcode (then `current` must be the old one).
#[tauri::command]
pub fn lock_set(state: State<AppState>, kind: String, mut secret: String, mut current: Option<String>) -> Result<(), String> {
    let result = (|| {
        refuse_if_locked(&state)?;
        let kind = Kind::parse(&kind).ok_or_else(|| "invalid_path".to_string())?;
        if applock::read(&lock_path(&state)).map_err(|_| "io".to_string())?.is_some() {
            confirm(&state, current.as_deref().unwrap_or(""))?;
        }
        applock::set(&lock_path(&state), kind, &secret)
    })();
    secret.zeroize();
    if let Some(text) = current.as_mut() {
        text.zeroize();
    }
    result
}

/// Turns the lock off; needs the current PIN or passcode.
#[tauri::command]
pub fn lock_remove(state: State<AppState>, mut current: String) -> Result<(), String> {
    let result = (|| {
        refuse_if_locked(&state)?;
        confirm(&state, &current)?;
        applock::remove(&lock_path(&state)).map_err(|_| "io".to_string())
    })();
    current.zeroize();
    result
}

#[tauri::command]
pub fn lock_unlock(state: State<AppState>, mut secret: String) -> Result<UnlockReply, String> {
    let attempt = applock::verify(&lock_path(&state), &secret, now()).map_err(|_| "io".to_string());
    secret.zeroize();
    let reply = match attempt? {
        Attempt::Unlocked => {
            state.locked.store(false, Ordering::SeqCst);
            UnlockReply { ok: true, wait: 0 }
        }
        Attempt::Wrong { wait } => UnlockReply { ok: false, wait },
        Attempt::Wait { seconds } => UnlockReply { ok: false, wait: seconds },
    };
    Ok(reply)
}

/// Locks now (the interface asks after the chosen time away). Without a lock it does nothing.
#[tauri::command]
pub fn lock_now(state: State<AppState>) -> Result<bool, String> {
    let on = applock::read(&lock_path(&state)).map_err(|_| "io".to_string())?.is_some();
    if on {
        state.locked.store(true, Ordering::SeqCst);
    }
    Ok(on)
}

/// Turns unlocking with a fingerprint or face on or off. Only while unlocked, and only where the
/// device can do it.
#[tauri::command]
pub fn lock_set_biometric(app: tauri::AppHandle, state: State<AppState>, on: bool) -> Result<bool, String> {
    refuse_if_locked(&state)?;
    if on && !biometric_available(&app) {
        return Err("unsupported".to_string());
    }
    applock::set_biometric(&lock_path(&state), on).map_err(|_| "io".to_string())
}

/// Asks the device for a fingerprint or face. Android only; the system shows its own prompt.
#[tauri::command(async)]
pub fn lock_biometric_unlock(app: tauri::AppHandle, state: State<AppState>, title: String) -> Result<bool, String> {
    let file = applock::read(&lock_path(&state)).map_err(|_| "io".to_string())?;
    if !file.is_some_and(|f| f.biometric) {
        return Err("unsupported".to_string());
    }
    #[cfg(mobile)]
    {
        use tauri_plugin_biometric::{AuthOptions, BiometricExt};
        let title: String = title.chars().filter(|c| !c.is_control()).take(80).collect();
        let options = AuthOptions { allow_device_credential: false, title: Some(title.clone()), ..Default::default() };
        if app.biometric().authenticate(title, options).is_err() {
            return Ok(false);
        }
        state.locked.store(false, Ordering::SeqCst);
        applock::clear_failures(&lock_path(&state)).map_err(|_| "io".to_string())?;
        Ok(true)
    }
    #[cfg(not(mobile))]
    {
        let _ = (app, title);
        Err("unsupported".to_string())
    }
}
