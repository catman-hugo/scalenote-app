// The app logic lives in a library so desktop and Android can share one entry point.

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Startup is the one place where giving up is allowed: without a window there is
    // nothing to show. We still report why, instead of panicking with unwrap/expect.
    if let Err(error) = tauri::Builder::default().run(tauri::generate_context!()) {
        eprintln!("ScaleNote spike failed to start: {error}");
        std::process::exit(1);
    }
}
