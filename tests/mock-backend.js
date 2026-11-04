// Runs inside the test browser BEFORE the app loads. It stands in for the Rust side with
// an in-memory folder, and follows the same rules (versions, conflicts, error codes), so
// the real interface code can be driven end to end. It is a test aid only.
(() => {
  const files = new Map(); // path -> text
  const folders = new Set([""]);
  let settings = window.__seedSettings || "";
  const logs = [];
  const attachments = new Map(); // path -> base64 text
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
    default_vault_path: () => "/home/alice/Documents/ScaleNote",
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
    // A stand-in for the Rust picture commands: same limits and the same error codes.
    save_attachment: ({ name, data }) => {
      if (data.length > 14000000) fail("too_large");
      let bytes;
      try { bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0)); } catch { fail("unsupported_type"); }
      const png = [0x89, 0x50, 0x4e, 0x47].every((b, i) => bytes[i] === b);
      const jpg = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
      const gif = String.fromCharCode(...bytes.slice(0, 3)) === "GIF";
      const webp = String.fromCharCode(...bytes.slice(0, 4)) === "RIFF" && String.fromCharCode(...bytes.slice(8, 12)) === "WEBP";
      if (!(png || jpg || gif || webp)) fail("unsupported_type");
      const ext = png ? "png" : jpg ? "jpg" : gif ? "gif" : "webp";
      const stem = (name.replace(/\.[^.]*$/, "").replace(/[^\p{L}\p{N}_-]+/gu, "-").replace(/^-+|-+$/g, "")) || "image";
      let n = 1, path;
      for (;; n++) { path = `attachments/${n === 1 ? stem : stem + "-" + n}.${ext}`; if (!attachments.has(path) || attachments.get(path) === data) break; }
      attachments.set(path, data);
      return path;
    },
    read_attachment: ({ path }) => { if (!attachments.has(path)) fail("not_found"); return "data:image/png;base64," + attachments.get(path); },
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
      if (cmd === "plugin:opener|open_url") { window.__mock.opened.push(args.url); return; }
      const h = handlers[cmd];
      if (!h) throw "unknown";
      return h(args || {});
    },
  };
  window.__mock = { opened: [], setSettings: (t) => { settings = t; }, files, folders, attachments, logs, hash, getSettings: () => settings };
})();
