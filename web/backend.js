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
  tree: () => call("vault_tree"),
  readNote: (path) => call("read_note", { path }),
  writeNote: (path, text, expected) => call("write_note", { path, text, expected }),
  createNote: (parent, title) => call("create_note", { parent, title }),
  createFolder: (parent, name) => call("create_folder", { parent, name }),
  rename: (path, newName) => call("rename_entry", { path, newName }),
  log: (level, message) => call("log_line", { level, message }).catch(() => {}),
  getSettings: () => call("get_settings"),
  setSettings: (json) => call("set_settings", { json }),
  // Returns the chosen folder path, or null when the user cancels.
  pickFolder: async () => {
    const chosen = await open({ directory: true, multiple: false });
    return typeof chosen === "string" ? chosen : null;
  },
};
