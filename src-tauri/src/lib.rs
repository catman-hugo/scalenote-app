// The app logic lives in a library so desktop and Android can share one entry point.
//
// This file is only glue: every rule about files lives in `scalenote-core`, where it has
// real tests. Commands return an error *code* (see `VaultError::code`) as text, and the
// interface turns the code into a sentence from the language file.

use scalenote_core::atomic::write_atomic;
use scalenote_core::attachments::MAX_ATTACHMENT_BASE64;
use scalenote_core::base64;
use scalenote_core::logger::{Level, Logger};
use scalenote_core::{EntryKind, NoteVersion, Vault, VaultError};
use serde::Serialize;
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::{Manager, State};

/// Settings are a small piece of text owned by the interface. The limit stops a bug from
/// filling the disk.
const MAX_SETTINGS_BYTES: usize = 64 * 1024;
const LOG_MAX_BYTES: u64 = 1024 * 1024;
const LOG_FILES_KEPT: usize = 3;

struct AppState {
    vault: Mutex<Option<Vault>>,
    logger: Logger,
    settings_file: PathBuf,
    default_vault: PathBuf,
}

#[derive(Serialize)]
struct OpenedVault {
    /// Only the folder's own name, for the title bar. The full path never goes to the log.
    name: String,
    path: String,
}

#[derive(Serialize)]
struct TreeEntry {
    path: String,
    name: String,
    kind: &'static str,
}

#[derive(Serialize)]
struct TreeReply {
    entries: Vec<TreeEntry>,
    truncated: bool,
}

#[derive(Serialize)]
struct NoteReply {
    text: String,
    version: String,
}

// A 64-bit hash does not fit in a JavaScript number without losing digits, so versions
// travel as text.
fn version_to_text(version: NoteVersion) -> String {
    format!("{:x}-{:x}", version.len, version.hash)
}

fn version_from_text(text: &str) -> Result<NoteVersion, String> {
    let (len, hash) = text.split_once('-').ok_or("invalid_path")?;
    let len = u64::from_str_radix(len, 16).map_err(|_| "invalid_path")?;
    let hash = u64::from_str_radix(hash, 16).map_err(|_| "invalid_path")?;
    Ok(NoteVersion { len, hash })
}

fn code(error: VaultError, state: &AppState, action: &str) -> String {
    // Log the action and the error code only, never a path or a title.
    state.logger.log(Level::Warn, &format!("{action} failed: {error}"));
    error.code().to_string()
}

fn with_vault<T>(
    state: &AppState,
    action: &str,
    work: impl FnOnce(&Vault) -> Result<T, VaultError>,
) -> Result<T, String> {
    let guard = state.vault.lock().map_err(|_| "io".to_string())?;
    let vault = guard.as_ref().ok_or_else(|| "no_vault".to_string())?;
    work(vault).map_err(|error| code(error, state, action))
}

fn install_vault(state: &AppState, vault: Vault) -> Result<OpenedVault, String> {
    let removed = vault.clean_up_leftovers();
    let reply = OpenedVault {
        name: vault
            .root()
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default(),
        path: vault.root().to_string_lossy().into_owned(),
    };
    let mut guard = state.vault.lock().map_err(|_| "io".to_string())?;
    *guard = Some(vault);
    state.logger.log(Level::Info, &format!("vault opened, {removed} leftover files removed"));
    Ok(reply)
}

#[tauri::command]
fn open_vault(path: String, state: State<AppState>) -> Result<OpenedVault, String> {
    let vault = Vault::open(&PathBuf::from(path)).map_err(|e| code(e, &state, "open vault"))?;
    install_vault(&state, vault)
}

#[tauri::command]
fn open_default_vault(state: State<AppState>) -> Result<OpenedVault, String> {
    let vault =
        Vault::open_or_create(&state.default_vault).map_err(|e| code(e, &state, "open default vault"))?;
    install_vault(&state, vault)
}

#[tauri::command]
fn vault_tree(state: State<AppState>) -> Result<TreeReply, String> {
    with_vault(&state, "list vault", |vault| {
        let tree = vault.tree()?;
        Ok(TreeReply {
            truncated: tree.truncated,
            entries: tree
                .entries
                .into_iter()
                .map(|e| TreeEntry {
                    path: e.path,
                    name: e.name,
                    kind: if e.kind == EntryKind::Folder { "folder" } else { "note" },
                })
                .collect(),
        })
    })
}

#[tauri::command]
fn read_note(path: String, state: State<AppState>) -> Result<NoteReply, String> {
    with_vault(&state, "read note", |vault| {
        let note = vault.read_note(&path)?;
        Ok(NoteReply { text: note.text, version: version_to_text(note.version) })
    })
}

/// `expected` is the version text from the last read or write, or `None` for a new file.
/// Returns the new version text.
#[tauri::command]
fn write_note(
    path: String,
    text: String,
    expected: Option<String>,
    state: State<AppState>,
) -> Result<String, String> {
    let expected = match expected {
        Some(text) => Some(version_from_text(&text)?),
        None => None,
    };
    with_vault(&state, "save note", |vault| {
        vault.write_note(&path, &text, expected).map(version_to_text)
    })
}

#[tauri::command]
fn create_note(parent: String, title: String, state: State<AppState>) -> Result<String, String> {
    with_vault(&state, "create note", |vault| vault.create_note(&parent, &title))
}

#[tauri::command]
fn create_folder(parent: String, name: String, state: State<AppState>) -> Result<String, String> {
    with_vault(&state, "create folder", |vault| vault.create_folder(&parent, &name))
}

#[tauri::command]
fn rename_entry(path: String, new_name: String, state: State<AppState>) -> Result<String, String> {
    with_vault(&state, "rename", |vault| vault.rename(&path, &new_name))
}

/// Copies a picture into the vault's `attachments` folder. `data` is the picture as base64
/// text; the file type is decided from its content, not from `name`. Returns the path to
/// write into the note.
#[tauri::command]
fn save_attachment(name: String, data: String, state: State<AppState>) -> Result<String, String> {
    // The length is checked before decoding, so a huge text is never turned into bytes.
    if data.len() > MAX_ATTACHMENT_BASE64 {
        return Err("too_large".to_string());
    }
    let bytes = base64::decode(&data).ok_or_else(|| "unsupported_type".to_string())?;
    with_vault(&state, "save attachment", |vault| vault.write_attachment(&name, &bytes))
}

/// Returns a picture from `attachments/` as a `data:` address, for showing in a note.
#[tauri::command]
fn read_attachment(path: String, state: State<AppState>) -> Result<String, String> {
    with_vault(&state, "read attachment", |vault| vault.read_attachment_data_url(&path))
}

/// The interface logs short fixed messages through here. The length limit is applied again
/// by the logger.
#[tauri::command]
fn log_line(level: String, message: String, state: State<AppState>) {
    state.logger.log(Level::from_name(&level), &format!("ui: {message}"));
}

#[tauri::command]
fn get_settings(state: State<AppState>) -> String {
    std::fs::read_to_string(&state.settings_file).unwrap_or_default()
}

#[tauri::command]
fn set_settings(json: String, state: State<AppState>) -> Result<(), String> {
    if json.len() > MAX_SETTINGS_BYTES {
        return Err("too_large".to_string());
    }
    write_atomic(&state.settings_file, json.as_bytes()).map_err(|error| {
        state.logger.log(Level::Warn, &format!("save settings failed: {}", error.kind()));
        "io".to_string()
    })
}

fn build_state(app: &tauri::App) -> Result<AppState, Box<dyn std::error::Error>> {
    let data_dir = app.path().app_data_dir()?;
    std::fs::create_dir_all(&data_dir)?;
    let logger = Logger::new(&data_dir.join("logs"), LOG_MAX_BYTES, LOG_FILES_KEPT);
    // On Android a folder picker is not available, so the vault stays inside the app's
    // private storage. On desktop the default is a visible folder in Documents.
    let default_vault = if cfg!(target_os = "android") {
        data_dir.join("vault")
    } else {
        match app.path().document_dir() {
            Ok(dir) => dir.join("ScaleNote"),
            Err(_) => data_dir.join("vault"),
        }
    };
    logger.log(Level::Info, "app started");
    Ok(AppState {
        vault: Mutex::new(None),
        logger,
        settings_file: data_dir.join("settings.json"),
        default_vault,
    })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Startup is the one place where giving up is allowed: without a window there is
    // nothing to show. We still report why, instead of panicking with unwrap/expect.
    let result = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let state = build_state(app)?;
            app.manage(state);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            open_vault,
            open_default_vault,
            vault_tree,
            read_note,
            write_note,
            create_note,
            create_folder,
            rename_entry,
            save_attachment,
            read_attachment,
            log_line,
            get_settings,
            set_settings
        ])
        .run(tauri::generate_context!());
    if let Err(error) = result {
        eprintln!("ScaleNote failed to start: {error}");
        std::process::exit(1);
    }
}
