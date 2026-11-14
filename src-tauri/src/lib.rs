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
        .setup(|app| {
            let state = build_state(app)?;
            app.manage(state);
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
            export_obsidian_copy,
            export_page,
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
