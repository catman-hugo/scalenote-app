// Updating the computer app from inside the app (0.5.6).
//
// How it works:
// - When the app is packed, Tauri writes into the program which kind of file it came in
//   (.msi, .exe installer, .deb, .rpm or AppImage). `install_kind` reads that back.
// - Each release has a small file, `latest.json`, with the download address and signature of
//   each kind of file (made by `scripts/latest-json.mjs` in the build service).
// - `install_update` asks Tauri's updater for the file of the same kind, checks its signature
//   against the public key in tauri.conf.json, and installs it the way that kind is installed:
//   the Windows installers run and close the app; on Linux a .deb or .rpm asks for the
//   computer password (pkexec), and an AppImage replaces itself. Then the app starts again.
//
// The update is only installed when its signature matches, so a file that did not come from
// the build service is refused. When anything is missing (no key, a program that was not
// installed, such as the portable Windows zip), the interface opens the download in the
// browser instead, as before.

use tauri::AppHandle;
#[cfg(desktop)]
use tauri::Manager as _;

/// The repository the releases come from. Only its own release files are ever downloaded.
#[cfg(desktop)]
const RELEASES: &str = "https://github.com/catman-hugo/scalenote-app/releases/download";

/// The public key the update files are checked against, from tauri.conf.json. Empty means
/// updates in the app are not set up yet.
#[cfg(desktop)]
fn public_key(app: &AppHandle) -> String {
    app.config()
        .plugins
        .0
        .get("updater")
        .and_then(|config| config.get("pubkey"))
        .and_then(|key| key.as_str())
        .unwrap_or("")
        .trim()
        .to_string()
}

/// The kind of file this copy was installed from: "msi", "nsis", "deb", "rpm" or "appimage".
/// None when the app cannot update itself: on Android, without a key, or when the program was
/// not installed from one of those files (the portable zip, or a build made by hand).
#[tauri::command]
pub fn install_kind(app: AppHandle) -> Option<String> {
    #[cfg(desktop)]
    {
        use tauri::utils::config::BundleType;
        if public_key(&app).is_empty() {
            return None;
        }
        let kind = match tauri::utils::platform::bundle_type()? {
            BundleType::Msi => "msi",
            BundleType::Nsis => "nsis",
            BundleType::Deb => "deb",
            BundleType::Rpm => "rpm",
            BundleType::AppImage => "appimage",
            _ => return None,
        };
        Some(kind.to_string())
    }
    #[cfg(not(desktop))]
    {
        let _ = app;
        None
    }
}

/// Writes a problem to the app's log (the window only gets a short code).
#[cfg(desktop)]
fn warn(app: &AppHandle, message: &str) {
    if let Some(state) = app.try_state::<crate::AppState>() {
        state.logger.log(scalenote_core::logger::Level::Warn, &format!("update: {message}"));
    }
}

/// A version as the update check gives it, such as "0.5.7" or "0.6.0-beta.1". Anything else is
/// refused, because it becomes part of a web address.
#[cfg(desktop)]
fn is_plain_version(version: &str) -> bool {
    !version.is_empty()
        && version.len() <= 32
        && version.starts_with(|c: char| c.is_ascii_digit())
        && version.chars().all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-')
}

#[cfg(desktop)]
/// Progress of the download, sent to the window as the event "update-progress".
#[derive(Clone, serde::Serialize)]
struct Progress {
    done: u64,
    total: u64,
}

/// Downloads `version` in the same kind of file this copy came from, checks it and installs it.
/// On success the app closes (Windows) or starts again (Linux), so the call does not return.
/// Error codes: "unsupported", "invalid_version", "no_update", "download", "install".
#[tauri::command]
pub async fn install_update(app: AppHandle, version: String) -> Result<(), String> {
    #[cfg(desktop)]
    {
        use tauri::Emitter;
        use tauri_plugin_updater::UpdaterExt;
        if install_kind(app.clone()).is_none() {
            return Err("unsupported".to_string());
        }
        if !is_plain_version(&version) {
            return Err("invalid_version".to_string());
        }
        let address = format!("{RELEASES}/v{version}/latest.json");
        let url = tauri::Url::parse(&address).map_err(|_| "invalid_version".to_string())?;
        let updater = app
            .updater_builder()
            .endpoints(vec![url])
            .and_then(|builder| builder.build())
            .map_err(|error| {
                warn(&app, &format!("could not set up the updater: {error}"));
                "unsupported".to_string()
            })?;
        let update = match updater.check().await {
            Ok(Some(update)) if update.version == version => update,
            Ok(_) => return Err("no_update".to_string()),
            Err(error) => {
                warn(&app, &format!("could not read the release: {error}"));
                return Err("download".to_string());
            }
        };
        let mut done: u64 = 0;
        let window = app.clone();
        let result = update
            .download_and_install(
                move |chunk, total| {
                    done = done.saturating_add(chunk as u64);
                    // A lost progress message only leaves the bar behind; nothing to handle.
                    let _ = window.emit("update-progress", Progress { done, total: total.unwrap_or(0) });
                },
                || {},
            )
            .await;
        match result {
            // Windows has already closed by now; on Linux the new version is in place.
            Ok(()) => app.restart(),
            Err(tauri_plugin_updater::Error::PackageInstallFailed) => Err("install".to_string()),
            Err(error) => {
                warn(&app, &format!("download or install failed: {error}"));
                Err("download".to_string())
            }
        }
    }
    #[cfg(not(desktop))]
    {
        let _ = (app, version);
        Err("unsupported".to_string())
    }
}

#[cfg(all(test, desktop))]
mod tests {
    use super::is_plain_version;

    #[test]
    fn only_plain_versions_become_part_of_the_address() {
        for good in ["0.5.7", "1.0.0", "0.6.0-beta.1"] {
            assert!(is_plain_version(good), "{good}");
        }
        for bad in ["", "../x", "0.5.7/../../evil", "v0.5.7", "0.5.7?x=1", "0.5.7 ", &"9".repeat(33)] {
            assert!(!is_plain_version(bad), "{bad}");
        }
    }
}
