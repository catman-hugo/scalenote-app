// Looking for a newer version. The only thing this file does with the network is one GET of
// the public list of releases on GitHub. It sends no vault data, no cookies and no referrer,
// and everything that comes back is treated as untrusted: size-limited, checked, and only
// ever shown as plain text (never as html).

export const RELEASES_URL = "https://api.github.com/repos/catman-hugo/scalenote-app/releases?per_page=20";
// The only addresses a "download" button may open.
export const RELEASE_PAGE = "https://github.com/catman-hugo/scalenote-app/releases";
export const MAX_RESPONSE_BYTES = 512 * 1024;
export const MAX_NOTES_CHARS = 8000;
export const CHECK_EVERY_MS = 12 * 60 * 60 * 1000;

/** "v1.2.3" or "1.2.3" becomes [1, 2, 3]. Anything else (including pre-release tags) is null. */
export function parseVersion(text) {
  const match = /^v?(\d{1,6})\.(\d{1,6})\.(\d{1,6})$/.exec(String(text || "").trim());
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

export function compareVersions(a, b) {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  }
  return 0;
}

/** The address to open for a release: its own page if GitHub's answer is the expected kind of address, else the list. */
export function safeReleaseUrl(value) {
  return typeof value === "string" && value.length < 300 && value.startsWith(`${RELEASE_PAGE}/`) && !/[\s"'<>\\]/.test(value) ? value : RELEASE_PAGE;
}

/** The newest published (not draft, not pre-release) release that is newer than `current`, or null. */
export function newestRelease(list, current) {
  const have = parseVersion(current);
  if (!have || !Array.isArray(list)) return null;
  let best = null;
  for (const item of list) {
    if (!item || typeof item !== "object" || item.draft === true || item.prerelease === true) continue;
    const version = parseVersion(item.tag_name);
    if (!version || compareVersions(version, have) <= 0) continue;
    if (best && compareVersions(version, best.parsed) <= 0) continue;
    best = {
      parsed: version,
      version: version.join("."),
      url: safeReleaseUrl(item.html_url),
      notes: typeof item.body === "string" ? item.body.slice(0, MAX_NOTES_CHARS) : "",
    };
  }
  if (!best) return null;
  const { parsed, ...release } = best;
  return release;
}

// Reads at most `max` bytes of the answer, so a huge or endless reply cannot fill memory.
export async function readLimited(response, max = MAX_RESPONSE_BYTES) {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > max) throw new Error("update list too large");
  if (!response.body || !response.body.getReader) {
    const text = await response.text();
    if (text.length > max) throw new Error("update list too large");
    return text;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > max) {
      await reader.cancel();
      throw new Error("update list too large");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return new TextDecoder().decode(bytes);
}

/** Resolves to { release } (a newer one) or { release: null }. Rejects when GitHub cannot be reached or answers oddly. */
export async function checkForUpdate({ current, fetchImpl = globalThis.fetch, timeoutMs = 10000 }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(RELEASES_URL, {
      method: "GET",
      headers: { Accept: "application/vnd.github+json" },
      credentials: "omit",
      referrerPolicy: "no-referrer",
      cache: "no-store",
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`update list answered ${response.status}`);
    const list = JSON.parse(await readLimited(response));
    return { release: newestRelease(list, current) };
  } finally {
    clearTimeout(timer);
  }
}

export function shouldCheck({ enabled, lastCheck, now = Date.now() }) {
  if (!enabled) return false;
  return !(Number.isFinite(lastCheck) && lastCheck > 0 && now - lastCheck < CHECK_EVERY_MS && now >= lastCheck);
}
