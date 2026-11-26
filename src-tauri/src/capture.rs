//! Things that arrive from outside the window (0.6.6): files from "Open with" and "Send to" on
//! a computer, files and text from Android's share menu, text from the clipboard, and "New page"
//! from the tray, the global shortcut or the Android home-screen shortcut.
//!
//! They are kept here, in Rust, in a short waiting list, because they can arrive while there is
//! no window (the tray takes the window away when it is closed, and a second start of the
//! program hands its files to this one and ends). The window asks for the list every few
//! seconds and when it comes to the front, shows a small "Add to ScaleNote" box, and then asks
//! Rust to add the chosen things (core/src/capture.rs does the checking and the writing).
//!
//! Limits: at most `MAX_WAITING` things wait; a file is only read when it is added, and only if
//! it is a regular file of at most `MAX_FILE_BYTES`. On Android a shared file is first copied by
//! the app itself into its own cache (`cache/scalenote-shared`, see patch-android.mjs); only
//! files in that folder are taken from there, and they are removed once added or dismissed.

use crate::{lock, AppState};
use scalenote_core::attachments::MAX_PDF_BYTES;
use scalenote_core::capture::{from_shared_text, Item, Target, DEFAULT_INBOX, MAX_TEXT_BYTES};
use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::{AppHandle, Manager, State};

pub const MAX_WAITING: usize = 100;
/// Dropped files wait in memory; together they never take more than this.
const MAX_WAITING_BYTES: usize = 128 * 1024 * 1024;
const MAX_FILE_BYTES: u64 = MAX_PDF_BYTES as u64;
/// The folder (inside the app's cache) the Android side copies shared files into.
pub const ANDROID_SHARE_DIR: &str = "scalenote-shared";

enum What {
    File { path: PathBuf, name: String, size: u64, cached: bool },
    Text { text: String, subject: Option<String> },
    /// A file dropped on the window (its bytes, read by the page).
    Bytes { name: String, bytes: Vec<u8> },
    NewPage,
}

struct Incoming {
    id: u32,
    what: What,
}

/// The waiting list, kept in the app's state.
#[derive(Default)]
pub struct Waiting {
    inner: Mutex<(u32, Vec<Incoming>)>,
}

impl Waiting {
    /// Puts something on the list; its id, or `None` when the list is full.
    fn push_id(&self, what: What) -> Option<u32> {
        let Ok(mut guard) = self.inner.lock() else { return None };
        let (next, list) = &mut *guard;
        if list.len() >= MAX_WAITING {
            return None;
        }
        if let What::Bytes { bytes, .. } = &what {
            let held: usize = list.iter().map(|i| if let What::Bytes { bytes, .. } = &i.what { bytes.len() } else { 0 }).sum();
            if held + bytes.len() > MAX_WAITING_BYTES {
                return None;
            }
        }
        *next = next.wrapping_add(1);
        list.push(Incoming { id: *next, what });
        Some(*next)
    }

    fn push(&self, what: What) -> bool {
        self.push_id(what).is_some()
    }

    /// Takes the things with these ids out of the list.
    fn take(&self, ids: &[u32]) -> Vec<Incoming> {
        let Ok(mut guard) = self.inner.lock() else { return Vec::new() };
        let (taken, kept): (Vec<_>, Vec<_>) = guard.1.drain(..).partition(|i| ids.contains(&i.id));
        guard.1 = kept;
        taken
    }

    fn put_back(&self, items: Vec<Incoming>) {
        if let Ok(mut guard) = self.inner.lock() {
            let room = MAX_WAITING.saturating_sub(guard.1.len());
            guard.1.extend(items.into_iter().take(room));
        }
    }
}

fn file_name_of(path: &Path) -> String {
    path.file_name().and_then(|n| n.to_str()).unwrap_or("file").chars().filter(|c| !c.is_control()).take(200).collect()
}

/// Adds the files named on a command line ("Open with", "Send to", a file dropped on the program's
/// icon). The first argument is the program itself; options (`-…`) and anything that is not an
/// existing regular file are skipped. Relative names are read from `cwd`, the folder the second
/// start was made in. Returns how many were added.
pub fn take_arguments(waiting: &Waiting, args: &[String], cwd: &Path) -> usize {
    let mut added = 0;
    for arg in args.iter().skip(1).filter(|a| !a.starts_with('-')).take(MAX_WAITING) {
        let path = if Path::new(arg).is_absolute() { PathBuf::from(arg) } else { cwd.join(arg) };
        let Ok(meta) = fs::metadata(&path) else { continue };
        if !meta.is_file() {
            continue;
        }
        let name = file_name_of(&path);
        if waiting.push(What::File { path, name, size: meta.len(), cached: false }) {
            added += 1;
        }
    }
    added
}

/// "New page" from the tray or the global shortcut.
pub fn ask_new_page(waiting: &Waiting) {
    waiting.push(What::NewPage);
}

/// One waiting thing as the window shows it.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IncomingReply {
    id: u32,
    /// file, text or newPage.
    kind: &'static str,
    /// The file's name, or the first words of the text.
    label: String,
    size: u64,
}

#[tauri::command]
pub fn capture_pending(state: State<'_, AppState>, waiting: State<'_, Waiting>) -> Result<Vec<IncomingReply>, String> {
    lock::refuse_if_locked(&state)?;
    let guard = waiting.inner.lock().map_err(|_| "io".to_string())?;
    Ok(guard
        .1
        .iter()
        .map(|i| match &i.what {
            What::File { name, size, .. } => IncomingReply { id: i.id, kind: "file", label: name.clone(), size: *size },
            What::Text { text, subject } => {
                let first = subject.clone().unwrap_or_else(|| text.lines().map(str::trim).find(|l| !l.is_empty()).unwrap_or("").to_string());
                IncomingReply { id: i.id, kind: "text", label: first.chars().filter(|c| !c.is_control()).take(120).collect(), size: text.len() as u64 }
            }
            What::Bytes { name, bytes } => IncomingReply { id: i.id, kind: "file", label: name.clone(), size: bytes.len() as u64 },
            What::NewPage => IncomingReply { id: i.id, kind: "newPage", label: String::new(), size: 0 },
        })
        .collect())
}

/// Text from the clipboard or Android's share menu, to be added like anything else. Returns its
/// id on the waiting list.
#[tauri::command]
pub fn capture_offer_text(text: String, subject: Option<String>, state: State<'_, AppState>, waiting: State<'_, Waiting>) -> Result<u32, String> {
    lock::refuse_if_locked(&state)?;
    if text.trim().is_empty() {
        return Err("empty".to_string());
    }
    if text.len() > MAX_TEXT_BYTES || subject.as_ref().is_some_and(|s| s.len() > 1000) {
        return Err("too_large".to_string());
    }
    waiting.push_id(What::Text { text, subject }).ok_or_else(|| "too_many".to_string())
}

/// A new empty page in the inbox folder (empty: `Inbox`), named by the interface.
#[tauri::command]
pub fn capture_new_page(folder: Option<String>, title: String, state: State<'_, AppState>) -> Result<String, String> {
    let folder = folder.filter(|f| !f.trim().is_empty()).unwrap_or_else(|| DEFAULT_INBOX.to_string());
    crate::with_vault(&state, "new page", |vault| vault.new_page_in(&folder, &title))
}

/// A file dropped on the page list (0.6.6): its name and bytes (base64, like `save_attachment`).
#[tauri::command]
pub fn capture_offer_bytes(name: String, data: String, state: State<'_, AppState>, waiting: State<'_, Waiting>) -> Result<(), String> {
    lock::refuse_if_locked(&state)?;
    // The length is checked before decoding, so a huge text is never turned into bytes.
    if data.len() > scalenote_core::attachments::MAX_ATTACHMENT_BASE64 {
        return Err("too_large".to_string());
    }
    let bytes = crate::base64::decode(&data).ok_or_else(|| "unsupported_type".to_string())?;
    let name: String = name.chars().filter(|c| !c.is_control()).take(200).collect();
    if waiting.push(What::Bytes { name, bytes }) {
        Ok(())
    } else {
        Err("too_many".to_string())
    }
}

/// Whether `path` is a file the Android side copied into the app's share folder: a regular file
/// directly inside a folder named `scalenote-shared` that is itself in a folder named `cache`.
fn in_android_share_dir(path: &Path) -> Option<PathBuf> {
    let real = fs::canonicalize(path).ok()?;
    let folder = real.parent()?;
    let ok = folder.file_name()? == ANDROID_SHARE_DIR && folder.parent()?.file_name()? == "cache" && fs::symlink_metadata(&real).ok()?.is_file();
    ok.then_some(real)
}

/// A file Android shared with the app, already copied into the app's own share folder.
#[tauri::command]
pub fn capture_android_file(path: String, name: String, state: State<'_, AppState>, waiting: State<'_, Waiting>) -> Result<(), String> {
    lock::refuse_if_locked(&state)?;
    let real = in_android_share_dir(Path::new(&path)).ok_or_else(|| "invalid_path".to_string())?;
    let size = fs::metadata(&real).map_err(|_| "io".to_string())?.len();
    let name: String = name.chars().filter(|c| !c.is_control()).take(200).collect();
    let name = if name.trim().is_empty() { file_name_of(&real) } else { name };
    if waiting.push(What::File { path: real, name, size, cached: true }) {
        Ok(())
    } else {
        Err("too_many".to_string())
    }
}

/// What happened when things were added.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AddedReply {
    /// The page they are in now (empty when only "New page" was asked: the window makes it).
    page: String,
    /// Things that could not be added: name and reason code.
    refused: Vec<(String, String)>,
    new_page: bool,
}

/// Reads one waiting file into memory, within the limits.
fn read_file(path: &Path) -> Result<Vec<u8>, &'static str> {
    let meta = fs::metadata(path).map_err(|_| "gone")?;
    if !meta.is_file() {
        return Err("gone");
    }
    if meta.len() > MAX_FILE_BYTES {
        return Err("too_large");
    }
    let bytes = fs::read(path).map_err(|_| "gone")?;
    if bytes.len() as u64 > MAX_FILE_BYTES {
        return Err("too_large");
    }
    Ok(bytes)
}

/// Removes a copy the Android side made, once it is no longer needed.
fn forget_copy(incoming: &Incoming) {
    if let What::File { path, cached: true, .. } = &incoming.what {
        let _ = fs::remove_file(path);
    }
}

/// Adds the waiting things with these ids. `to_page`: the end of this page; otherwise a new page
/// in `folder` (empty: the Inbox folder).
#[tauri::command(async)]
pub fn capture_add(ids: Vec<u32>, to_page: Option<String>, folder: Option<String>, state: State<'_, AppState>, waiting: State<'_, Waiting>) -> Result<AddedReply, String> {
    lock::refuse_if_locked(&state)?;
    let taken = waiting.take(&ids);
    if taken.is_empty() {
        return Err("gone".to_string());
    }
    let new_page = taken.iter().any(|i| matches!(i.what, What::NewPage));
    let mut items = Vec::new();
    let mut refused: Vec<(String, String)> = Vec::new();
    for incoming in &taken {
        match &incoming.what {
            What::File { path, name, .. } => match read_file(path) {
                Ok(bytes) => items.push(Item::File { name: name.clone(), bytes }),
                Err(reason) => refused.push((name.clone(), reason.to_string())),
            },
            What::Text { text, subject } => items.push(from_shared_text(text, subject.as_deref())),
            What::Bytes { name, bytes } => items.push(Item::File { name: name.clone(), bytes: bytes.clone() }),
            What::NewPage => {}
        }
    }
    if items.is_empty() {
        taken.iter().for_each(forget_copy);
        return Ok(AddedReply { page: String::new(), refused, new_page });
    }
    let target = match to_page.filter(|p| !p.is_empty()) {
        Some(page) => Target::EndOf(page),
        None => Target::NewPageIn(folder.filter(|f| !f.trim().is_empty()).unwrap_or_else(|| DEFAULT_INBOX.to_string())),
    };
    let result = crate::with_vault(&state, "add shared", |vault| vault.add_shared(&target, items));
    match result {
        Ok(added) => {
            taken.iter().for_each(forget_copy);
            refused.extend(added.refused.into_iter().map(|(n, r)| (n, r.to_string())));
            Ok(AddedReply { page: added.page, refused, new_page })
        }
        Err(code) => {
            // Nothing was added: the things wait again, so a second try (for example after the
            // open page was saved) needs nothing shared again.
            waiting.put_back(taken);
            Err(code)
        }
    }
}

/// Drops waiting things without adding them.
#[tauri::command]
pub fn capture_dismiss(ids: Vec<u32>, waiting: State<'_, Waiting>) {
    waiting.take(&ids).iter().for_each(forget_copy);
}

/// The shortcut that opens a new page from anywhere on the computer (0.6.6), off by default. The
/// interface sends the setting at every start. Linux sessions on Wayland do not allow global
/// shortcuts; there the answer is "unsupported" and the interface says so.
pub const QUICK_SHORTCUT: &str = "CommandOrControl+Alt+N";

#[tauri::command]
pub fn shortcut_set(app: AppHandle, enabled: bool) -> Result<(), String> {
    #[cfg(desktop)]
    {
        use tauri_plugin_global_shortcut::GlobalShortcutExt;
        let shortcuts = app.global_shortcut();
        let on = shortcuts.is_registered(QUICK_SHORTCUT);
        if enabled == on {
            return Ok(());
        }
        let result = if enabled { shortcuts.register(QUICK_SHORTCUT) } else { shortcuts.unregister(QUICK_SHORTCUT) };
        result.map_err(|error| {
            eprintln!("the shortcut could not be changed: {error}");
            "unsupported".to_string()
        })
    }
    #[cfg(not(desktop))]
    {
        let _ = (app, enabled);
        Err("unsupported".to_string())
    }
}

/// What the shortcut does when pressed: the window comes to the front with a new page.
#[cfg(desktop)]
pub fn on_shortcut(app: &AppHandle) {
    if let Some(waiting) = app.try_state::<Waiting>() {
        ask_new_page(&waiting);
    }
    crate::tray::show_main(app);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("sn-app-capture-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).expect("dir");
        dir
    }

    #[test]
    fn command_line_files_are_taken_and_everything_else_skipped() {
        let dir = scratch("args");
        fs::write(dir.join("scan.pdf"), b"%PDF").expect("file");
        fs::create_dir_all(dir.join("folder")).expect("dir");
        let waiting = Waiting::default();
        let args: Vec<String> = ["ScaleNote.exe", "--minimized", "scan.pdf", "folder", "missing.png", &dir.join("scan.pdf").to_string_lossy()].iter().map(|s| s.to_string()).collect();
        assert_eq!(take_arguments(&waiting, &args, &dir), 2, "a relative and an absolute name of the same file");
        let taken = waiting.take(&[1, 2]);
        assert!(taken.iter().all(|i| matches!(&i.what, What::File { name, size: 4, cached: false, .. } if name == "scan.pdf")));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_waiting_list_is_limited_and_taking_removes_only_what_was_asked() {
        let waiting = Waiting::default();
        for _ in 0..MAX_WAITING + 5 {
            ask_new_page(&waiting);
        }
        assert_eq!(waiting.inner.lock().expect("lock").1.len(), MAX_WAITING);
        assert_eq!(waiting.take(&[1, 3, 9999]).len(), 2);
        assert_eq!(waiting.inner.lock().expect("lock").1.len(), MAX_WAITING - 2);
    }

    #[test]
    fn only_files_in_the_android_share_folder_are_taken_from_android() {
        let dir = scratch("android");
        let share = dir.join("cache").join(ANDROID_SHARE_DIR);
        fs::create_dir_all(&share).expect("dir");
        fs::write(share.join("a.png"), b"x").expect("file");
        fs::write(dir.join("secret.txt"), b"x").expect("file");
        fs::create_dir_all(share.join("sub")).expect("dir");
        fs::write(share.join("sub/b.png"), b"x").expect("file");
        assert!(in_android_share_dir(&share.join("a.png")).is_some());
        for bad in [dir.join("secret.txt"), share.join("../../secret.txt"), share.join("sub/b.png"), share.join("missing.png"), share.clone()] {
            assert!(in_android_share_dir(&bad).is_none(), "{bad:?}");
        }
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(dir.join("secret.txt"), share.join("link.png")).expect("link");
            assert!(in_android_share_dir(&share.join("link.png")).is_none(), "a link out of the folder");
        }
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_file_too_large_or_gone_is_refused_when_read() {
        let dir = scratch("read");
        assert_eq!(read_file(&dir.join("missing")), Err("gone"));
        assert_eq!(read_file(&dir), Err("gone"));
        fs::write(dir.join("ok"), b"abc").expect("file");
        assert_eq!(read_file(&dir.join("ok")), Ok(b"abc".to_vec()));
        let _ = fs::remove_dir_all(&dir);
    }
}
