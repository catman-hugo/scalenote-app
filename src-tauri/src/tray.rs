//! The tray icon and "open at login" (desktop only, both off until the person turns them on).
//!
//! With the tray on, closing the window hides it instead of ending the program, so this computer
//! stays reachable for sync. The page that was open is saved by the window itself when it is
//! hidden (the interface saves whenever the window loses focus or is hidden), so nothing is lost
//! when the tray's Quit ends the program afterwards.
//!
//! Android has neither a tray nor a login list, so every command answers "unsupported" there.
//! This file is only compiled by CI (the build tools for the window toolkit are not on every
//! machine); the settings screen and its wording are tested in the browser tests.

use tauri::AppHandle;
#[cfg(desktop)]
use tauri::Manager;

#[cfg(desktop)]
use tauri::menu::{Menu, MenuItem};
#[cfg(desktop)]
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
#[cfg(desktop)]
use tauri_plugin_autostart::ManagerExt;

#[cfg(desktop)]
const TRAY_ID: &str = "scalenote-tray";
#[cfg(desktop)]
const MENU_SHOW: &str = "show";
#[cfg(desktop)]
const MENU_QUIT: &str = "quit";
/// A label longer than this is cut: the text comes from the interface, so it is not trusted blindly.
#[cfg(desktop)]
const MAX_LABEL_CHARS: usize = 60;

#[cfg(desktop)]
fn short(label: &str) -> String {
    label.chars().filter(|c| !c.is_control()).take(MAX_LABEL_CHARS).collect()
}

/// Brings the main window back from the tray (or from behind other windows). Closing the window
/// with the tray on takes the whole window away (see `hide_main_window`), so here it is made
/// again from the same settings as at start; the interface then opens the page that was open.
#[cfg(desktop)]
fn show_main(app: &AppHandle) {
    if app.get_webview_window("main").is_none() {
        let Some(config) = app.config().app.windows.iter().find(|w| w.label == "main").cloned() else { return };
        if let Err(error) = tauri::WebviewWindowBuilder::from_config(app, &config).and_then(|builder| builder.build()) {
            eprintln!("the window could not be made again: {error}");
            return;
        }
    }
    let Some(window) = app.get_webview_window("main") else { return };
    // Each step can fail on its own (for example a window that is already closed); none of them
    // is worth stopping for, the person can still use the tray menu again.
    let _ = window.show();
    let _ = window.unminimize();
    let _ = window.set_focus();
}

#[cfg(desktop)]
fn build_tray(app: &AppHandle, show_label: &str, quit_label: &str) -> Result<(), String> {
    let show = MenuItem::with_id(app, MENU_SHOW, show_label, true, None::<&str>).map_err(|e| e.to_string())?;
    let quit = MenuItem::with_id(app, MENU_QUIT, quit_label, true, None::<&str>).map_err(|e| e.to_string())?;
    let menu = Menu::with_items(app, &[&show, &quit]).map_err(|e| e.to_string())?;
    let icon = app.default_window_icon().ok_or_else(|| "no icon".to_string())?.clone();
    TrayIconBuilder::with_id(TRAY_ID)
        .icon(icon)
        .tooltip("ScaleNote")
        .menu(&menu)
        // The left click brings the window back; the menu stays on the right click.
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| {
            if event.id == MENU_SHOW {
                show_main(app);
            } else if event.id == MENU_QUIT {
                app.exit(0);
            }
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                show_main(tray.app_handle());
            }
        })
        .build(app)
        .map(|_| ())
        .map_err(|e| e.to_string())
}

/// Turns the tray icon on or off. Labels come from the language file in the interface.
#[tauri::command]
pub fn tray_set(app: AppHandle, enabled: bool, show_label: String, quit_label: String) -> Result<(), String> {
    #[cfg(desktop)]
    {
        if !enabled {
            // Dropping the returned icon removes it from the tray.
            drop(app.remove_tray_by_id(TRAY_ID));
            show_main(&app);
            return Ok(());
        }
        if app.tray_by_id(TRAY_ID).is_some() {
            return Ok(());
        }
        build_tray(&app, &short(&show_label), &short(&quit_label)).map_err(|error| {
            eprintln!("tray could not be made: {error}");
            "io".to_string()
        })
    }
    #[cfg(not(desktop))]
    {
        let _ = (app, enabled, show_label, quit_label);
        Err("unsupported".to_string())
    }
}

/// Takes the window away when it is closed while the tray is on (since 0.6.1). It used to be only
/// hidden, which kept the whole web view running (about 100 MB, the "WebKitWebProcess" on Linux)
/// for nothing. Sync runs in Rust, not in the window, so it goes on; `keeps_running` stops the
/// program from ending now that no window is left, and the tray makes the window again.
#[tauri::command]
pub fn hide_main_window(app: AppHandle) -> Result<(), String> {
    #[cfg(desktop)]
    {
        let window = app.get_webview_window("main").ok_or_else(|| "not_found".to_string())?;
        window.destroy().map_err(|_| "io".to_string())
    }
    #[cfg(not(desktop))]
    {
        let _ = app;
        Err("unsupported".to_string())
    }
}

/// Zooms the whole window (1.0 is 100%), so text, pictures and drawings grow together. The
/// interface keeps the value in its settings and sends it again at every start.
#[tauri::command]
pub fn set_zoom(app: AppHandle, scale: f64) -> Result<(), String> {
    #[cfg(desktop)]
    {
        // The interface only offers 80% to 200%; anything else is refused, never guessed at.
        if !scale.is_finite() || !(0.8..=2.0).contains(&scale) {
            return Err("invalid_path".to_string());
        }
        let window = app.get_webview_window("main").ok_or_else(|| "not_found".to_string())?;
        window.set_zoom(scale).map_err(|_| "io".to_string())
    }
    #[cfg(not(desktop))]
    {
        let _ = (app, scale);
        Err("unsupported".to_string())
    }
}

/// Whether the computer's own list of programs to start at login holds this one.
#[tauri::command]
pub fn autostart_get(app: AppHandle) -> Result<bool, String> {
    #[cfg(desktop)]
    {
        app.autolaunch().is_enabled().map_err(|error| {
            eprintln!("login list could not be read: {error}");
            "io".to_string()
        })
    }
    #[cfg(not(desktop))]
    {
        let _ = app;
        Err("unsupported".to_string())
    }
}

/// Adds or removes this program in the computer's list of programs to start at login.
#[tauri::command]
pub fn autostart_set(app: AppHandle, enabled: bool) -> Result<bool, String> {
    #[cfg(desktop)]
    {
        let manager = app.autolaunch();
        let done = if enabled { manager.enable() } else { manager.disable() };
        done.map_err(|error| {
            eprintln!("login list could not be changed: {error}");
            "io".to_string()
        })?;
        manager.is_enabled().map_err(|_| "io".to_string())
    }
    #[cfg(not(desktop))]
    {
        let _ = (app, enabled);
        Err("unsupported".to_string())
    }
}

/// Whether the program should keep running when its last window has gone: only while the tray
/// icon is there, and only when the person closed the window (the tray's Quit and an update ask
/// to end with an exit code, and then the program ends).
pub fn keeps_running(app: &AppHandle, code: Option<i32>) -> bool {
    #[cfg(desktop)]
    {
        code.is_none() && app.tray_by_id(TRAY_ID).is_some()
    }
    #[cfg(not(desktop))]
    {
        let _ = (app, code);
        false
    }
}

