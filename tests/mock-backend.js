// Runs inside the test browser BEFORE the app loads. It stands in for the Rust side with
// an in-memory folder, and follows the same rules (versions, conflicts, error codes), so
// the real interface code can be driven end to end. It is a test aid only.
(() => {
  const files = new Map(); // path -> text
  const folders = new Set([""]);
  let settings = window.__seedSettings || "";
  const logs = [];
  const attachments = new Map(); // path -> base64 text
  const trashed = []; // oldest first
  const folderIcons = { text: null };
  const canvases = new Map(); // path of the page -> text of its drawing
  const history = new Map(); // path -> [{ id, time (seconds), text }]
  let trashSeq = 0;
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
    open_vault: ({ path }) => { if (path.includes("/gone")) fail("not_found"); return { name: "Picked", path }; },
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
    // The drawing of a page is a second text per page; Rust keeps it in Name.canvas.json.
    read_canvas: ({ path }) => {
      if (!files.has(path)) fail("not_found");
      return canvases.has(path) ? { text: canvases.get(path), version: hash(canvases.get(path)) } : null;
    },
    write_canvas: ({ path, text, expected }) => {
      if (!files.has(path)) fail("not_found");
      if (canvases.has(path)) { if (expected !== hash(canvases.get(path))) fail("conflict"); }
      else if (expected) fail("conflict");
      canvases.set(path, text); return hash(text);
    },
    // The folder icon file (.scalenote/folder-icons.json in the real vault).
    read_folder_icons: () => (folderIcons.text === null ? null : { text: folderIcons.text, version: hash(folderIcons.text) }),
    write_folder_icons: ({ text, expected }) => {
      if (folderIcons.text === null ? expected : expected !== hash(folderIcons.text)) fail("conflict");
      folderIcons.text = text; return hash(text);
    },
    // A stand-in for the page history: the copies a test puts in window.__mock.history are listed
    // as they are. The real rules (when copies are made, thinning, limits) are tested in Rust.
    history_list: ({ path }) => {
      if (!files.has(path)) fail("not_found");
      return [...(history.get(path) || [])].sort((a, b) => b.time - a.time).map(({ id, time, text }) => ({ id, time, size: text.length }));
    },
    history_read: ({ path, id }) => {
      const copy = (history.get(path) || []).find((c) => c.id === id);
      if (!copy) fail("not_found");
      return copy.text;
    },
    history_keep_now: ({ path }) => {
      if (!files.has(path)) fail("not_found");
      const list = history.get(path) || [];
      list.push({ id: String(Date.now() + list.length), time: Math.floor(Date.now() / 1000), text: files.get(path) });
      history.set(path, list);
    },
    history_clear: () => { history.clear(); },
    // A stand-in for the Rust picture commands: same limits and the same error codes.
    save_attachment: ({ name, data }) => {
      if (data.length > 34000000) fail("too_large");
      let bytes;
      try { bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0)); } catch { fail("unsupported_type"); }
      const png = [0x89, 0x50, 0x4e, 0x47].every((b, i) => bytes[i] === b);
      const jpg = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
      const gif = String.fromCharCode(...bytes.slice(0, 3)) === "GIF";
      const webp = String.fromCharCode(...bytes.slice(0, 4)) === "RIFF" && String.fromCharCode(...bytes.slice(8, 12)) === "WEBP";
      const pdf = String.fromCharCode(...bytes.slice(0, 5)) === "%PDF-";
      if (!(png || jpg || gif || webp || pdf)) fail("unsupported_type");
      // Pictures are limited to 10 MB, PDFs to 25 MB (as in Rust).
      if (!pdf && data.length > 14000000) fail("too_large");
      const ext = pdf ? "pdf" : png ? "png" : jpg ? "jpg" : gif ? "gif" : "webp";
      const stem = (name.replace(/\.[^.]*$/, "").replace(/[^\p{L}\p{N}_-]+/gu, "-").replace(/^-+|-+$/g, "")) || "image";
      let n = 1, path;
      for (;; n++) { path = `attachments/${n === 1 ? stem : stem + "-" + n}.${ext}`; if (!attachments.has(path) || attachments.get(path) === data) break; }
      attachments.set(path, data);
      return path;
    },
    // The converted copy is made by Rust (tested there with real files). Here the call is only
    // counted and answered, so the Settings button can be driven.
    export_obsidian_copy: () => {
      window.__exports = (window.__exports || 0) + 1;
      if (window.__failExport) fail(window.__failExport);
      return { path: "/home/alice/ScaleNote (Obsidian copy)", notes: 3, changed: 1, files: 2, skipped: window.__skippedExport || 0 };
    },
    // The page export is made by Rust (tested there with real files); here it is only recorded.
    export_page: ({ path }) => {
      if (!files.has(path)) fail("not_found");
      window.__pageExports = [...(window.__pageExports || []), path];
      if (window.__failExport) fail(window.__failExport);
      return { path: "/home/alice/ScaleNote (exports)/Page", pictures: 1, missing: window.__missingPictures || 0 };
    },
    // Stand-ins for the trash and search commands. The real rules are tested in Rust with real
    // folders; these follow the same shapes and error codes so the screens can be driven.
    trash_entry: ({ path }) => {
      const isNote = files.has(path);
      if (!path || (!isNote && !folders.has(path))) fail(path ? "not_found" : "invalid_path");
      const name = path.split("/").pop();
      const from = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
      const item = { id: `${1730000000000 + trashSeq}-${trashSeq++}`, name: name + (isNote ? "" : ""), from, is_folder: !isNote, deleted_at: 1730000000 + trashSeq, files: new Map(), folders: new Set() };
      if (isNote) { item.files.set("", files.get(path)); files.delete(path); }
      else {
        for (const [k, v] of [...files]) if (k.startsWith(path + "/")) { item.files.set(k.slice(path.length + 1), v); files.delete(k); }
        for (const f of [...folders]) if (f === path || f.startsWith(path + "/")) { item.folders.add(f.slice(path.length + 1)); folders.delete(f); }
      }
      trashed.push(item);
      const { files: _f, folders: _d, ...plain } = item;
      return plain;
    },
    trash_list: () => [...trashed].reverse().map(({ files: _f, folders: _d, ...plain }) => plain),
    trash_restore: ({ id }) => {
      const at = trashed.findIndex((i) => i.id === id);
      if (at < 0) fail(/^[0-9-]+$/.test(id) ? "not_found" : "invalid_path");
      const item = trashed[at];
      const parent = item.from === "" || folders.has(item.from) ? item.from : "";
      const taken = (n) => files.has(n) || folders.has(n);
      let name = item.name;
      const base = (n) => (parent ? parent + "/" : "") + n;
      if (taken(base(name))) name = item.is_folder ? `${name} (restored)` : name.replace(/\.md$/i, " (restored).md");
      const target = base(name);
      if (item.is_folder) {
        folders.add(target);
        for (const f of item.folders) if (f) folders.add(target + "/" + f);
        for (const [k, v] of item.files) files.set(target + "/" + k, v);
      } else files.set(target, item.files.get(""));
      trashed.splice(at, 1);
      return target;
    },
    trash_delete_forever: ({ id }) => {
      const at = trashed.findIndex((i) => i.id === id);
      if (at < 0) fail("not_found");
      trashed.splice(at, 1);
    },
    trash_empty: () => { const n = trashed.length; trashed.length = 0; return n; },
    search_vault: async ({ query, limit }) => {
      window.__searches = (window.__searches || 0) + 1;
      if (window.__failSearch) fail(window.__failSearch);
      if (window.__searchDelay) await new Promise((r) => setTimeout(r, window.__searchDelay));
      const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean).slice(0, 8);
      if (!words.length) return { hits: [], truncated: false };
      const hits = [];
      for (const [path, text] of files) {
        const title = path.split("/").pop().replace(/\.md$/i, "");
        const lower = text.toLowerCase();
        if (!words.every((w) => title.toLowerCase().includes(w) || lower.includes(w))) continue;
        const line = text.split("\n").find((l) => words.some((w) => l.toLowerCase().includes(w))) || "";
        const snippet = [];
        const re = new RegExp("(" + words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|") + ")", "gi");
        for (const [i, piece] of line.split(re).entries()) if (piece) snippet.push([piece, i % 2 === 1]);
        const exact = title.toLowerCase() === words.join(" ");
        const inTitle = words.every((w) => title.toLowerCase().includes(w));
        hits.push({ rank: exact ? 0 : inTitle ? 1 : 2, path, title, snippet });
      }
      hits.sort((a, b) => a.rank - b.rank || a.title.localeCompare(b.title));
      return { hits: hits.slice(0, Math.max(1, Math.min(limit, 50))).map(({ rank, ...h }) => h), truncated: false };
    },
    // A simple stand-in: names are matched without folders. The real rules are tested in Rust
    // and in tests/wikilinks.test.mjs against the same cases.
    backlinks: ({ path }) => {
      window.__backlinkCalls = (window.__backlinkCalls || 0) + 1;
      if (window.__failBacklinks) fail(window.__failBacklinks);
      if (!files.has(path)) return { items: [], truncated: false };
      const name = path.split("/").pop().replace(/\.md$/i, "").toLowerCase();
      const items = [];
      for (const [other, text] of files) {
        if (other === path) continue;
        const found = [...text.matchAll(/\[\[([^\]\[|#\n]*)[^\]\[\n]*\]\]/g)].filter((m) => m[1].trim().split("/").pop().replace(/\.md$/i, "").toLowerCase() === name);
        if (!found.length) continue;
        const line = text.split("\n").find((l) => l.includes(found[0][0]));
        const at = line.indexOf(found[0][0]);
        const snippet = [[line.slice(0, at), false], [found[0][0], true], [line.slice(at + found[0][0].length), false]].filter(([t]) => t);
        items.push({ path: other, title: other.split("/").pop().replace(/\.md$/i, ""), count: found.length, snippet });
      }
      items.sort((a, b) => a.title.localeCompare(b.title));
      return { items, truncated: false };
    },
    // A simple stand-in for the page index: the same shape of answer, with a looser reading of
    // tags. The real rules are tested in Rust and in tests/tags.test.mjs against the same cases.
    page_index: () => {
      window.__indexCalls = (window.__indexCalls || 0) + 1;
      if (window.__failIndex) fail(window.__failIndex);
      const pages = [];
      for (const [path, text] of [...files].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
        const front = /^---\r?\n([\s\S]*?\r?\n)?---[ \t]*(\r?\n|$)/.exec(text);
        const frontText = front ? front[0] : "";
        const body = text.slice(frontText.length).replace(/```[\s\S]*?```/g, "").replace(/`[^`\n]*`/g, "");
        const names = [];
        const list = /^tags:[ \t]*\[?([^\]\n]*)\]?[ \t]*$/m.exec(frontText);
        if (list) names.push(...list[1].split(/[,\s]+/).map((n) => n.replace(/^#/, "")).filter(Boolean));
        for (const m of body.matchAll(/(^|\s)#([\p{L}\p{N}_\-/]+)/gu)) if (/\P{N}/u.test(m[2])) names.push(m[2]);
        const seen = new Set();
        const tags = names.filter((n) => !seen.has(n.toLowerCase()) && seen.add(n.toLowerCase()));
        const favorite = /^favorite:[ \t]*true[ \t]*$/im.test(frontText);
        if (tags.length || favorite) pages.push({ path, tags, favorite });
      }
      return { pages, truncated: false };
    },
    read_attachment: ({ path }) => { if (!attachments.has(path)) fail("not_found"); return `data:${path.endsWith(".pdf") ? "application/pdf" : path.endsWith(".jpg") ? "image/jpeg" : "image/png"};base64,` + attachments.get(path); },
    create_note: ({ parent, title }) => { const p = unique(parent, title, ".md", (x) => files.has(x)); files.set(p, ""); return p; },
    create_folder: ({ parent, name }) => { const p = unique(parent, name, "", (x) => folders.has(x)); folders.add(p); return p; },
    move_entry: ({ path, newParent }) => {
      const isNote = files.has(path);
      const name = path.split("/").pop();
      if (!isNote && !folders.has(path)) fail("not_found");
      if (newParent && !folders.has(newParent)) fail("not_a_directory");
      if (!isNote && (newParent === path || newParent.startsWith(path + "/"))) fail("invalid_path");
      const target = (newParent ? newParent + "/" : "") + name;
      if (target === path) return path;
      if (files.has(target) || folders.has(target)) fail("already_exists");
      if (isNote) { files.set(target, files.get(path)); files.delete(path); }
      else {
        folders.delete(path); folders.add(target);
        for (const f of [...folders]) if (f.startsWith(path + "/")) { folders.delete(f); folders.add(target + f.slice(path.length)); }
        for (const [k, v] of [...files]) if (k.startsWith(path + "/")) { files.delete(k); files.set(target + k.slice(path.length), v); }
      }
      return target;
    },
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
      if (cmd === "plugin:opener|open_url") {
        // A test can make some addresses fail, to check the fallback.
        if (window.__mock.failOpen && args.url.includes(window.__mock.failOpen)) throw "not allowed";
        window.__mock.opened.push(args.url);
        return;
      }
      const h = handlers[cmd];
      if (!h) throw "unknown";
      return h(args || {});
    },
  };
  window.__mock = { canvases, folderIcons, opened: [], setSettings: (t) => { settings = t; }, files, folders, attachments, trashed, history, logs, hash, getSettings: () => settings };
})();
