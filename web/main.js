// Wires the screens together: settings, the folder, the note list, the editor and saving.

import { backend, BackendError } from "./backend.js";
import { composeNote, loadNote } from "./compose.js";
import { newNoteId, withNoteId } from "./blocks.js";
import { Autosave } from "./autosave.js";
import { createEditor } from "./editor.js";
import { icon } from "./icons.js";
import { renderTree } from "./sidebar.js";
import { pathForVault } from "./images.js";
import { strings } from "./strings.js";

const SAVE_DELAY_MS = 600;
const isAndroid = /Android/i.test(navigator.userAgent);

const el = (id) => document.getElementById(id);

const app = {
  settings: { vaultPath: null, disclosureAccepted: false, aiEnabled: false },
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
      disclosureAccepted: parsed.disclosureAccepted === true,
      // The assistant is off. There is no switch for it in this version.
      aiEnabled: false,
    };
  } catch (error) {
    logProblem("settings unreadable", error);
  }
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
      textElement("p", w.defaultHint, "hint"),
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
  await saveSettings();
  el("vaultName").textContent = opened.name || strings.appName;
  app.expanded = new Set();
  app.selectedFolder = "";
  await showNoNote();
  await refreshTree();
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
      renameFolder: (path, button) => renameFolderInline(path, button),
    },
  );
}

function renameFolderInline(path, button) {
  const label = button.querySelector(".tree-label");
  const input = document.createElement("input");
  input.type = "text";
  input.className = "inline-rename";
  input.value = label.textContent;
  input.maxLength = 100;
  label.replaceWith(input);
  input.focus();
  input.select();
  let finished = false;
  const finish = async (commit) => {
    if (finished) return;
    finished = true;
    if (commit && input.value.trim() && input.value !== label.textContent) {
      try {
        const newPath = await backend.rename(path, input.value);
        remapPaths(path, newPath);
      } catch (error) {
        logProblem("rename folder failed", error);
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
  el("newNote").replaceChildren(icon("plus"), document.createTextNode(strings.sidebar.newNote));
  el("newFolder").replaceChildren(icon("folder"), document.createTextNode(strings.sidebar.newFolder));
  el("openOther").textContent = strings.sidebar.openFolder;
  el("penTest").textContent = strings.sidebar.penTest;
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
  el("newNote").addEventListener("click", createNote);
  el("newFolder").addEventListener("click", createFolder);
  el("openOther").addEventListener("click", async () => {
    await closeCurrentNote();
    await chooseVault();
  });
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
    onProblem: (code) => showBanner(strings.errors[code === "too_large" ? "too_large_picture" : code] || strings.errors.unknown),
  });
  startFlushTriggers();

  await loadSettings();
  if (!app.settings.disclosureAccepted) {
    await showDisclosure();
    app.settings.disclosureAccepted = true;
    await saveSettings();
  }
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
