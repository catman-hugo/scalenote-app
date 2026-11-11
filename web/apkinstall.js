// Installing an update from inside the app, Android only. The native side (ApkInstaller.kt,
// written by scripts/patch-android.mjs) downloads the .apk and hands it to Android's own
// installer, which still asks the user to confirm. This file only checks the address and
// passes it on; it never touches the file. Where the native side is missing (every system
// except the Android app) nothing here does anything and the browser download is used.

// Same rule as the native side, which checks again: only a file of this project's releases.
const PREFIX = "https://github.com/catman-hugo/scalenote-app/releases/download/";

export function isInstallableUrl(url) {
  return (
    typeof url === "string" &&
    url.length < 400 &&
    url.startsWith(PREFIX) &&
    url.toLowerCase().endsWith(".apk") &&
    !url.includes("..") &&
    !/[\s"'<>\\?#]/.test(url)
  );
}

/** The native installer object, or null when this is not the Android app. */
export function installerOf(win) {
  const bridge = win && win.ScaleNoteInstaller;
  return bridge && typeof bridge.install === "function" ? bridge : null;
}

/**
 * Starts the install. `onStatus` gets one of: "downloading", "needs-permission", "installing",
 * "error". Returns false when it could not even start, so the caller can use the browser.
 */
export function startInstall(win, url, onStatus) {
  const bridge = installerOf(win);
  if (!bridge || !isInstallableUrl(url)) return false;
  win.__scalenoteInstallStatus = (status) => {
    if (["downloading", "needs-permission", "installing", "error"].includes(status)) onStatus(status);
  };
  try {
    bridge.install(url);
    return true;
  } catch {
    return false;
  }
}
