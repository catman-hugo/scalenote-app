// Wires the screens together: settings, the folder, the note list, the editor and saving.

import { openUrl } from "@tauri-apps/plugin-opener";
import { applyAppearance, DEFAULT_APPEARANCE, normalizeAppearance } from "./appearance.js";
import { openSettings } from "./settings.js";
import { checkForUpdate, platformOf, shouldCheck } from "./updates.js";
import { renderNotes } from "./whatsnew.js";
import { openFolderMenu } from "./foldermenu.js";
import { addRecent, cleanRecent, removeRecent } from "./recent.js";
import { backend, BackendError } from "./backend.js";
import { composeNote, loadNote } from "./compose.js";
import { newNoteId, withNoteId } from "./blocks.js";
import { Autosave } from "./autosave.js";
import { createEditor } from "./editor.js";
import { createBacklinks } from "./backlinks.js";
import { createCover } from "./cover.js";
import { readCover, withCover, withoutCover } from "./coverrules.js";
import { updateWikilinks } from "./wikilinks.js";
import { createResolver } from "./wikilinkrules.js";
import { icon } from "./icons.js";
import { renderTree } from "./sidebar.js";
import { openContextMenu } from "./contextmenu.js";
import { openPalette, SEARCH_LIMIT } from "./palette.js";
import { openTrash } from "./trashdialog.js";
import { canMoveInto, enableTreeDrag } from "./treedrag.js";
import { choosePicture, pathForVault, storePicture } from "./images.js";
import { strings } from "./strings.js";

const SAVE_DELAY_MS = 600;
const BACKLINK_DELAY_MS = 300;
const isAndroid = /Android/i.test(navigator.userAgent);

const el = (id) => document.getElementById(id);

const app = {
  settings: { vaultPath: null, recentVaults: [], disclosureAccepted: false, aiEnabled: false, ...DEFAULT_APPEARANCE, updates: true, showBacklinks: true, showCovers: false, lastSeenVersion: null, lastUpdateCheck: 0, dismissedUpdate: "" },
  entries: [],
  expanded: new Set(),
  selectedFolder: "",
  // The open note: path, last known version on disk, and the parts kept for saving.
  current: null,
  lastSavedText: null,
  editor: null,
  autosave: null,
  // "editor" shows blocks, "source" shows the whole note as markdown text. The choice stays
  // when another note is opened.
  mode: "editor",
  // The line ending of the note in source view; a text box always uses "\n" inside.
  lineEnding: "\n",
  // Pages opened in this session, newest first, for the search box before anything is typed.
  recent: [],
  // The "Linked from" list under the open page, and a counter that lets a slow answer for a
  // page that is no longer open be dropped.
  backlinks: null,
  cover: null,
  backlinkRun: 0,
  backlinkTimer: 0,
  following: false,
};

// ---------- small helpers ----------

function errorText(error) {
  const code = error instanceof BackendError ? error.code : "unknown";
  return strings.errors[code] || strings.errors.unknown;
}

function logProblem(what, error) {
  const code = error instanceof BackendError ? error.code : "unexpected";
  backend.log("warn", `${what}: ${code}`);
}

function showBanner(text) {
  el("bannerText").textContent = text;
  el("banner").hidden = false;
}

function hideBanner() {
  el("banner").hidden = true;
}

let toastTimer = null;
// A short message that goes away by itself (for example "Block link copied").
function showToast(text) {
  el("toast").textContent = text;
  el("toast").hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el("toast").hidden = true), 3500);
}

function setStatus(kind) {
  const labels = {
    saved: strings.editor.saved,
    saving: strings.editor.saving,
    unsaved: strings.editor.unsaved,
    failed: strings.messages.saveFailed,
  };
  el("status").textContent = labels[kind] || "";
  el("status").dataset.state = kind;
}

function noteTitle(path) {
  return path.slice(path.lastIndexOf("/") + 1).replace(/\.md$/i, "");
}

function parentOf(path) {
  const slash = path.lastIndexOf("/");
  return slash === -1 ? "" : path.slice(0, slash);
}

// ---------- settings ----------

async function loadSettings() {
  try {
    const raw = await backend.getSettings();
    const parsed = raw ? JSON.parse(raw) : {};
    app.settings = {
      vaultPath: typeof parsed.vaultPath === "string" ? parsed.vaultPath : null,
      recentVaults: cleanRecent(parsed.recentVaults),
      disclosureAccepted: parsed.disclosureAccepted === true,
      ...normalizeAppearance(parsed),
      // One switch for both looking for updates and installing them. On unless turned off.
      updates: parsed.updates !== false,
      // The "Linked from" list under pages. On unless turned off.
      showBacklinks: parsed.showBacklinks !== false,
      // Covers are off until turned on.
      showCovers: parsed.showCovers === true,
      lastSeenVersion: typeof parsed.lastSeenVersion === "string" ? parsed.lastSeenVersion.slice(0, 20) : null,
      lastUpdateCheck: Number.isFinite(parsed.lastUpdateCheck) ? parsed.lastUpdateCheck : 0,
      dismissedUpdate: typeof parsed.dismissedUpdate === "string" ? parsed.dismissedUpdate.slice(0, 20) : "",
      // The assistant is off. There is no switch for it in this version.
      aiEnabled: false,
    };
  } catch (error) {
    logProblem("settings unreadable", error);
  }
}

// ---------- updates ----------

const APP_VERSION = typeof __APP_VERSION__ === "string" ? __APP_VERSION__ : "0.0.0";
const RELEASE_NOTES = typeof __RELEASE_NOTES__ === "string" ? __RELEASE_NOTES__ : "";
let offered = null; // the newer release the notice is about

function fill(text, values) {
  return text.replace(/\{(\w+)\}/g, (_, key) => String(values[key]));
}

function showNotes(title, notes) {
  const dialog = el("whatsnew");
  dialog.replaceChildren(textElement("h2", title));
  const body = document.createElement("div");
  body.className = "notes";
  renderNotes(body, notes);
  dialog.append(body, buttonElement(strings.update.close, () => dialog.close(), true));
  if (!dialog.open) dialog.showModal();
  return new Promise((resolve) => dialog.addEventListener("close", resolve, { once: true }));
}

function showUpdateNotice(release) {
  offered = release;
  el("updateText").textContent = fill(strings.update.available, { version: release.version });
  el("updateDownload").textContent = release.downloadUrl ? strings.update.download : strings.update.openPage;
  el("updateNotice").hidden = false;
}

async function runUpdateCheck() {
  const { release } = await checkForUpdate({ current: APP_VERSION, platform: platformOf(navigator.userAgent) });
  app.settings.lastUpdateCheck = Date.now();
  await saveSettings();
  return release;
}

async function checkQuietly() {
  if (!shouldCheck({ enabled: app.settings.updates, lastCheck: app.settings.lastUpdateCheck })) return;
  try {
    const release = await runUpdateCheck();
    if (release && release.version !== app.settings.dismissedUpdate) showUpdateNotice(release);
  } catch (error) {
    // Offline or GitHub unreachable is normal; it is logged and nothing is shown.
    logProblem("update check failed", error);
  }
}

// ---------- covers ----------

// Draws the cover area for the open page, or nothing at all when covers are off.
function drawCover() {
  if (!app.cover) return;
  if (!app.settings.showCovers || !app.current) return app.cover.hide();
  app.cover.show(readCover(app.current.parts.front));
}

// Writes a new properties block into the open page and saves it like any other change.
function applyCoverFront(front) {
  if (front === null) {
    showToast(strings.cover.cannotChange);
    return false;
  }
  app.current.parts.front = front;
  app.autosave.touch();
  drawCover();
  return true;
}

async function chooseCover() {
  const open = app.current;
  if (!open) return;
  try {
    const file = await choosePicture();
    if (!file) return;
    const path = await storePicture(file);
    if (app.current !== open) return; // another page was opened while the picture was being chosen
    applyCoverFront(withCover(open.parts.front, path));
  } catch (error) {
    logProblem("cover failed", error);
    const code = error && error.code === "too_large" ? "too_large_picture" : error && error.code;
    showBanner(strings.errors[code] || strings.cover.failed);
  }
}

function removeCover() {
  if (app.current) applyCoverFront(withoutCover(app.current.parts.front));
}

function setShowCovers(on) {
  app.settings.showCovers = on;
  saveSettings();
  drawCover();
}

function coverSettingsRows() {
  const s = strings.settings;
  const box = document.createElement("input");
  box.type = "checkbox";
  box.checked = app.settings.showCovers;
  const row = document.createElement("label");
  row.className = "setting-row";
  row.append(textElement("span", s.showCovers, "setting-label"), box);
  box.addEventListener("change", () => setShowCovers(box.checked));
  return [row, textElement("p", s.showCoversHint, "setting-hint")];
}

function setShowBacklinks(on) {
  app.settings.showBacklinks = on;
  saveSettings();
  if (app.current) loadBacklinks(app.current.path);
}

function backlinkSettingsRows() {
  const s = strings.settings;
  const box = document.createElement("input");
  box.type = "checkbox";
  box.checked = app.settings.showBacklinks;
  const row = document.createElement("label");
  row.className = "setting-row";
  row.append(textElement("span", s.showBacklinks, "setting-label"), box);
  box.addEventListener("change", () => setShowBacklinks(box.checked));
  return [row, textElement("p", s.showBacklinksHint, "setting-hint")];
}

function updateSettingsRows() {
  const s = strings.settings;
  const box = document.createElement("input");
  box.type = "checkbox";
  box.checked = app.settings.updates;
  const row = document.createElement("label");
  row.className = "setting-row";
  row.append(textElement("span", s.updates, "setting-label"), box);
  const result = textElement("p", "", "setting-hint");
  // The banner is behind this box, so a newer version gets its buttons here as well.
  const actions = document.createElement("div");
  actions.className = "setting-actions";
  const showRelease = (release) => {
    actions.replaceChildren();
    if (!release) return;
    actions.append(buttonElement(release.downloadUrl ? s.downloadNow : s.openPage, openDownload, true));
    if (release.downloadUrl) {
      actions.append(buttonElement(s.openPage, () => openUrlOrWarn(release.url)), textElement("p", s.downloadHint, "setting-hint"));
    }
  };
  const check = buttonElement(s.checkNow, async () => {
    result.textContent = s.checking;
    showRelease(null);
    try {
      const release = await runUpdateCheck();
      result.textContent = release ? fill(s.newVersion, { version: release.version }) : s.upToDate;
      if (release) showUpdateNotice(release);
      showRelease(release);
    } catch (error) {
      logProblem("update check failed", error);
      result.textContent = s.checkFailed;
    }
  });
  box.addEventListener("change", () => {
    app.settings.updates = box.checked;
    saveSettings();
  });
  return [row, textElement("p", s.updatesHint, "setting-hint"), check, result, actions];
}

// The converted copy for Obsidian (see DECISIONS.md). Not offered on Android: the notes live in
// the app's private storage there, so another app could not open a copy made beside them.
function obsidianRows() {
  if (isAndroid) return [];
  const s = strings.settings;
  const result = textElement("p", "", "setting-hint");
  const make = buttonElement(s.obsidianButton, async () => {
    make.disabled = true;
    result.textContent = s.obsidianWorking;
    try {
      const report = await backend.exportObsidianCopy();
      result.textContent = fill(s.obsidianDone, report) + (report.skipped ? fill(s.obsidianSkipped, report) : "");
    } catch (error) {
      logProblem("obsidian copy failed", error);
      result.textContent = errorText(error);
    } finally {
      make.disabled = false;
    }
  });
  return [textElement("h3", s.obsidianHeading, "setting-heading"), textElement("p", s.obsidianHint, "setting-hint"), make, result];
}

// Opens an address in the system browser. Resolves to false (and logs) when that is not possible.
async function tryOpen(url) {
  try {
    await openUrl(url);
    return true;
  } catch (error) {
    logProblem("could not open " + url, error);
    return false;
  }
}

async function openUrlOrWarn(url) {
  if (!(await tryOpen(url))) showBanner(strings.update.openFailed);
}

// The browser does the downloading. First choice is the file for this system; if there is none, or
// it cannot be opened, the release page (which lists every file) is the fallback.
async function openDownload() {
  if (!offered) return;
  if (offered.downloadUrl && (await tryOpen(offered.downloadUrl))) return;
  await openUrlOrWarn(offered.url);
}

// After an update the new version's notes are shown once. A fresh install sees nothing.
async function showWhatsNewOnce(freshInstall) {
  if (app.settings.lastSeenVersion === APP_VERSION) return;
  const show = !freshInstall && RELEASE_NOTES !== "";
  app.settings.lastSeenVersion = APP_VERSION;
  await saveSettings();
  if (show) await showNotes(fill(strings.update.whatsNewTitleUpdated, { version: APP_VERSION }), RELEASE_NOTES);
}

function appearanceOf(settings) {
  const { theme, fontSize, editorWidth, sidebarWidth } = settings;
  return { theme, fontSize, editorWidth, sidebarWidth };
}

async function saveSettings() {
  try {
    await backend.setSettings(JSON.stringify(app.settings));
  } catch (error) {
    logProblem("settings not saved", error);
  }
}

// ---------- dialogs ----------

function askDialog(dialog, build) {
  dialog.replaceChildren();
  return new Promise((resolve) => {
    build(dialog, (value) => {
      dialog.close();
      resolve(value);
    });
    // Escape must not skip the disclosure or leave the app without a folder.
    dialog.addEventListener("cancel", (event) => event.preventDefault(), { once: true });
    dialog.showModal();
  });
}

function textElement(tag, text, className) {
  const node = document.createElement(tag);
  node.textContent = text;
  if (className) node.className = className;
  return node;
}

function buttonElement(text, onClick, primary) {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = text;
  if (primary) button.className = "primary";
  button.addEventListener("click", onClick);
  return button;
}

function showDisclosure() {
  return askDialog(el("disclosure"), (dialog, done) => {
    const d = strings.disclosure;
    const list = document.createElement("ul");
    for (const point of d.points) list.append(textElement("li", point));
    dialog.append(
      textElement("h2", d.title),
      list,
      buttonElement(d.accept, () => done(true), true),
    );
  });
}

// Resolves to "default", or a folder path chosen by the user.
function showWelcome() {
  return askDialog(el("welcome"), (dialog, done) => {
    const w = strings.welcome;
    const actions = document.createElement("div");
    actions.className = "dialog-actions";
    if (!isAndroid) {
      actions.append(
        buttonElement(w.chooseFolder, async () => {
          try {
            const chosen = await backend.pickFolder();
            if (chosen) done(chosen);
          } catch (error) {
            logProblem("folder picker failed", error);
          }
        }, true),
      );
    }
    actions.append(buttonElement(w.useDefault, () => done("default"), isAndroid));
    dialog.append(
      textElement("img", "", "logo-large"),
      textElement("h2", w.title),
      textElement("p", w.body),
      actions,
    );
    // The real location of the default folder, so the choice is not blind. If it cannot be
    // read the line is left out; the buttons still work.
    const where = textElement("p", "", "hint default-path");
    where.hidden = true;
    dialog.append(where, textElement("p", w.defaultHint, "hint"));
    if (isAndroid) dialog.append(textElement("p", w.defaultPrivate, "hint"));
    backend.defaultVaultPath().then(
      (path) => {
        if (typeof path !== "string" || !path) return;
        where.textContent = fill(w.defaultPath, { path });
        where.hidden = false;
      },
      (error) => logProblem("default folder path unavailable", error),
    );
    const logo = dialog.querySelector("img");
    logo.src = "logo.png";
    logo.alt = "";
    logo.width = 48;
    logo.height = 48;
  });
}

// ---------- vault and note list ----------

async function openVaultFrom(choice) {
  const opened = choice === "default" ? await backend.openDefaultVault() : await backend.openVault(choice);
  app.settings.vaultPath = opened.path;
  app.settings.recentVaults = addRecent(app.settings.recentVaults, opened.path);
  await saveSettings();
  el("vaultName").textContent = opened.name || strings.appName;
  app.expanded = new Set();
  app.selectedFolder = "";
  await showNoNote();
  await refreshTree();
}

// Switching to another folder from the folder menu. `choice` is "default" or a path. The page
// that is open is saved first. If the folder cannot be opened, the old folder stays in place
// (the Rust side only swaps on success) and a recent entry that no longer works is dropped.
async function switchFolder(choice) {
  await closeCurrentNote();
  hideBanner();
  try {
    await openVaultFrom(choice);
  } catch (error) {
    logProblem("switch folder failed", error);
    if (choice !== "default") {
      app.settings.recentVaults = removeRecent(app.settings.recentVaults, choice);
      await saveSettings();
    }
    showBanner(error && error.code === "not_found" ? strings.folders.missing : errorText(error));
    await showNoNote();
  }
}

async function openAnotherFolder() {
  let chosen = null;
  try {
    chosen = await backend.pickFolder();
  } catch (error) {
    logProblem("folder picker failed", error);
    return;
  }
  if (chosen) await switchFolder(chosen);
}

function showFolderMenu() {
  openFolderMenu(el("vaultButton"), {
    recent: app.settings.recentVaults,
    current: app.settings.vaultPath,
    canPick: !isAndroid,
    onPick: switchFolder,
    onOther: openAnotherFolder,
    onDefault: () => switchFolder("default"),
  });
}

async function chooseVault() {
  while (true) {
    const choice = await showWelcome();
    try {
      await openVaultFrom(choice);
      return;
    } catch (error) {
      logProblem("open folder failed", error);
      showBanner(errorText(error));
    }
  }
}

async function refreshTree() {
  try {
    const tree = await backend.tree();
    app.entries = tree.entries;
    if (tree.truncated) showBanner(strings.sidebar.truncated);
  } catch (error) {
    logProblem("list failed", error);
    showBanner(errorText(error));
    app.entries = [];
  }
  drawTree();
  syncLinks();
}

// ---------- links between pages ----------

const notePaths = () => app.entries.filter((entry) => entry.kind === "note").map((entry) => entry.path);

// Tells the editor which pages exist, so it can mark links to pages that do not.
function syncLinks() {
  if (app.editor) updateWikilinks(app.editor, { pages: notePaths(), from: app.current ? app.current.path : "" });
}

// A link to a page that does not exist creates it, at the top of the vault (or in the folder the
// link names, when that folder exists), the way Obsidian does.
async function createLinkedPage(page) {
  const clean = page.trim().replace(/^\/+/, "").replace(/\.md$/i, "");
  const slash = clean.lastIndexOf("/");
  const folder = slash === -1 ? "" : clean.slice(0, slash).toLowerCase();
  const parent = folder ? (app.entries.find((entry) => entry.kind === "folder" && entry.path.toLowerCase() === folder) || { path: "" }).path : "";
  try {
    const path = await backend.createNote(parent, clean.slice(slash + 1));
    await refreshTree();
    return path;
  } catch (error) {
    logProblem("create linked page failed", error);
    showToast(strings.wikilinks.createFailed);
    return null;
  }
}

// Does this piece of the page hold the heading or the block id a link points at? Blocks the
// editor keeps as raw text are checked by their text.
function holdsAnchor(node, blockId, heading) {
  if (node.type.name === "rawBlock") {
    const lines = node.attrs.src.split("\n");
    if (blockId) return lines.some((line) => line.trimEnd().endsWith(` ^${blockId}`));
    return lines.some((line) => /^#{1,6}[ \t]+/.test(line) && line.replace(/^#{1,6}[ \t]+/, "").trim().toLowerCase() === heading);
  }
  if (blockId) return Boolean(node.attrs && node.attrs.blockId === blockId);
  return node.type.name === "heading" && node.textContent.trim().toLowerCase() === heading;
}

// Scrolls to a heading or to a block ("^id") of the open page.
function goToAnchor(anchor) {
  const view = app.editor.view;
  const blockId = anchor.startsWith("^") ? anchor.slice(1) : null;
  const heading = blockId ? null : anchor.split("#").pop().trim().toLowerCase();
  let found = null;
  view.state.doc.descendants((node, pos) => {
    if (found !== null) return false;
    if (holdsAnchor(node, blockId, heading)) found = pos;
    return found === null && !node.isTextblock;
  });
  const dom = found === null ? null : view.nodeDOM(found);
  if (!(dom instanceof Element)) {
    showToast((blockId ? strings.wikilinks.missingBlock : strings.wikilinks.missingHeading).replace("{anchor}", anchor));
    return;
  }
  dom.scrollIntoView({ block: "start" });
}

// Follows a link written in the page: open the page it means (making it if it is missing),
// then go to the heading or block it names.
async function followLink({ page, anchor }) {
  // A double click must not make the page twice.
  if (app.following) return;
  app.following = true;
  try {
    await followLinkNow(page, anchor);
  } finally {
    app.following = false;
  }
}

async function followLinkNow(page, anchor) {
  const from = app.current ? app.current.path : "";
  let target = createResolver(notePaths()).resolve(page, from);
  if (!target) target = await createLinkedPage(page);
  if (!target) return;
  if (target !== from) await openNote(target);
  if (anchor && app.current && app.current.path === target) goToAnchor(anchor);
}

// Looks for the pages that link here. It waits a moment first, so clicking quickly through
// several pages does not start a search for each of them.
function loadBacklinks(path) {
  clearTimeout(app.backlinkTimer);
  const run = ++app.backlinkRun;
  app.backlinks.clear();
  // Turned off: the pages are not searched at all.
  if (!app.settings.showBacklinks) return;
  app.backlinkTimer = setTimeout(async () => {
    try {
      const result = await backend.backlinks(path);
      if (run === app.backlinkRun && app.current && app.current.path === path) app.backlinks.show(result);
    } catch (error) {
      logProblem("backlinks failed", error);
      if (run === app.backlinkRun) app.backlinks.fail();
    }
  }, BACKLINK_DELAY_MS);
}

function drawTree() {
  renderTree(
    el("tree"),
    app.entries,
    {
      expanded: app.expanded,
      currentPath: app.current ? app.current.path : null,
      selectedFolder: app.selectedFolder,
    },
    {
      openNote: (path) => openNote(path),
      toggleFolder(path) {
        app.selectedFolder = path;
        if (app.expanded.has(path)) app.expanded.delete(path);
        else app.expanded.add(path);
        drawTree();
      },
      renameEntry: (node, button) => renameEntryInline(node, button),
      trashEntry: (node, button) => trashEntry(node, button),
      entryMenu: (node, x, y, button) => openEntryMenu(node, x, y, button),
    },
  );
}

// The menu for one entry: Rename, Move to when there is somewhere to move it, and Delete.
function openEntryMenu(node, x, y, button) {
  const c = strings.contextMenu;
  const items = [{ label: c.rename, run: () => renameEntryInline(node, button) }];
  const targets = moveTargets(node.path);
  if (targets.length) {
    const choose = () =>
      openContextMenu(x, y, targets.map((t) => ({ label: t.label, indent: t.depth, run: () => moveEntry(node.path, t.folder) })), {
        returnFocus: button,
        label: c.moveLabel,
      });
    items.push({ label: c.move, run: choose });
  }
  // No question is asked: Delete only moves the entry to the trash, where it can be restored.
  items.push({ label: c.delete, run: () => trashEntry(node, button) });
  openContextMenu(x, y, items, { returnFocus: button });
}

// Every folder `path` could be moved into, the top of the vault first, in list order.
function moveTargets(path) {
  const list = [];
  if (canMoveInto(path, "")) list.push({ folder: "", label: strings.contextMenu.moveTop, depth: 0 });
  for (const entry of app.entries) {
    if (entry.kind === "folder" && canMoveInto(path, entry.path)) list.push({ folder: entry.path, label: entry.name, depth: entry.path.split("/").length });
  }
  return list;
}

// Moves a page or folder into another folder (from a drag or from the menu).
async function moveEntry(path, folder) {
  try {
    // An open page is saved first, so nothing typed so far is written to the old place.
    if (app.autosave) await app.autosave.flush();
    const newPath = await backend.move(path, folder);
    remapPaths(path, newPath);
    if (folder) app.expanded.add(folder); // so the result can be seen
  } catch (error) {
    logProblem("move failed", error);
    showBanner(errorText(error));
  }
  await refreshTree();
}

// Renames a folder or a page in the list, in place. Enter keeps the new name, Escape or
// leaving the field is handled below. The vault refuses names that already exist.
function renameEntryInline(node, button) {
  const path = node.path;
  const isFolder = node.kind === "folder";
  const label = button.querySelector(".tree-label");
  if (!label) return;
  const input = document.createElement("input");
  input.type = "text";
  input.className = "inline-rename";
  input.value = label.textContent;
  input.maxLength = 100;
  input.setAttribute("aria-label", isFolder ? strings.contextMenu.renameFolderLabel : strings.contextMenu.renamePageLabel);
  // A text field inside a button does not work properly (a click in it counts as a click on the
  // button and takes the focus away), so the button is swapped for a plain box with the same
  // icons and the field.
  const holder = document.createElement("div");
  holder.className = "tree-button tree-renaming";
  for (const child of [...button.children]) if (child !== label) holder.append(child.cloneNode(true));
  holder.append(input);
  button.replaceWith(holder);
  input.focus();
  input.select();
  let finished = false;
  const finish = async (commit) => {
    if (finished) return;
    finished = true;
    const wanted = input.value.trim();
    if (commit && wanted && wanted !== label.textContent) {
      try {
        // An open page is saved first, so nothing typed so far is written to the old name.
        if (app.autosave) await app.autosave.flush();
        const newPath = await backend.rename(path, wanted);
        remapPaths(path, newPath);
        if (app.current) el("title").value = noteTitle(app.current.path);
      } catch (error) {
        logProblem("rename failed", error);
        showBanner(errorText(error));
      }
    }
    await refreshTree();
  };
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") finish(true);
    if (event.key === "Escape") finish(false);
  });
  input.addEventListener("blur", () => finish(true));
}

// After a folder is renamed, paths that started with the old name must follow it.
function remapPaths(oldPath, newPath) {
  const fix = (p) => (p === oldPath || p.startsWith(oldPath + "/") ? newPath + p.slice(oldPath.length) : p);
  app.recent = app.recent.map(fix);
  app.expanded = new Set([...app.expanded].map(fix));
  app.selectedFolder = fix(app.selectedFolder);
  if (app.current) app.current.path = fix(app.current.path);
}

// ---------- trash ----------

const isInside = (path, folder) => path === folder || path.startsWith(folder + "/");

// Moves a page or folder to the trash. The open page is saved first, so what was typed last is
// in the trash copy too, and is closed afterwards if it was the one deleted (or inside it).
async function trashEntry(node, button) {
  try {
    if (app.autosave) await app.autosave.flush();
    await backend.trash(node.path);
    const closing = app.current && isInside(app.current.path, node.path);
    // The page is gone from its place, so a save must not be tried for it again.
    if (closing) {
      app.autosave.cancel();
      app.current = null;
    }
    app.recent = app.recent.filter((p) => !isInside(p, node.path));
    app.expanded = new Set([...app.expanded].filter((p) => !isInside(p, node.path)));
    if (isInside(app.selectedFolder, node.path)) app.selectedFolder = parentOf(node.path);
    showToast(fill(strings.trash.movedToTrash, { name: node.name.replace(/\.md$/i, "") }));
    if (closing) await showNoNote();
  } catch (error) {
    logProblem("trash failed", error);
    showBanner(errorText(error));
  }
  await refreshTree();
  // The entry that had the focus is gone; the list is the next best place for it.
  if (button && !button.isConnected) el("tree").querySelector(".tree-button")?.focus();
}

function openTrashDialog() {
  return openTrash(el("trash"), {
    api: {
      list: () => backend.trashList(),
      restore: (id) => backend.trashRestore(id),
      deleteForever: (id) => backend.trashDeleteForever(id),
      empty: () => backend.trashEmpty(),
    },
    onRestored(path, name) {
      for (let dir = parentOf(path); dir; dir = parentOf(dir)) app.expanded.add(dir);
      showToast(fill(strings.trash.restored, { name }));
    },
    onChanged: () => refreshTree(),
    onError(error) {
      logProblem("trash action failed", error);
      return error instanceof BackendError && error.code === "not_found" ? strings.trash.gone : errorText(error);
    },
  });
}

// ---------- search and commands ----------

function openSearch() {
  const c = strings.search.commands;
  const commands = [
    { label: c.newNote, run: createNote },
    { label: c.newFolder, run: createFolder },
    { label: c.settings, run: () => el("openSettings").click() },
    { label: c.trash, run: openTrashDialog },
    { label: c.sidebar, run: toggleSidebar },
  ];
  if (app.current) commands.push({ label: c.source, run: toggleSource });
  openPalette(el("palette"), {
    recent: () => app.recent.filter((p) => p !== (app.current && app.current.path)),
    commands,
    search: (query) => backend.search(query, SEARCH_LIMIT),
    openPage: (path) => openNote(path),
  });
}

// Ctrl+K opens the search box from anywhere. In the editor with text selected it keeps its
// older job, adding a link, so that shortcut does not change.
function searchShortcut(event) {
  const wanted = (event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "k";
  if (!wanted || event.isComposing) return;
  if (app.editor && app.editor.isFocused && !app.editor.state.selection.empty) return;
  if (document.querySelector("dialog[open]:not(#palette)")) return;
  event.preventDefault();
  const palette = el("palette");
  if (palette.open) palette.querySelector("input")?.select();
  else openSearch();
}

// ---------- the open note ----------

async function showNoNote() {
  await closeCurrentNote();
  el("empty").hidden = false;
  el("editor").hidden = true;
  el("source").hidden = true;
  el("sourceToggle").hidden = true;
  el("title").hidden = true;
  setStatus("");
}

async function closeCurrentNote() {
  if (app.autosave) await app.autosave.flush();
  if (app.autosave) app.autosave.cancel();
  app.current = null;
  app.lastSavedText = null;
}

async function openNote(path) {
  if (app.current && app.current.path === path) return;
  await closeCurrentNote();
  hideBanner();
  try {
    const note = await backend.readNote(path);
    showNote(path, note);
  } catch (error) {
    logProblem("open note failed", error);
    showBanner(errorText(error));
    await showNoNote();
  }
  closeSidebarOnPhone();
}

// Puts a loaded page into the editor. This must not count as an edit the user can undo: if it
// did, pressing Undo straight after opening a page would go back to the empty editor, and
// autosave would then write that empty page over the real one.
function putInEditor(doc) {
  app.editor.chain().setMeta("addToHistory", false).setContent(doc, { emitUpdate: false }).run();
}

function showNote(path, note) {
  const { parts, doc } = loadNote(note.text, {
    parse: (md) => app.editor.markdown.parse(md),
    serialize: (json) => app.editor.markdown.serialize(json),
  });
  app.current = { path, version: note.version, parts };
  app.recent = [path, ...app.recent.filter((p) => p !== path)].slice(0, 20);
  app.lastSavedText = note.text;
  syncLinks();
  putInEditor(doc);
  el("empty").hidden = true;
  el("title").hidden = false;
  el("sourceToggle").hidden = false;
  fillSource(note.text);
  applyMode();
  el("title").value = noteTitle(path);
  setStatus("");
  app.selectedFolder = parentOf(path);
  for (let dir = parentOf(path); dir; dir = parentOf(dir)) app.expanded.add(dir);
  drawTree();
  drawCover();
  loadBacklinks(path);
}

// ---------- markdown source view ----------

// A text box turns every line ending into "\n" inside. A note with Windows line endings
// (all "\r\n") is shown with "\n" and gets "\r\n" back when saved, so nothing changes. A note
// that mixes both cannot be given back exactly, so it is shown read-only.
function fillSource(text) {
  const box = el("source");
  const crlfCount = (text.match(/\r\n/g) || []).length;
  const lfCount = (text.match(/\n/g) || []).length;
  const loneCr = /\r(?!\n)/.test(text);
  const consistent = !loneCr && (crlfCount === 0 || crlfCount === lfCount);
  app.lineEnding = crlfCount > 0 && consistent ? "\r\n" : "\n";
  box.readOnly = !consistent;
  box.value = text;
  box.setAttribute("aria-label", strings.source.textLabel);
}

function sourceText() {
  const value = el("source").value;
  return app.lineEnding === "\r\n" ? value.replace(/\n/g, "\r\n") : value;
}

// The text the open note has right now, without adding anything (no id is created here).
function plainCurrentText() {
  return composeNote(app.current.parts, app.editor.getJSON(), {
    serialize: (json) => app.editor.markdown.serialize(json),
    assignId: false,
  });
}

function applyMode() {
  const source = app.mode === "source" && app.current;
  el("editor").hidden = !app.current || source;
  el("source").hidden = !source;
  const toggle = el("sourceToggle");
  toggle.textContent = source ? strings.source.hide : strings.source.show;
  toggle.setAttribute("aria-label", source ? strings.source.hideLabel : strings.source.showLabel);
  toggle.setAttribute("aria-pressed", String(Boolean(source)));
  if (source && el("source").readOnly) showBanner(strings.source.mixedLineEndings);
}

async function toggleSource() {
  if (!app.current) return;
  if (app.mode === "editor") {
    // The note on screen is the truth: show exactly what saving it would write.
    fillSource(plainCurrentText());
    app.mode = "source";
    applyMode();
    el("source").focus();
    return;
  }
  // Back to blocks. Whatever is in the box is saved first, then read again as blocks.
  await app.autosave.flush();
  const text = sourceText();
  const { parts, doc } = loadNote(text, {
    parse: (md) => app.editor.markdown.parse(md),
    serialize: (json) => app.editor.markdown.serialize(json),
  });
  app.current.parts = parts;
  putInEditor(doc);
  app.mode = "editor";
  applyMode();
  drawCover();
}

function currentText() {
  const { current } = app;
  // The id is created once per open note, so every later save writes the same one.
  current.parts.front = withNoteId(current.parts.front, newNoteId());
  return composeNote(current.parts, app.editor.getJSON(), {
    serialize: (json) => app.editor.markdown.serialize(json),
    assignId: false,
  });
}

async function saveCurrent() {
  const { current } = app;
  if (!current) return;
  const path = current.path;
  // In source view the box is saved exactly as it is: no id is added, nothing is tidied.
  const text = app.mode === "source" ? sourceText() : currentText();
  if (text === app.lastSavedText) return;
  try {
    current.version = await backend.writeNote(path, text, current.version);
    app.lastSavedText = text;
  } catch (error) {
    if (error instanceof BackendError && error.code === "conflict") {
      await resolveConflict(path, text);
      return;
    }
    logProblem("save failed", error);
    throw error;
  }
}

// Another program changed the file while it was open here. The file on disk wins, and
// what the user typed is kept as a separate note so nothing they wrote is lost.
async function resolveConflict(path, ownText) {
  let copied = true;
  try {
    const copyPath = await backend.createNote(parentOf(path), `${noteTitle(path)} (${strings.conflictCopySuffix})`);
    const empty = await backend.readNote(copyPath);
    await backend.writeNote(copyPath, ownText, empty.version);
  } catch (error) {
    copied = false;
    logProblem("conflict copy failed", error);
  }
  app.autosave.cancel();
  try {
    const fresh = await backend.readNote(path);
    showNote(path, fresh);
  } catch (error) {
    logProblem("reload after conflict failed", error);
    await showNoNote();
  }
  showBanner(copied ? strings.messages.conflict : strings.messages.conflictCopyFailed);
  await refreshTree();
}

// ---------- creating and renaming ----------

// Where "New page" and "New folder" put the new entry: in the selected folder, but only while
// that folder can be seen (it and every folder around it are open). With everything folded
// shut the new entry goes at the top, where it can be found and then dragged where it belongs,
// instead of landing in a folder that was only left selected earlier.
function creationFolder() {
  for (let dir = app.selectedFolder; dir; dir = parentOf(dir)) {
    if (!app.expanded.has(dir)) return "";
  }
  return app.selectedFolder;
}

async function createNote() {
  try {
    const path = await backend.createNote(creationFolder(), strings.newNoteTitle);
    for (let dir = parentOf(path); dir; dir = parentOf(dir)) app.expanded.add(dir);
    await refreshTree();
    await openNote(path);
    el("title").focus();
    el("title").select();
  } catch (error) {
    logProblem("create note failed", error);
    showBanner(errorText(error));
  }
}

async function createFolder() {
  try {
    const parent = creationFolder();
    const path = await backend.createFolder(parent, strings.newFolderName);
    app.selectedFolder = path;
    await refreshTree();
  } catch (error) {
    logProblem("create folder failed", error);
    showBanner(errorText(error));
  }
}

async function renameCurrent() {
  const { current } = app;
  const input = el("title");
  if (!current) return;
  const wanted = input.value.trim();
  if (!wanted || wanted === noteTitle(current.path)) {
    input.value = noteTitle(current.path);
    return;
  }
  try {
    await app.autosave.flush();
    current.path = await backend.rename(current.path, wanted);
    input.value = noteTitle(current.path);
    await refreshTree();
  } catch (error) {
    logProblem("rename failed", error);
    showBanner(errorText(error));
    input.value = noteTitle(current.path);
  }
}

// ---------- layout ----------

function toggleSidebar() {
  document.body.classList.toggle("sidebar-open");
}

function closeSidebarOnPhone() {
  if (window.matchMedia("(max-width: 700px)").matches) document.body.classList.remove("sidebar-open");
}

function fillStaticText() {
  // Each sidebar button is an icon plus a label. The label can be hidden when the list is
  // narrow, so the text is also the tooltip and the accessible name.
  const withIcon = (id, name, text) => {
    const button = el(id);
    const label = document.createElement("span");
    label.className = "btn-label";
    label.textContent = text;
    button.replaceChildren(icon(name), label);
    button.title = text;
    button.setAttribute("aria-label", text);
  };
  withIcon("newNote", "plus", strings.sidebar.newNote);
  withIcon("newFolder", "folder", strings.sidebar.newFolder);
  withIcon("openSettings", "settings", strings.settings.open);
  withIcon("openTrash", "trash", strings.sidebar.trash);
  // The search button shows its shortcut where there is a keyboard to use it.
  const search = el("openSearch");
  const searchLabel = document.createElement("span");
  searchLabel.className = "btn-label";
  searchLabel.textContent = strings.sidebar.search;
  search.replaceChildren(icon("search"), searchLabel);
  if (!isAndroid) search.append(Object.assign(document.createElement("kbd"), { className: "shortcut", textContent: strings.search.shortcut }));
  search.setAttribute("aria-label", strings.sidebar.search);
  el("penTest").textContent = strings.sidebar.penTest;
  // The folder name opens the folder menu. On Android the folder is fixed, so it is plain text.
  if (!isAndroid) el("vaultButton").append(icon("chevronDown"));
  el("vaultButton").title = strings.folders.switchLabel;
  el("vaultButton").disabled = isAndroid;
  el("updateDownload").textContent = strings.update.download;
  el("updateDetails").textContent = strings.update.details;
  el("updateLater").textContent = strings.update.later;
  el("updateDownload").addEventListener("click", openDownload);
  el("updateDetails").addEventListener("click", () => offered && showNotes(fill(strings.update.whatsNewTitle, { version: offered.version }), offered.notes));
  el("updateLater").addEventListener("click", () => {
    if (offered) app.settings.dismissedUpdate = offered.version;
    el("updateNotice").hidden = true;
    saveSettings();
  });
  el("openSettings").addEventListener("click", () => {
    openSettings(
      el("settings"),
      appearanceOf(app.settings),
      (next) => {
        Object.assign(app.settings, next);
        applyAppearance(document.documentElement, app.settings);
        saveSettings();
      },
      [...coverSettingsRows(), ...backlinkSettingsRows(), ...updateSettingsRows(), ...obsidianRows()],
    );
  });
  el("empty").textContent = strings.editor.noNoteOpen;
  el("title").setAttribute("aria-label", strings.editor.titleLabel);
  el("toggle").replaceChildren(icon("menu"));
  el("toggle").setAttribute("aria-label", strings.sidebar.toggle);
  el("bannerClose").textContent = strings.messages.dismiss;
}

function startFlushTriggers() {
  const flush = () => app.autosave && app.autosave.flush();
  window.addEventListener("blur", flush);
  window.addEventListener("pagehide", flush);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flush();
  });
  // Closing the desktop window: wait for the save before the window goes away.
  import("@tauri-apps/api/window")
    .then(({ getCurrentWindow }) => getCurrentWindow().onCloseRequested(async () => { await flush(); }))
    .catch((error) => logProblem("close hook missing", error));
}

// A file dropped anywhere in the window must never be opened by the browser (which would
// replace the app with the file). Dropping on the note is handled by the editor.
function guardFileDrops() {
  const hasFiles = (event) => event.dataTransfer && Array.from(event.dataTransfer.types || []).includes("Files");
  for (const type of ["dragover", "drop"]) {
    window.addEventListener(type, (event) => {
      if (hasFiles(event)) event.preventDefault();
    });
  }
}

// When the on-screen keyboard opens, the window gets shorter and the page shrinks with it (the
// top bar stays where it is). The text cursor is then scrolled back into view if the keyboard
// would have covered it; a cursor that is already visible is not moved.
function keepCaretVisible() {
  let waiting = false;
  window.addEventListener("resize", () => {
    if (waiting || !app.editor || !app.editor.isFocused) return;
    waiting = true;
    requestAnimationFrame(() => {
      waiting = false;
      if (!app.editor.isFocused) return;
      const box = el("editor").getBoundingClientRect();
      const caret = app.editor.view.coordsAtPos(app.editor.state.selection.head);
      if (caret.top < box.top || caret.bottom > box.bottom) app.editor.view.dispatch(app.editor.state.tr.scrollIntoView());
    });
  });
}

function wireEvents() {
  guardFileDrops();
  enableTreeDrag(el("tree"), moveEntry);
  el("openSearch").addEventListener("click", openSearch);
  el("openTrash").addEventListener("click", openTrashDialog);
  document.addEventListener("keydown", searchShortcut, true);
  el("newNote").addEventListener("click", createNote);
  el("newFolder").addEventListener("click", createFolder);
  el("vaultButton").addEventListener("click", showFolderMenu);
  // Settings and What's new can be closed by clicking outside the box (or Escape, or Close).
  // The first-run screens cannot: they need an answer.
  for (const id of ["settings", "whatsnew", "trash", "palette"]) {
    const dialog = el(id);
    dialog.addEventListener("click", (event) => {
      // Pressing Enter on a button also sends a click, with its position at 0,0, which would
      // look like a click outside the box. Only a click on the box itself (its backdrop) counts.
      if (event.target !== dialog) return;
      const box = dialog.getBoundingClientRect();
      const inside = event.clientX >= box.left && event.clientX <= box.right && event.clientY >= box.top && event.clientY <= box.bottom;
      if (!inside) dialog.close();
    });
  }
  el("toggle").addEventListener("click", toggleSidebar);
  el("sourceToggle").addEventListener("click", toggleSource);
  el("source").addEventListener("input", () => app.autosave.touch());
  el("scrim").addEventListener("click", toggleSidebar);
  el("bannerClose").addEventListener("click", hideBanner);
  el("title").addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      el("title").blur();
    }
  });
  el("title").addEventListener("blur", renameCurrent);
}

// ---------- start ----------

async function start() {
  fillStaticText();
  wireEvents();
  // With no note open there is nothing else to look at, so the list starts open.
  document.body.classList.add("sidebar-open");

  app.autosave = new Autosave({ delayMs: SAVE_DELAY_MS, save: saveCurrent, onStatus: setStatus });
  app.editor = createEditor(el("editor"), () => app.autosave.touch(), {
    loadImage: (path) => backend.readAttachment(pathForVault(path)),
    noteKey: () => (app.current ? app.current.path : null),
    noteTitle: () => (app.current ? noteTitle(app.current.path) : ""),
    notify: showToast,
    followLink,
    onProblem: (code) => showBanner(strings.errors[code === "too_large" ? "too_large_picture" : code] || strings.errors.unknown),
  });
  app.cover = createCover(el("editor"), {
    loadImage: (path) => backend.readAttachment(pathForVault(path)),
    onAdd: chooseCover,
    onChange: chooseCover,
    onRemove: removeCover,
  });
  app.backlinks = createBacklinks(el("editor"), { open: (path) => openNote(path), hide: () => setShowBacklinks(false) });
  keepCaretVisible();
  startFlushTriggers();

  await loadSettings();
  applyAppearance(document.documentElement, app.settings);
  const freshInstall = !app.settings.disclosureAccepted;
  if (freshInstall) {
    await showDisclosure();
    app.settings.disclosureAccepted = true;
    await saveSettings();
  }
  await showWhatsNewOnce(freshInstall);
  // Not awaited: looking for an update must never hold up opening the notes.
  checkQuietly();
  if (app.settings.vaultPath) {
    try {
      await openVaultFrom(app.settings.vaultPath);
      return;
    } catch (error) {
      logProblem("saved folder missing", error);
      showBanner(errorText(error));
    }
  }
  await chooseVault();
}

start().catch((error) => {
  logProblem("start failed", error);
  showBanner(errorText(error));
});
