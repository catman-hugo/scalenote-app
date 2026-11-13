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

const TOP = 2 ** 40; // far above any real file; keeps odd numbers from the native side harmless

/**
 * Turns the two numbers from the native side into something safe to show, or null when they make
 * no sense. `total` is 0 when the size is not known.
 */
export function cleanProgress(done, total) {
  if (typeof done !== "number" || !Number.isFinite(done) || done < 0 || done > TOP) return null;
  let all = typeof total === "number" && Number.isFinite(total) && total > 0 && total <= TOP ? total : 0;
  if (all > 0 && done > all) all = done;
  return { done, total: all, percent: all > 0 ? Math.min(100, Math.floor((done / all) * 100)) : null };
}

/**
 * Starts the install. `onStatus` gets one of: "downloading", "needs-permission", "installing",
 * "error". `onProgress` gets `{ done, total, percent }` while the file comes in. Returns false
 * when it could not even start, so the caller can use the browser.
 */
export function startInstall(win, url, onStatus, onProgress = () => {}) {
  const bridge = installerOf(win);
  if (!bridge || !isInstallableUrl(url)) return false;
  win.__scalenoteInstallStatus = (status) => {
    if (["downloading", "needs-permission", "installing", "error"].includes(status)) onStatus(status);
  };
  win.__scalenoteInstallProgress = (done, total) => {
    const progress = cleanProgress(done, total);
    if (progress) onProgress(progress);
  };
  try {
    bridge.install(url);
    return true;
  } catch {
    return false;
  }
}
