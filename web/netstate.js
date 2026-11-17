// What kind of network the phone is on, for "sync on Wi-Fi only" (one setting per paired device).
//
// Only the Android app can tell: its native side offers one object, ScaleNoteNetwork, with one
// yes-or-no question (is this Wi-Fi or a wired connection?). Everywhere else the object is missing,
// the question is not asked and nothing is ever blocked, so the setting is not offered there.
// The page reports the answer to the sync service, which does the blocking (a sync by hand and
// an automatic one alike), so the rule is the same however a sync starts.

export const MAX_WIFI_ONLY = 16;
const ID = /^[0-9a-f]{64}$/;

/** Reads the saved list from untrusted json: only device ids, each once, not too many. */
export function cleanWifiOnly(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const item of raw) {
    if (typeof item === "string" && ID.test(item) && !out.includes(item)) out.push(item);
    if (out.length === MAX_WIFI_ONLY) break;
  }
  return out;
}

export function withWifiOnly(list, id, on) {
  const rest = cleanWifiOnly(list).filter((item) => item !== id);
  return cleanWifiOnly(on ? [...rest, id] : rest);
}

function bridge() {
  const win = typeof window === "undefined" ? null : window;
  const candidate = win && win.ScaleNoteNetwork;
  return candidate && typeof candidate.isWifi === "function" ? candidate : null;
}

export function canTellNetwork() {
  return bridge() !== null;
}

/** True on Wi-Fi or wired, and whenever the system cannot say. */
export function onWifi() {
  const native = bridge();
  if (!native) return true;
  try {
    return native.isWifi() !== false;
  } catch {
    return true;
  }
}

/**
 * Tells `report(boolean)` the current answer now, and again whenever it changes. The system
 * offers no event to the page, so it is asked every few seconds and when the browser says the
 * connection came or went. Returns a function that stops it.
 */
export function watchNetwork(report, { every = 5000 } = {}) {
  let last = null;
  const check = () => {
    const now = onWifi();
    if (now === last) return;
    last = now;
    Promise.resolve(report(now)).catch(() => { last = null; });
  };
  check();
  const timer = setInterval(check, every);
  window.addEventListener("online", check);
  window.addEventListener("offline", check);
  return () => {
    clearInterval(timer);
    window.removeEventListener("online", check);
    window.removeEventListener("offline", check);
  };
}
