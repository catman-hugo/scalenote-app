// Wires the screens together: settings, the folder, the note list, the editor and saving.

import { openUrl } from "@tauri-apps/plugin-opener";
import { applyAppearance, DEFAULT_APPEARANCE, normalizeAppearance } from "./appearance.js";
import { openSettings } from "./settings.js";
import { checkForUpdate, shouldCheck } from "./updates.js";
import { renderNotes } from "./whatsnew.js";
import { openFolderMenu } from "./foldermenu.js";
import { addRecent, cleanRecent, removeRecent } from "./recent.js";
import { backend, BackendError } from "./backend.js";
import { composeNote, loadNote } from "./compose.js";
import { newNoteId, withNoteId } from "./blocks.js";
import { Autosave } from "./autosave.js";
import { createEditor } from "./editor.js";
import { icon } from "./icons.js";
import { renderTree } from "./sidebar.js";
import { openContextMenu } from "./contextmenu.js";
import { canMoveInto, enableTreeDrag } from "./treedrag.js";
import { pathForVault } from "./images.js";
import { strings } from "./strings.js";

const SAVE_DELAY_MS = 600;
const isAndroid = /Android/i.test(navigator.userAgent);

const el = (id) => document.getElementById(id);

const app = {
  settings: { vaultPath: null, recentVaults: [], disclosureAccepted: false, aiEnabled: false, ...DEFAULT_APPEARANCE, updates: true, lastSeenVersion: null, lastUpdateCheck: 0, dismissedUpdate: "" },
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
  el("updateNotice").hidden = false;
}

async function runUpdateCheck() {
  const { release } = await checkForUpdate({ current: APP_VERSION });
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

function updateSettingsRows() {
  const s = strings.settings;
  const box = document.createElement("input");
  box.type = "checkbox";
  box.checked = app.settings.updates;
  const row = document.createElement("label");
  row.className = "setting-row";
  row.append(textElement("span", s.updates, "setting-label"), box);
  const result = textElement("p", "", "setting-hint");
  const check = buttonElement(s.checkNow, async () => {
    result.textContent = s.checking;
    try {
      const release = await runUpdateCheck();
      result.textContent = release ? fill(s.newVersion, { version: release.version }) : s.upToDate;
      if (release) showUpdateNotice(release);
    } catch (error) {
      logProblem("update check failed", error);
      result.textContent = s.checkFailed;
    }
  });
  box.addEventListener("change", () => {
    app.settings.updates = box.checked;
    saveSettings();
  });
  return [row, textElement("p", s.updatesHint, "setting-hint"), check, result];
}

async function openDownload() {
  if (!offered) return;
  try {
    await openUrl(offered.url);
  } catch (error) {
    logProblem("could not open the download page", error);
    showBanner(strings.update.openFailed);
  }
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
      entryMenu: (node, x, y, button) => openEntryMenu(node, x, y, button),
    },
  );
}

// The menu for one entry: Rename, and Move to when there is somewhere to move it.
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
  app.expanded = new Set([...app.expanded].map(fix));
  app.selectedFolder = fix(app.selectedFolder);
  if (app.current) app.current.path = fix(app.current.path);
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

function showNote(path, note) {
  const { parts, doc } = loadNote(note.text, {
    parse: (md) => app.editor.markdown.parse(md),
    serialize: (json) => app.editor.markdown.serialize(json),
  });
  app.current = { path, version: note.version, parts };
  app.lastSavedText = note.text;
  app.editor.commands.setContent(doc, { emitUpdate: false });
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
  app.editor.commands.setContent(doc, { emitUpdate: false });
  app.mode = "editor";
  applyMode();
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

async function createNote() {
  try {
    const path = await backend.createNote(app.selectedFolder, strings.newNoteTitle);
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
    const path = await backend.createFolder(app.selectedFolder, strings.newFolderName);
    if (app.selectedFolder) app.expanded.add(app.selectedFolder);
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
  el("penTest").textContent = strings.sidebar.penTest;
  // The folder name opens the folder menu. On Android the folder is fixed, so it is plain text.
  el("vaultButton").append(icon("chevronDown"));
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
      updateSettingsRows(),
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

function wireEvents() {
  guardFileDrops();
  enableTreeDrag(el("tree"), moveEntry);
  el("newNote").addEventListener("click", createNote);
  el("newFolder").addEventListener("click", createFolder);
  el("vaultButton").addEventListener("click", showFolderMenu);
  // Settings and What's new can be closed by clicking outside the box (or Escape, or Close).
  // The first-run screens cannot: they need an answer.
  for (const id of ["settings", "whatsnew"]) {
    const dialog = el(id);
    dialog.addEventListener("click", (event) => {
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
    onProblem: (code) => showBanner(strings.errors[code === "too_large" ? "too_large_picture" : code] || strings.errors.unknown),
  });
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
