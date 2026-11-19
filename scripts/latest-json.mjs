// Writes latest.json for a release: for each kind of computer installer, where to download it
// and its signature. The app reads this file to update itself (src-tauri/src/selfupdate.rs).
//
// Usage: node scripts/latest-json.mjs <tag> <folder with the built files> <assets.json>
//   assets.json is the release's file list from the GitHub API (name, size, browser_download_url).
//
// The keys name the kind of file ("windows-x86_64-msi", "linux-x86_64-deb" and so on), so the
// app always gets the same kind it was installed from. There is no key without a kind: a copy
// that does not know how it was installed is never sent some installer by guess.
//
// GitHub changes some characters in uploaded file names (spaces, for one), so a built file is
// matched to its uploaded copy by its ending and its exact size, not by its name.

import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const KINDS = [
  ["-setup.exe", "windows-x86_64-nsis"],
  [".msi", "windows-x86_64-msi"],
  [".deb", "linux-x86_64-deb"],
  [".rpm", "linux-x86_64-rpm"],
  [".AppImage", "linux-x86_64-appimage"],
];

/** The kind key of a file name, or null. */
export function kindOf(name) {
  const found = KINDS.find(([ending]) => name.endsWith(ending));
  return found ? found[1] : null;
}

/**
 * Builds the latest.json object. `built` is a list of { name, size, signature } for each signed
 * installer; `assets` is GitHub's list of the release's files.
 */
export function latestJson(tag, built, assets, now = new Date()) {
  const platforms = {};
  for (const file of built) {
    const kind = kindOf(file.name);
    if (!kind) continue;
    const ending = KINDS.find(([, k]) => k === kind)[0];
    const match = assets.filter((asset) => asset.size === file.size && asset.name.endsWith(ending));
    if (match.length !== 1) throw new Error(`no single uploaded file matches ${file.name}`);
    platforms[kind] = { signature: file.signature.trim(), url: match[0].browser_download_url };
  }
  if (Object.keys(platforms).length === 0) throw new Error("no signed installers found");
  return { version: tag.replace(/^v/, ""), notes: "", pub_date: now.toISOString().replace(/\.\d{3}Z$/, "Z"), platforms };
}

async function main([tag, folder, assetsFile]) {
  const assets = JSON.parse(await readFile(assetsFile, "utf8"));
  const built = [];
  for (const entry of await readdir(folder, { recursive: true })) {
    if (!entry.endsWith(".sig")) continue;
    const file = path.join(folder, entry.slice(0, -4));
    const signature = await readFile(path.join(folder, entry), "utf8");
    built.push({ name: path.basename(file), size: (await stat(file)).size, signature });
  }
  process.stdout.write(JSON.stringify(latestJson(tag, built, assets), null, 2) + "\n");
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
