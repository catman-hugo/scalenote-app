// The app logic lives in a library so desktop and Android can share one entry point.
//
// This file is only glue: every rule about files lives in `scalenote-core`, where it has
// real tests. Commands return an error *code* (see `VaultError::code`) as text, and the
// interface turns the code into a sentence from the language file.

mod secure;
mod tray;

use scalenote_core::atomic::write_atomic;
use scalenote_core::attachments::MAX_ATTACHMENT_BASE64;
use scalenote_core::base64;
use scalenote_core::logger::{Level, Logger};
use scalenote_core::sync::conflicts::{self, Keep};
use scalenote_core::sync::engine::{Outcome, Preview, Report};
use scalenote_core::sync::files::Done;
use scalenote_core::sync::manager::Manager;
use scalenote_core::sync::plan::Action;
use scalenote_core::sync::service::{local_address_hint, Event, EventKind, Nearby, PeerView, Status, SyncingView};
use scalenote_core::sync::watch;
use scalenote_core::sync::SyncError;
use scalenote_core::{EntryKind, NoteVersion, Vault, VaultError};
use serde::Serialize;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use tauri::{Manager as _, State};

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
    /// The app's own folder (outside any vault): settings, logs and this device's sync identity.
    data_dir: PathBuf,
    /// This device's sync: name, switch, keys, paired devices and the listening service.
    sync: Arc<Manager>,
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
    let root = vault.root().to_path_buf();
    let mut guard = state.vault.lock().map_err(|_| "io".to_string())?;
    *guard = Some(vault);
    drop(guard);
    // Sync always works on the folder the app has open.
    if let Some(service) = state.sync.service() {
        service.set_vault(Some(root));
    }
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

/// Where "Use the default folder" will put the notes. The first-run screen shows it so the
/// choice is not blind. It only reads a path; nothing is created or opened here.
#[tauri::command]
fn default_vault_path(state: State<AppState>) -> String {
    state.default_vault.to_string_lossy().into_owned()
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
        let version = vault.write_note(&path, &text, expected).map(version_to_text);
        // Keeping an older version is best effort and never fails the save, but a failure is logged.
        if let Some(problem) = vault.take_history_problem() {
            state.logger.log(Level::Warn, &format!("could not keep an older version: {problem}"));
        }
        version
    })
}

/// The drawing of a page (see `scalenote_core::canvas`), or nothing when the page has none yet.
#[tauri::command]
fn read_canvas(path: String, state: State<AppState>) -> Result<Option<NoteReply>, String> {
    with_vault(&state, "read canvas", |vault| {
        Ok(vault.read_canvas(&path)?.map(|c| NoteReply { text: c.text, version: version_to_text(c.version) }))
    })
}

/// `expected` is the version text from the last read or write, or `None` when there was no drawing.
#[tauri::command]
fn write_canvas(
    path: String,
    text: String,
    expected: Option<String>,
    state: State<AppState>,
) -> Result<String, String> {
    let expected = match expected {
        Some(text) => Some(version_from_text(&text)?),
        None => None,
    };
    with_vault(&state, "save canvas", |vault| vault.write_canvas(&path, &text, expected).map(version_to_text))
}

/// The folder icon file (see `scalenote_core::foldericons`), or nothing when none has been chosen.
#[tauri::command]
fn read_folder_icons(state: State<AppState>) -> Result<Option<NoteReply>, String> {
    with_vault(&state, "read folder icons", |vault| {
        Ok(vault.read_folder_icons()?.map(|c| NoteReply { text: c.text, version: version_to_text(c.version) }))
    })
}

/// `expected` is the version text from the last read or write, or `None` when there was no file.
#[tauri::command]
fn write_folder_icons(text: String, expected: Option<String>, state: State<AppState>) -> Result<String, String> {
    let expected = match expected {
        Some(text) => Some(version_from_text(&text)?),
        None => None,
    };
    with_vault(&state, "save folder icons", |vault| vault.write_folder_icons(&text, expected).map(version_to_text))
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

/// Moves a note or folder into another folder. `new_parent` is "" for the top of the vault.
#[tauri::command]
fn move_entry(path: String, new_parent: String, state: State<AppState>) -> Result<String, String> {
    with_vault(&state, "move", |vault| vault.move_entry(&path, &new_parent))
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

/// Keeps the words of an imported PDF page beside its picture (see `Vault::write_page_text`).
#[tauri::command]
fn write_page_text(picture: String, text: String, state: State<AppState>) -> Result<(), String> {
    // Checked before anything else, so a huge text is refused at once.
    if text.len() > scalenote_core::attachments::MAX_PAGE_TEXT_BYTES {
        return Err("too_large".to_string());
    }
    with_vault(&state, "save page text", |vault| vault.write_page_text(&picture, &text))
}

/// The words kept beside a picture; the error "not_found" when it has none.
#[tauri::command]
fn read_page_text(picture: String, state: State<AppState>) -> Result<String, String> {
    with_vault(&state, "read page text", |vault| vault.read_page_text(&picture))
}

#[derive(Serialize)]
struct ExportReply {
    /// Where the copy was made, for the message that tells the person.
    path: String,
    notes: usize,
    changed: usize,
    files: usize,
    skipped: usize,
}

/// Makes a copy of the vault next to it, with the colours turned into what Obsidian shows
/// (see `scalenote_core::obsidian`). The vault itself is never changed. Not offered on
/// Android, where the vault lives in the app's private storage and nothing else could open a
/// copy made there. `async` runs it away from the main thread, so a big vault does not freeze
/// the window.
#[tauri::command(async)]
fn export_obsidian_copy(state: State<AppState>) -> Result<ExportReply, String> {
    if cfg!(target_os = "android") {
        return Err("unsupported".to_string());
    }
    with_vault(&state, "export copy", |vault| {
        let report = scalenote_core::obsidian::export_obsidian_copy(vault)?;
        Ok(ExportReply {
            path: scalenote_core::obsidian::friendly_path(&report.path),
            notes: report.notes,
            changed: report.changed,
            files: report.files,
            skipped: report.skipped,
        })
    })
}

#[derive(Serialize)]
struct BackupReply {
    name: String,
    when: String,
}

#[derive(Serialize)]
struct BackupMadeReply {
    name: String,
    when: String,
    files: usize,
    skipped: usize,
}

#[derive(Serialize)]
struct RestoreReply {
    added: usize,
    replaced: usize,
    unchanged: usize,
    skipped: usize,
}

/// Makes a plain copy of the vault in the backups folder beside it (see `scalenote_core::backup`).
/// Not offered on Android, where nothing else could open a copy made in the app's private storage.
#[tauri::command(async)]
fn backup_make(state: State<AppState>) -> Result<BackupMadeReply, String> {
    if cfg!(target_os = "android") {
        return Err("unsupported".to_string());
    }
    with_vault(&state, "backup", |vault| {
        let report = scalenote_core::backup::make(vault)?;
        Ok(BackupMadeReply { name: report.info.name, when: report.info.when, files: report.files, skipped: report.skipped })
    })
}

/// The backups of this vault, newest first.
#[tauri::command(async)]
fn backup_list(state: State<AppState>) -> Result<Vec<BackupReply>, String> {
    if cfg!(target_os = "android") {
        return Err("unsupported".to_string());
    }
    with_vault(&state, "backup list", |vault| {
        Ok(scalenote_core::backup::list(vault)?.into_iter().map(|b| BackupReply { name: b.name, when: b.when }).collect())
    })
}

/// Puts a listed backup back. Nothing is deleted and replaced files are kept first.
#[tauri::command(async)]
fn backup_restore(state: State<AppState>, name: String) -> Result<RestoreReply, String> {
    if cfg!(target_os = "android") {
        return Err("unsupported".to_string());
    }
    with_vault(&state, "backup restore", |vault| {
        let report = scalenote_core::backup::restore(vault, &name)?;
        Ok(RestoreReply { added: report.added, replaced: report.replaced, unchanged: report.unchanged, skipped: report.skipped })
    })
}

#[derive(Serialize)]
struct PageExportReply {
    /// The new folder, for the message that tells the person.
    path: String,
    pictures: usize,
    missing: usize,
    /// Whether the page's drawing was written as a picture.
    drawing: bool,
}

/// Writes one page and its pictures into a new folder beside the notes folder (see
/// `scalenote_core::export`). The interface sends only the page; where the folder goes is fixed.
/// Not offered on Android, for the same reason as the Obsidian copy.
#[tauri::command(async)]
fn export_page(state: State<AppState>, path: String, drawing: Option<String>) -> Result<PageExportReply, String> {
    if cfg!(target_os = "android") {
        return Err("unsupported".to_string());
    }
    // The picture of the drawing comes as base64 text; its length is checked before decoding.
    // One that cannot be read is left out, the page is still exported.
    let picture = match drawing {
        Some(data) if data.len() <= MAX_ATTACHMENT_BASE64 => base64::decode(&data),
        _ => None,
    };
    with_vault(&state, "export page", |vault| {
        let report = vault.export_page(&path, picture.as_deref())?;
        Ok(PageExportReply {
            path: scalenote_core::obsidian::friendly_path(&report.path),
            pictures: report.pictures,
            missing: report.missing,
            drawing: report.drawing,
        })
    })
}

#[derive(Serialize)]
struct TrashEntry {
    id: String,
    name: String,
    /// The folder it was deleted from, "" for the top of the vault.
    from: String,
    is_folder: bool,
    /// Seconds since 1970.
    deleted_at: u64,
}

impl From<scalenote_core::TrashItem> for TrashEntry {
    fn from(item: scalenote_core::TrashItem) -> Self {
        TrashEntry {
            id: item.id,
            name: item.name,
            from: item.from,
            is_folder: item.is_folder,
            deleted_at: item.deleted_at,
        }
    }
}

/// "Delete" moves a page or folder into the vault's hidden trash folder; nothing is removed
/// until the person chooses "Delete forever" or "Empty trash".
#[tauri::command]
fn trash_entry(path: String, state: State<AppState>) -> Result<TrashEntry, String> {
    with_vault(&state, "move to trash", |vault| vault.move_to_trash(&path).map(TrashEntry::from))
}

#[tauri::command]
fn trash_list(state: State<AppState>) -> Result<Vec<TrashEntry>, String> {
    with_vault(&state, "list trash", |vault| {
        Ok(vault.trash_list()?.into_iter().map(TrashEntry::from).collect())
    })
}

/// Returns the path the item was put back at.
#[tauri::command]
fn trash_restore(id: String, state: State<AppState>) -> Result<String, String> {
    with_vault(&state, "restore from trash", |vault| vault.restore_from_trash(&id))
}

#[tauri::command]
fn trash_delete_forever(id: String, state: State<AppState>) -> Result<(), String> {
    with_vault(&state, "delete forever", |vault| vault.delete_forever(&id))
}

#[tauri::command]
fn trash_empty(state: State<AppState>) -> Result<usize, String> {
    with_vault(&state, "empty trash", |vault| vault.empty_trash())
}

#[derive(Serialize)]
struct SearchHitReply {
    path: String,
    title: String,
    /// Pieces of one line of the page; `true` marks the pieces that matched the query.
    snippet: Vec<(String, bool)>,
}

#[derive(Serialize)]
struct SearchReply {
    hits: Vec<SearchHitReply>,
    truncated: bool,
}

/// Searches the pages. It runs away from the main thread and does not keep the vault locked
/// while it reads: the lock is held only to learn the folder, so saving a note is never
/// blocked by a slow search. The query is not written to the log.
#[tauri::command(async)]
fn search_vault(query: String, limit: usize, state: State<AppState>) -> Result<SearchReply, String> {
    let root = with_vault(&state, "search", |vault| Ok(vault.root().to_path_buf()))?;
    let vault = Vault::open(&root).map_err(|e| code(e, &state, "search"))?;
    let results = vault.search(&query, limit).map_err(|e| code(e, &state, "search"))?;
    Ok(SearchReply {
        truncated: results.truncated,
        hits: results
            .hits
            .into_iter()
            .map(|h| SearchHitReply { path: h.path, title: h.title, snippet: h.snippet })
            .collect(),
    })
}

#[derive(Serialize)]
struct BacklinkReply {
    path: String,
    title: String,
    count: usize,
    snippet: Vec<(String, bool)>,
}

#[derive(Serialize)]
struct BacklinksReply {
    items: Vec<BacklinkReply>,
    truncated: bool,
}

/// The pages that link to one page. Like search it runs away from the main thread and does
/// not keep the vault locked while it reads the pages.
#[tauri::command(async)]
fn backlinks(path: String, state: State<AppState>) -> Result<BacklinksReply, String> {
    let root = with_vault(&state, "backlinks", |vault| Ok(vault.root().to_path_buf()))?;
    let vault = Vault::open(&root).map_err(|e| code(e, &state, "backlinks"))?;
    let results = vault.backlinks(&path).map_err(|e| code(e, &state, "backlinks"))?;
    Ok(BacklinksReply {
        truncated: results.truncated,
        items: results
            .items
            .into_iter()
            .map(|b| BacklinkReply { path: b.path, title: b.title, count: b.count, snippet: b.snippet })
            .collect(),
    })
}

#[derive(Serialize)]
struct HistoryReply {
    id: String,
    time: u64,
    size: u64,
}

/// The older versions of a page, newest first (see history.rs in the core).
#[tauri::command]
fn history_list(path: String, state: State<AppState>) -> Result<Vec<HistoryReply>, String> {
    with_vault(&state, "history list", |vault| {
        Ok(vault.history_list(&path)?.into_iter().map(|e| HistoryReply { id: e.id, time: e.time, size: e.size }).collect())
    })
}

#[tauri::command]
fn history_read(path: String, id: String, state: State<AppState>) -> Result<String, String> {
    with_vault(&state, "history read", |vault| vault.history_read(&path, &id))
}

/// Copies the page as it is now into its history; called before an older version is put back.
#[tauri::command]
fn history_keep_now(path: String, state: State<AppState>) -> Result<(), String> {
    with_vault(&state, "history keep", |vault| vault.history_keep_now(&path))
}

/// Deletes the history of every page. Pages are not touched.
#[tauri::command]
fn history_clear(state: State<AppState>) -> Result<(), String> {
    with_vault(&state, "history clear", |vault| vault.history_clear())
}

#[derive(Serialize)]
struct PageInfoReply {
    path: String,
    tags: Vec<String>,
    favorite: bool,
}

#[derive(Serialize)]
struct PageIndexReply {
    pages: Vec<PageInfoReply>,
    truncated: bool,
}

/// The tags and favourite mark of every page that has either. Like search it runs away from the
/// main thread and does not keep the vault locked while it reads the pages.
#[tauri::command(async)]
fn page_index(state: State<AppState>) -> Result<PageIndexReply, String> {
    let root = with_vault(&state, "page_index", |vault| Ok(vault.root().to_path_buf()))?;
    let vault = Vault::open(&root).map_err(|e| code(e, &state, "page_index"))?;
    let index = vault.page_index().map_err(|e| code(e, &state, "page_index"))?;
    Ok(PageIndexReply {
        truncated: index.truncated,
        pages: index.pages.into_iter().map(|p| PageInfoReply { path: p.path, tags: p.tags, favorite: p.favorite }).collect(),
    })
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

#[derive(Serialize)]
struct SyncSettingsReply {
    name: String,
    enabled: bool,
}

/// This device's sync name and on/off switch. They are kept in the app's own folder, never in a
/// vault, so a copied vault does not carry them along.
#[tauri::command]
fn get_sync_settings(state: State<AppState>) -> Result<SyncSettingsReply, String> {
    let settings = state.sync.settings().map_err(|error| {
        state.logger.log(Level::Warn, &format!("read sync settings failed: {error}"));
        "io".to_string()
    })?;
    Ok(SyncSettingsReply { name: settings.name, enabled: settings.enabled })
}

#[tauri::command]
fn set_sync_settings(name: Option<String>, enabled: Option<bool>, state: State<AppState>) -> Result<SyncSettingsReply, String> {
    let saved = state.sync.update(name.as_deref(), enabled).map_err(|error| {
        state.logger.log(Level::Warn, &format!("save sync settings failed: {error}"));
        error.code().to_string()
    })?;
    Ok(SyncSettingsReply { name: saved.name, enabled: saved.enabled })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SyncPeerReply {
    id: String,
    name: String,
    fingerprint: String,
    added: String,
    last_sync: String,
    last_changed: usize,
    version: String,
    older_version: bool,
    has_history: bool,
    wifi_only: bool,
}

#[derive(Serialize)]
struct SyncEventReply {
    when: String,
    kind: &'static str,
    name: String,
    changed: usize,
}

#[derive(Serialize)]
struct SyncingReply {
    name: String,
    done: usize,
    total: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SyncStatusReply {
    /// Why sync cannot be used on this device (a short code), or null when it can.
    problem: Option<&'static str>,
    enabled: bool,
    listening_port: Option<u16>,
    /// This device's address on the local network, for the other device to type.
    address: Option<String>,
    fingerprint: String,
    paused: bool,
    on_wifi: bool,
    syncing: Option<SyncingReply>,
    peers: Vec<SyncPeerReply>,
    pairing_seconds_left: Option<u64>,
    events: Vec<SyncEventReply>,
}

fn event_reply(event: Event) -> SyncEventReply {
    let kind = match event.kind {
        EventKind::Paired => "paired",
        EventKind::Refused => "refused",
        EventKind::Removed => "removed",
        EventKind::Synced => "synced",
        EventKind::SyncFailed => "syncFailed",
    };
    SyncEventReply { when: event.when, kind, name: event.name, changed: event.changed }
}

fn peer_reply(peer: PeerView) -> SyncPeerReply {
    SyncPeerReply {
        id: peer.id,
        name: peer.name,
        fingerprint: peer.fingerprint,
        added: peer.added,
        last_sync: peer.last_sync,
        last_changed: peer.last_changed,
        version: peer.version,
        older_version: peer.older,
        has_history: peer.has_history,
        wifi_only: peer.wifi_only,
    }
}

fn status_reply(status: Status, problem: Option<&'static str>) -> SyncStatusReply {
    SyncStatusReply {
        problem,
        enabled: status.enabled,
        listening_port: status.listening_port,
        address: local_address_hint(),
        fingerprint: status.fingerprint,
        paused: status.paused,
        on_wifi: status.on_wifi,
        syncing: status.syncing.map(|s: SyncingView| SyncingReply { name: s.name, done: s.done, total: s.total }),
        peers: status.peers.into_iter().map(peer_reply).collect(),
        pairing_seconds_left: status.pairing_seconds_left,
        events: status.events.into_iter().rev().map(event_reply).collect(),
    }
}

/// Runs work that may wait on the network or on a lock off the window's own thread.
async fn blocking<T: Send + 'static>(work: impl FnOnce() -> T + Send + 'static) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(work).await.map_err(|_| "io".to_string())
}

/// Turns a sync error into the short code the interface shows, and logs it. The text of a sync
/// error never contains a key, a code or a note's text.
fn sync_failed(logger: &Logger, what: &str, error: SyncError) -> String {
    logger.log(Level::Warn, &format!("{what} failed: {error}"));
    error.code().to_string()
}

/// Gives the running service, or the reason sync cannot be used on this device.
fn running(sync: &Manager) -> Result<&scalenote_core::sync::service::Service, SyncError> {
    sync.service().ok_or(SyncError::Refused("sync is not available"))
}

/// What the Sync tab shows: this device, its paired devices, a running pairing code's time and
/// the recent events.
#[tauri::command]
async fn sync_status(state: State<'_, AppState>) -> Result<SyncStatusReply, String> {
    let sync = state.sync.clone();
    blocking(move || match sync.service() {
        Some(service) => Ok(status_reply(service.status(), None)),
        None => Err(sync.problem().unwrap_or("service").to_string()),
    })
    .await?
}

/// Opens the pairing screen: returns the code to show. The device listens for a pairing until
/// the screen is closed, the code runs out or the attempts are used up.
#[tauri::command]
async fn sync_start_pairing(state: State<'_, AppState>) -> Result<String, String> {
    let sync = state.sync.clone();
    let result = blocking(move || running(&sync).and_then(|service| service.start_pairing())).await?;
    result.map_err(|error| sync_failed(&state.logger, "start pairing", error))
}

#[tauri::command]
async fn sync_stop_pairing(state: State<'_, AppState>) -> Result<(), String> {
    let sync = state.sync.clone();
    let result = blocking(move || running(&sync).and_then(|service| service.stop_pairing())).await?;
    result.map_err(|error| sync_failed(&state.logger, "stop pairing", error))
}

/// Types the code shown on another device: connects to its address and pairs. Returns the
/// other device's name.
#[tauri::command]
async fn sync_join(address: String, code: String, state: State<'_, AppState>) -> Result<String, String> {
    let sync = state.sync.clone();
    let result = blocking(move || running(&sync).and_then(|service| service.join(&address, &code))).await?;
    result.map(|peer| peer.name).map_err(|error| sync_failed(&state.logger, "pairing", error))
}

#[derive(Serialize)]
struct NearbyReply {
    name: String,
    address: String,
    paired: bool,
}

fn nearby_reply(found: Nearby) -> NearbyReply {
    NearbyReply { name: found.name, address: found.address, paired: found.paired }
}

/// Listens for a few seconds for devices that are showing a pairing code, so their address does
/// not have to be typed. A found device is only an address to try; the code still decides.
#[tauri::command]
async fn sync_find(state: State<'_, AppState>) -> Result<Vec<NearbyReply>, String> {
    let sync = state.sync.clone();
    let result = blocking(move || running(&sync).and_then(|service| service.find_nearby(std::time::Duration::from_millis(2500)))).await?;
    result
        .map(|found| found.into_iter().map(nearby_reply).collect())
        .map_err(|error| sync_failed(&state.logger, "looking for devices", error))
}

#[tauri::command]
async fn sync_remove_peer(id: String, state: State<'_, AppState>) -> Result<bool, String> {
    let sync = state.sync.clone();
    let result = blocking(move || running(&sync).and_then(|service| service.remove_peer(&id))).await?;
    result.map_err(|error| sync_failed(&state.logger, "remove device", error))
}

const MAX_PREVIEW_ITEMS: usize = 200;

#[derive(Serialize)]
struct PreviewItem {
    path: String,
    action: &'static str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PreviewReply {
    first: bool,
    send: usize,
    receive: usize,
    delete_here: usize,
    delete_there: usize,
    conflicts: usize,
    clashes: usize,
    skipped_here: usize,
    skipped_there: usize,
    too_big: Vec<String>,
    files_here: usize,
    files_there: usize,
    items: Vec<PreviewItem>,
    items_truncated: bool,
}

fn preview_reply(preview: Preview) -> PreviewReply {
    let items_truncated = preview.plan.actions.len() > MAX_PREVIEW_ITEMS;
    let items = preview
        .plan
        .actions
        .iter()
        .take(MAX_PREVIEW_ITEMS)
        .map(|action| PreviewItem {
            path: action.path().to_string(),
            action: match action {
                Action::Push { .. } => "send",
                Action::Pull { .. } => "receive",
                Action::DeleteLocal { .. } => "deleteHere",
                Action::DeleteRemote { .. } => "deleteThere",
                Action::Conflict { .. } => "conflict",
            },
        })
        .collect();
    PreviewReply {
        first: preview.first,
        send: preview.summary.push,
        receive: preview.summary.pull,
        delete_here: preview.summary.delete_local,
        delete_there: preview.summary.delete_remote,
        conflicts: preview.summary.conflicts,
        clashes: preview.summary.clashes,
        skipped_here: preview.skipped_here,
        skipped_there: preview.skipped_there,
        too_big: preview.too_big,
        files_here: preview.files_here,
        files_there: preview.files_there,
        items,
        items_truncated,
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ReportReply {
    sent: usize,
    received: usize,
    deleted_here: usize,
    deleted_there: usize,
    conflicts: usize,
    conflict_copies: Vec<String>,
    left_for_next: usize,
    too_big: Vec<String>,
    clashes: usize,
}

fn report_reply(report: Report) -> ReportReply {
    ReportReply {
        sent: report.sent,
        received: report.received,
        deleted_here: report.deleted_here,
        deleted_there: report.deleted_there,
        conflicts: report.conflicts,
        conflict_copies: report.conflict_copies,
        left_for_next: report.left_for_next,
        too_big: report.too_big,
        clashes: report.clashes.len(),
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SyncRunReply {
    /// The first sync with this device: nothing was changed; show `preview` and ask.
    needs_approval: bool,
    preview: Option<PreviewReply>,
    report: Option<ReportReply>,
}

/// What a sync with one paired device would change. Changes nothing on either device.
#[tauri::command]
async fn sync_compare(id: String, state: State<'_, AppState>) -> Result<PreviewReply, String> {
    let sync = state.sync.clone();
    let result = blocking(move || running(&sync).and_then(|service| service.compare_peer(&id))).await?;
    result.map(preview_reply).map_err(|error| sync_failed(&state.logger, "compare", error))
}

/// Syncs with one paired device. The first sync with a device only reports what it would do
/// until `approved` is true.
#[tauri::command]
async fn sync_run(id: String, approved: bool, state: State<'_, AppState>) -> Result<SyncRunReply, String> {
    let sync = state.sync.clone();
    let result = blocking(move || running(&sync).and_then(|service| service.sync_peer(&id, approved, &mut |_| {}))).await?;
    match result {
        Ok(Outcome::NeedsApproval(preview)) => Ok(SyncRunReply { needs_approval: true, preview: Some(preview_reply(preview)), report: None }),
        Ok(Outcome::Done(report)) => Ok(SyncRunReply { needs_approval: false, preview: None, report: Some(report_reply(report)) }),
        Err(error) => Err(sync_failed(&state.logger, "sync", error)),
    }
}

#[tauri::command]
async fn sync_set_paused(paused: bool, state: State<'_, AppState>) -> Result<(), String> {
    let sync = state.sync.clone();
    let result = blocking(move || running(&sync).and_then(|service| service.set_paused(paused))).await?;
    result.map_err(|error| sync_failed(&state.logger, "pause", error))
}

#[tauri::command]
async fn sync_rename_peer(id: String, name: String, state: State<'_, AppState>) -> Result<(), String> {
    let sync = state.sync.clone();
    let result = blocking(move || running(&sync).and_then(|service| service.rename_peer(&id, &name))).await?;
    result.map_err(|error| sync_failed(&state.logger, "rename device", error))
}

#[tauri::command]
async fn sync_set_wifi_only(id: String, only: bool, state: State<'_, AppState>) -> Result<(), String> {
    let sync = state.sync.clone();
    let result = blocking(move || running(&sync).and_then(|service| service.set_wifi_only(&id, only))).await?;
    result.map_err(|error| sync_failed(&state.logger, "wifi only", error))
}

/// The interface tells the service whether the system is on Wi-Fi (see `Service::set_on_wifi`).
#[tauri::command]
async fn sync_set_on_wifi(on_wifi: bool, state: State<'_, AppState>) -> Result<(), String> {
    let sync = state.sync.clone();
    let result = blocking(move || {
        running(&sync).map(|service| service.set_on_wifi(on_wifi))
    })
    .await?;
    result.map_err(|error| sync_failed(&state.logger, "network kind", error))
}

fn vault_root(state: &AppState) -> Result<PathBuf, String> {
    let guard = state.vault.lock().map_err(|_| "io".to_string())?;
    guard.as_ref().map(|vault| vault.root().to_path_buf()).ok_or_else(|| "no_vault".to_string())
}

/// One number that changes when something in the open folder changes (a page saved by another
/// program, a sync that wrote files). Hex text, because a 64-bit number does not fit in a
/// JavaScript number. It reads names and times only, so it is cheap to ask every few seconds.
#[tauri::command(async)]
fn vault_signature(state: State<AppState>) -> Result<String, String> {
    let root = vault_root(&state)?;
    Ok(format!("{:x}", watch::signature(&root)))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ConflictReply {
    copy: String,
    original: String,
    device: String,
    date: String,
    is_page: bool,
}

/// The copies a sync made when two devices changed the same page.
#[tauri::command(async)]
fn conflicts_list(state: State<AppState>) -> Result<Vec<ConflictReply>, String> {
    let root = vault_root(&state)?;
    let items = conflicts::list(&root).map_err(|error| sync_failed(&state.logger, "list conflicts", error))?;
    Ok(items
        .into_iter()
        .map(|c| ConflictReply { copy: c.copy, original: c.original, device: c.device, date: c.date, is_page: c.is_page })
        .collect())
}

/// Keeps one version of a conflicted page: `keep` is "page" (the copy goes to the trash) or
/// "copy" (the copy's text becomes the page, the old text goes to the trash). Returns false
/// when something changed in the meantime and nothing was done.
#[tauri::command(async)]
fn conflict_settle(copy: String, keep: String, state: State<AppState>) -> Result<bool, String> {
    let keep = match keep.as_str() {
        "page" => Keep::Page,
        "copy" => Keep::Copy,
        _ => return Err("invalid_path".to_string()),
    };
    let root = vault_root(&state)?;
    conflicts::settle(&root, &copy, keep)
        .map(|done| done == Done::Applied)
        .map_err(|error| sync_failed(&state.logger, "settle conflict", error))
}

/// Starts the automatic syncing: a background thread that every little while asks the sync
/// service whether a paired device is due. The service itself decides, and does nothing (not
/// even listen on the network) when nothing is due, when sync is off or paused, or when no
/// folder is open.
fn start_auto_sync(app: tauri::AppHandle) {
    std::thread::spawn(move || loop {
        std::thread::sleep(std::time::Duration::from_secs(20));
        let state = app.state::<AppState>();
        let Some(service) = state.sync.service() else { return };
        for result in service.auto_sync_tick(std::time::Duration::from_secs(3)) {
            match result.outcome {
                Ok(report) => state.logger.log(Level::Info, &format!("automatic sync done, {} files changed", report.changed())),
                Err(code) => state.logger.log(Level::Warn, &format!("automatic sync failed: {code}")),
            }
        }
    });
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
    let store = secure::make_store(&data_dir);
    let sync = Arc::new(Manager::start(&data_dir, store.as_ref()));
    if let Some(problem) = sync.problem() {
        logger.log(Level::Warn, &format!("sync is not available: {problem}"));
    }
    logger.log(Level::Info, "app started");
    Ok(AppState {
        vault: Mutex::new(None),
        logger,
        settings_file: data_dir.join("settings.json"),
        default_vault,
        data_dir,
        sync,
    })
}

// On Linux the web view (WebKitGTK) draws the window through a faster path that, on the
// owner's laptop, draws all text bolder as soon as a page is long enough to scroll. Turning
// that path off fixed it, and Tauri's own Linux notes describe this setting. The price is
// somewhat slower drawing. It must be set before the web view exists. A value the person has
// already set is left alone, even "0", so it can still be switched back from a terminal.
// The two functions are given the environment as arguments so a test can check them.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
const WEBVIEW_DEFAULTS: [(&str, &str); 1] = [("WEBKIT_DISABLE_DMABUF_RENDERER", "1")];

#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn apply_webview_defaults(is_set: impl Fn(&str) -> bool, mut set: impl FnMut(&str, &str)) {
    for (name, value) in WEBVIEW_DEFAULTS {
        if !is_set(name) {
            set(name, value);
        }
    }
}

/// The plugin that writes this program into the computer's login list. It is only used from
/// our own commands in `tray.rs`; the window's scripts get no permission to call it directly.
/// Android has no such list, so there the plugin is an empty one.
#[cfg(desktop)]
fn autostart_plugin() -> tauri::plugin::TauriPlugin<tauri::Wry> {
    tauri_plugin_autostart::init(tauri_plugin_autostart::MacosLauncher::LaunchAgent, None)
}
#[cfg(not(desktop))]
fn autostart_plugin() -> tauri::plugin::TauriPlugin<tauri::Wry> {
    tauri::plugin::Builder::new("autostart-unused").build()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[cfg(target_os = "linux")]
    apply_webview_defaults(
        |name| std::env::var_os(name).is_some(),
        |name, value| std::env::set_var(name, value),
    );
    // Startup is the one place where giving up is allowed: without a window there is
    // nothing to show. We still report why, instead of panicking with unwrap/expect.
    let result = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(autostart_plugin())
        .setup(|app| {
            let state = build_state(app)?;
            app.manage(state);
            start_auto_sync(app.handle().clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            open_vault,
            open_default_vault,
            default_vault_path,
            vault_tree,
            read_note,
            write_note,
            read_canvas,
            write_canvas,
            read_folder_icons,
            write_folder_icons,
            create_note,
            create_folder,
            rename_entry,
            move_entry,
            save_attachment,
            read_attachment,
            write_page_text,
            read_page_text,
            export_obsidian_copy,
            tray::tray_set,
            tray::hide_main_window,
            tray::autostart_get,
            tray::autostart_set,
            backup_make,
            backup_list,
            backup_restore,
            export_page,
            get_sync_settings,
            set_sync_settings,
            sync_status,
            sync_start_pairing,
            sync_stop_pairing,
            sync_join,
            sync_find,
            sync_remove_peer,
            sync_compare,
            sync_run,
            sync_set_paused,
            sync_rename_peer,
            sync_set_wifi_only,
            sync_set_on_wifi,
            vault_signature,
            conflicts_list,
            conflict_settle,
            trash_entry,
            trash_list,
            trash_restore,
            trash_delete_forever,
            trash_empty,
            search_vault,
            backlinks,
            page_index,
            history_list,
            history_read,
            history_keep_now,
            history_clear,
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    #[test]
    fn the_web_view_setting_is_added_when_it_is_missing() {
        let set_calls = RefCell::new(Vec::new());
        apply_webview_defaults(
            |_| false,
            |name, value| set_calls.borrow_mut().push((name.to_string(), value.to_string())),
        );
        assert_eq!(
            set_calls.into_inner(),
            vec![("WEBKIT_DISABLE_DMABUF_RENDERER".to_string(), "1".to_string())]
        );
    }

    #[test]
    fn a_setting_the_person_made_is_left_alone_even_when_it_is_zero() {
        let called = RefCell::new(false);
        apply_webview_defaults(|_| true, |_, _| *called.borrow_mut() = true);
        assert!(!called.into_inner());
    }
}
