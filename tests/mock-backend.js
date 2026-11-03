// Runs inside the test browser BEFORE the app loads. It stands in for the Rust side with
// an in-memory folder, and follows the same rules (versions, conflicts, error codes), so
// the real interface code can be driven end to end. It is a test aid only.
(() => {
  const files = new Map(); // path -> text
  const folders = new Set([""]);
  let settings = "";
  const logs = [];
  const hash = (s) => { let h = 5381; for (const c of new TextEncoder().encode(s)) h = ((h * 33) ^ c) >>> 0; return `${s.length.toString(16)}-${h.toString(16)}`; };
  const fail = (code) => { throw code; };
  const unique = (parent, stem, ext, exists) => {
    for (let n = 1; ; n++) { const name = n === 1 ? stem : `${stem} ${n}`; const p = (parent ? parent + "/" : "") + name + ext; if (!exists(p)) return p; }
  };
  const handlers = {
    get_settings: () => settings,
    set_settings: ({ json }) => { settings = json; },
    log_line: ({ level, message }) => { logs.push(level + " " + message); },
    open_default_vault: () => ({ name: "ScaleNote", path: "/vault" }),
    open_vault: ({ path }) => ({ name: "Picked", path }),
    vault_tree: () => {
      const entries = [];
      for (const f of [...folders].filter(Boolean).sort()) entries.push({ path: f, name: f.split("/").pop(), kind: "folder" });
      for (const p of [...files.keys()]) entries.push({ path: p, name: p.split("/").pop(), kind: "note" });
      entries.sort((a, b) => (a.path.split("/").length - b.path.split("/").length) || a.path.localeCompare(b.path));
      // Rust sorts depth first; the sidebar only needs parents before children.
      return { entries, truncated: false };
    },
    read_note: ({ path }) => { if (!files.has(path)) fail("not_found"); return { text: files.get(path), version: hash(files.get(path)) }; },
    write_note: ({ path, text, expected }) => {
      if (files.has(path)) { if (expected !== hash(files.get(path))) fail("conflict"); }
      else if (expected) fail("conflict");
      files.set(path, text); return hash(text);
    },
    create_note: ({ parent, title }) => { const p = unique(parent, title, ".md", (x) => files.has(x)); files.set(p, ""); return p; },
    create_folder: ({ parent, name }) => { const p = unique(parent, name, "", (x) => folders.has(x)); folders.add(p); return p; },
    rename_entry: ({ path, newName }) => {
      const isNote = files.has(path); const dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/") + 1) : "";
      const target = dir + newName.replace(/[\/\\:*?"<>|]/g, "") + (isNote ? ".md" : "");
      if (target !== path && (files.has(target) || folders.has(target))) fail("already_exists");
      if (isNote) { files.set(target, files.get(path)); files.delete(path); }
      else { folders.delete(path); folders.add(target); for (const [k, v] of [...files]) if (k.startsWith(path + "/")) { files.delete(k); files.set(target + k.slice(path.length), v); } }
      return target;
    },
  };
  let callbackId = 1;
  window.__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: "main" }, currentWebview: { windowLabel: "main", label: "main" } },
    transformCallback: () => callbackId++,
    unregisterCallback: () => {},
    convertFileSrc: (p) => p,
    invoke: async (cmd, args) => {
      if (cmd.startsWith("plugin:event|")) return 1;
      if (cmd === "plugin:dialog|open") return "/picked/folder";
      const h = handlers[cmd];
      if (!h) throw "unknown";
      return h(args || {});
    },
  };
  window.__mock = { files, folders, logs, hash, getSettings: () => settings };
})();
