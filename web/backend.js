// The only file that talks to the Rust side. Everything else calls these functions.
//
// Rust returns short error codes as text; `BackendError` carries the code so screens can
// show the matching sentence from the language file.

import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";

export class BackendError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

async function call(command, args) {
  try {
    return await invoke(command, args);
  } catch (error) {
    throw new BackendError(typeof error === "string" ? error : "unknown");
  }
}

export const backend = {
  openVault: (path) => call("open_vault", { path }),
  openDefaultVault: () => call("open_default_vault"),
  // The folder "Use the default folder" would open, as text for the first-run screen.
  defaultVaultPath: () => call("default_vault_path"),
  tree: () => call("vault_tree"),
  readNote: (path) => call("read_note", { path }),
  writeNote: (path, text, expected) => call("write_note", { path, text, expected }),
  readCanvas: (path) => call("read_canvas", { path }),
  writeCanvas: (path, text, expected) => call("write_canvas", { path, text, expected }),
  readFolderIcons: () => call("read_folder_icons"),
  writeFolderIcons: (text, expected) => call("write_folder_icons", { text, expected }),
  createNote: (parent, title) => call("create_note", { parent, title }),
  createFolder: (parent, name) => call("create_folder", { parent, name }),
  rename: (path, newName) => call("rename_entry", { path, newName }),
  // Moves a note or folder into another folder ("" is the top). Returns the new path.
  move: (path, newParent) => call("move_entry", { path, newParent }),
  // `data` is the picture as base64 text. Returns the path to write into the note.
  saveAttachment: (name, data) => call("save_attachment", { name, data }),
  // Returns the picture as a data: address.
  readAttachment: (path) => call("read_attachment", { path }),
  // Makes a copy of the vault next to it with the colours turned into plain highlights, for
  // Obsidian. Returns { path, notes, changed, files, skipped }. Not available on Android.
  exportObsidianCopy: () => call("export_obsidian_copy"),
  exportPage: (path) => call("export_page", { path }),
  // Delete moves a page or folder into the hidden trash folder. Returns the trash item.
  trash: (path) => call("trash_entry", { path }),
  // Items in the trash, newest first: { id, name, from, is_folder, deleted_at }.
  trashList: () => call("trash_list"),
  // Puts an item back. Returns the path it now has.
  trashRestore: (id) => call("trash_restore", { id }),
  trashDeleteForever: (id) => call("trash_delete_forever", { id }),
  trashEmpty: () => call("trash_empty"),
  // Returns { hits: [{ path, title, snippet: [[text, matched], ...] }], truncated }.
  search: (query, limit) => call("search_vault", { query, limit }),
  // The pages that link to `path`: { items: [{ path, title, count, snippet: [[text, marked], ...] }], truncated }.
  backlinks: (path) => call("backlinks", { path }),
  // The pages that have tags or are favourites: { pages: [{ path, tags: [name, ...], favorite }], truncated }.
  pageIndex: () => call("page_index"),
  // Older versions of a page, newest first: [{ id, time (seconds), size }]. The id is passed to historyRead.
  historyList: (path) => call("history_list", { path }),
  historyRead: (path, id) => call("history_read", { path, id }),
  // Copies the page as it is now into its history, before an older version is put back.
  historyKeepNow: (path) => call("history_keep_now", { path }),
  historyClear: () => call("history_clear"),
  log: (level, message) => call("log_line", { level, message }).catch(() => {}),
  getSettings: () => call("get_settings"),
  setSettings: (json) => call("set_settings", { json }),
  // Returns the chosen folder path, or null when the user cancels.
  pickFolder: async () => {
    const chosen = await open({ directory: true, multiple: false });
    return typeof chosen === "string" ? chosen : null;
  },
};
