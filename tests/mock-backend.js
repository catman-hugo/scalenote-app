// Runs inside the test browser BEFORE the app loads. It stands in for the Rust side with
// an in-memory folder, and follows the same rules (versions, conflicts, error codes), so
// the real interface code can be driven end to end. It is a test aid only.
(() => {
  const files = new Map(); // path -> text
  for (const [name, text] of Object.entries(window.__seedFiles || {})) files.set(name, text);
  const folders = new Set([""]);
  let settings = window.__seedSettings || "";
  const logs = [];
  const attachments = new Map(); // path -> base64 text
  const trashed = []; // oldest first
  const folderIcons = { text: null };
  const canvases = new Map(); // path of the page -> text of its drawing
  const history = new Map(); // path -> [{ id, time (seconds), text }]
  let trashSeq = 0;
  const syncDevice = { name: "this-device", enabled: true };
  // Stand-in for the pairing service. The real rules (codes, attempts, keys) are tested in Rust
  // with real connections; here the screen is driven with a fixed code.
  const syncPairing = { peers: [], events: [], secondsLeft: null, paused: false, syncing: null };
  const syncStamp = () => "2026-01-01T12:00:00Z";
  const hash = (s) => { let h = 5381; for (const c of new TextEncoder().encode(s)) h = ((h * 33) ^ c) >>> 0; return `${s.length.toString(16)}-${h.toString(16)}`; };
  const fail = (code) => { throw code; };
  const unique = (parent, stem, ext, exists) => {
    for (let n = 1; ; n++) { const name = n === 1 ? stem : `${stem} ${n}`; const p = (parent ? parent + "/" : "") + name + ext; if (!exists(p)) return p; }
  };
  // Offline choices (0.6.3): the real rules are tested in Rust. Here pages in
  // window.__elsewhere are "on another device"; they are listed until brought.
  const offline = { choices: new Map(), elsewhere: new Map(Object.entries(window.__elsewhere || {})), sets: [] };
  const account = { id: null, name: "", findable: false };
  const handlers = {
    account_get: () => ({ ...account }),
    account_set_name: ({ name }) => {
      const clean = String(name).replace(/\s+/g, " ").trim().slice(0, 40);
      if (!clean) fail("account_name_empty");
      account.name = clean;
      account.id = account.id || "a1b2c3d4e5f60718293a4b5c6d7e8f90";
      return { ...account };
    },
    account_set_findable: ({ findable }) => {
      if (findable && !account.name) fail("account_name_empty");
      account.findable = Boolean(findable);
      return { ...account };
    },
    people_nearby: () => window.__peopleNearby || [],
    offline_get: () => ({
      choices: [...offline.choices].map(([path, kinds]) => ({ path, kinds })),
      notHere: [...offline.elsewhere.keys()].filter((p) => !files.has(p)),
    }),
    offline_set: ({ path, kinds }) => {
      if (kinds !== null && kinds !== undefined && !/^(-|[tdif]{1,4})$/.test(kinds)) fail("offline_bad_choice");
      offline.sets.push({ path, kinds: kinds ?? null });
      if (kinds === null || kinds === undefined) offline.choices.delete(path);
      else offline.choices.set(path, kinds);
      return window.__offlineFreed || { removed: 0, bytes: 0, onlyHere: 0 };
    },
    offline_fetch: ({ paths }) => {
      if (window.__offlineUnreachable) fail("not_available_offline");
      const got = [];
      for (const p of paths) {
        if (!offline.elsewhere.has(p) || files.has(p)) continue;
        files.set(p, offline.elsewhere.get(p));
        const parts = p.split("/");
        for (let i = 1; i < parts.length; i++) folders.add(parts.slice(0, i).join("/"));
        got.push(p);
      }
      if (!got.length) fail("not_available_offline");
      return got;
    },
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
      if (data.length > 90000000) fail("too_large");
      let bytes;
      try { bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0)); } catch { fail("unsupported_type"); }
      const png = [0x89, 0x50, 0x4e, 0x47].every((b, i) => bytes[i] === b);
      const jpg = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
      const gif = String.fromCharCode(...bytes.slice(0, 3)) === "GIF";
      const webp = String.fromCharCode(...bytes.slice(0, 4)) === "RIFF" && String.fromCharCode(...bytes.slice(8, 12)) === "WEBP";
      const pdf = String.fromCharCode(...bytes.slice(0, 5)) === "%PDF-";
      if (!(png || jpg || gif || webp || pdf)) fail("unsupported_type");
      // Pictures are limited to 10 MB, PDFs to 64 MB (as in Rust).
      if (!pdf && data.length > 14000000) fail("too_large");
      const ext = pdf ? "pdf" : png ? "png" : jpg ? "jpg" : gif ? "gif" : "webp";
      const stem = (name.replace(/\.[^.]*$/, "").replace(/[^\p{L}\p{N}_-]+/gu, "-").replace(/^-+|-+$/g, "")) || "image";
      let n = 1, path;
      for (;; n++) { path = `attachments/${n === 1 ? stem : stem + "-" + n}.${ext}`; if (!attachments.has(path) || attachments.get(path) === data) break; }
      attachments.set(path, data);
      // A test can slow saving down, to look at an import while it is still running.
      if (window.__saveDelay) return new Promise((resolve) => setTimeout(() => resolve(path), window.__saveDelay));
      return path;
    },
    // The converted copy is made by Rust (tested there with real files). Here the call is only
    // counted and answered, so the Settings button can be driven.
    export_obsidian_copy: () => {
      window.__exports = (window.__exports || 0) + 1;
      if (window.__failExport) fail(window.__failExport);
      return { path: "/home/alice/ScaleNote (Obsidian copy)", notes: 3, changed: 1, files: 2, skipped: window.__skippedExport || 0 };
    },
    // Backups are made by Rust (tested there with real files). The stand-in keeps a list so the
    // Settings screen can be driven.
    // The tray and the login list are the computer's own; the stand-in only remembers the calls.
    set_zoom: ({ scale }) => { window.__zoom = scale; },
    // In-app updates on a computer: a test says which kind of file the app came in, and whether
    // installing fails. A success never returns in the real app (it closes or restarts).
    log_tail: () => "2026-11-20T08:00:00Z INFO ui: example line\n",
    install_kind: () => window.__installKind || null,
    install_update: ({ version }) => { window.__mock.installed.push(version); if (window.__installFails) fail(window.__installFails); return new Promise(() => {}); },
    // The lock's rules (hash, waits) are Rust's and tested there; this keeps the plain secret
    // so the screens can be driven. A test can start with a lock by setting __seedLock.
    ...(() => {
      const lock = { secret: null, kind: "pin", locked: false, biometric: false, wrong: 0 };
      window.__lock = lock;
      // A test's starting lock is read at the first question, so its own start script may run later.
      let seeded = false;
      const seed = () => {
        if (seeded) return;
        seeded = true;
        if (window.__seedLock) Object.assign(lock, window.__seedLock, { locked: true });
      };
      const shape = (kind, secret) => {
        if (kind === "pin" && !/^[0-9]*$/.test(secret)) fail("lock_pin_digits");
        if (secret.length < (kind === "pin" ? 4 : 6)) fail("lock_too_short");
      };
      return {
        lock_status: () => { seed(); return { enabled: lock.secret !== null, locked: lock.secret !== null && lock.locked, kind: lock.kind, biometric: lock.biometric, biometricAvailable: Boolean(window.__biometricAvailable) }; },
        lock_set: ({ kind, secret, current }) => { seed();
          if (lock.locked) fail("locked");
          if (lock.secret !== null && current !== lock.secret) fail("lock_wrong");
          shape(kind, secret);
          Object.assign(lock, { secret, kind });
        },
        lock_remove: ({ current }) => { seed();
          if (lock.locked) fail("locked");
          if (current !== lock.secret) fail("lock_wrong");
          lock.secret = null;
        },
        lock_unlock: ({ secret }) => { seed();
          if (secret === lock.secret) { lock.locked = false; lock.wrong = 0; return { ok: true, wait: 0 }; }
          lock.wrong++;
          return { ok: false, wait: lock.wrong >= 5 ? 30 : 0 };
        },
        lock_now: () => { seed(); if (lock.secret === null) return false; lock.locked = true; return true; },
        lock_set_biometric: ({ on }) => { seed(); if (!window.__biometricAvailable) fail("unsupported"); lock.biometric = on; return true; },
        lock_biometric_unlock: () => { seed(); if (!window.__biometricOk) return false; lock.locked = false; return true; },
      };
    })(),
    tray_set: ({ enabled, showLabel, quitLabel }) => {
      if (window.__failTray) fail(window.__failTray);
      window.__tray = { enabled, showLabel, quitLabel };
    },
    hide_main_window: () => { window.__hidden = (window.__hidden || 0) + 1; },
    autostart_get: () => {
      if (window.__failAutostart) fail(window.__failAutostart);
      return window.__autostart === true;
    },
    autostart_set: ({ enabled }) => {
      if (window.__failAutostart) fail(window.__failAutostart);
      window.__autostart = enabled;
      return enabled;
    },
    backup_make: () => {
      if (window.__failBackup) fail(window.__failBackup);
      const list = (window.__backups = window.__backups || []);
      const n = list.length + 1;
      const made = { name: `2026-11-18 12-00-0${n}`, when: `2026-11-18 12:00:0${n}` };
      list.unshift(made);
      return { ...made, files: 4, skipped: window.__skippedBackup || 0 };
    },
    backup_list: () => (window.__backups = window.__backups || []).map((b) => ({ ...b })),
    backup_restore: ({ name }) => {
      window.__restored = (window.__restored || []).concat(name);
      if (window.__failBackup) fail(window.__failBackup);
      return { added: 1, replaced: 2, unchanged: 3, skipped: 0 };
    },
    // Same shapes as the real commands. The name is cleaned in Rust (tested there); the stand-in
    // only drops what a file name could not hold, so the screen can be driven.
    get_sync_settings: () => {
      if (window.__failSync) fail("io");
      return { ...syncDevice };
    },
    set_sync_settings: ({ name, enabled }) => {
      if (window.__failSync) fail("io");
      if (name !== null && name !== undefined) syncDevice.name = name.replace(/[^\p{L}\p{N}_ -]/gu, "").trim().replace(/ +/g, "-").slice(0, 40) || "this-device";
      if (enabled !== null && enabled !== undefined) syncDevice.enabled = enabled;
      window.__syncSaves = (window.__syncSaves || 0) + 1;
      return { ...syncDevice };
    },
    sync_status: () => {
      if (window.__failSync) fail("io");
      if (syncPairing.secondsLeft !== null && window.__pairTick) syncPairing.secondsLeft = Math.max(0, syncPairing.secondsLeft - 1);
      if (syncPairing.secondsLeft === 0) syncPairing.secondsLeft = null;
      return {
        problem: null,
        enabled: syncDevice.enabled,
        listeningPort: 47821,
        address: window.__noAddress ? null : "192.168.1.20",
        addresses: window.__noAddress ? [] : window.__addresses || ["192.168.1.20"],
        tailscale: window.__tailscale || null,
        fingerprint: "ab12 cd34 ef56 7890 1234",
        paused: syncPairing.paused,
        syncing: syncPairing.syncing,
        peers: syncPairing.peers.map((p) => ({ lastSync: "", lastChanged: 0, version: "", olderVersion: false, hasHistory: false, wifiOnly: false, folder: "", otherFolder: false, ...p })),
        pairingSecondsLeft: syncPairing.secondsLeft,
        events: [...syncPairing.events].reverse(),
      };
    },
    sync_start_pairing: () => {
      if (window.__failPairing) fail(window.__failPairing);
      if (!syncDevice.enabled) fail("sync_off");
      syncPairing.secondsLeft = 120;
      window.__pairStarts = (window.__pairStarts || 0) + 1;
      return "12345678";
    },
    sync_stop_pairing: () => {
      syncPairing.secondsLeft = null;
      window.__pairStops = (window.__pairStops || 0) + 1;
    },
    sync_join: ({ address, code }) => {
      window.__joins = [...(window.__joins || []), { address, code }];
      if (code.length !== 8) fail("pair_bad_code");
      if (window.__failJoin) fail(window.__failJoin);
      syncPairing.peers.push({ id: "k" + syncPairing.peers.length, name: "bob-laptop", fingerprint: "1111 2222 3333 4444 5555", added: syncStamp(), lastSync: "", lastChanged: 0, hasHistory: false });
      syncPairing.events.push({ when: syncStamp(), kind: "paired", name: "bob-laptop" });
      return "bob-laptop";
    },
    sync_find: () => {
      if (!syncDevice.enabled) fail("sync_off");
      if (window.__failFind) fail(window.__failFind);
      window.__finds = (window.__finds || 0) + 1;
      return window.__nearby || [];
    },
    // Stand-ins for the sync itself. The real rules (plans, conflicts, trash, limits) are tested in
    // Rust with two real services and real folders; here the screens are driven with fixed answers.
    sync_compare: ({ id }) => {
      window.__compares = [...(window.__compares || []), id];
      if (window.__failSyncRun) fail(window.__failSyncRun);
      return window.__syncPreview || { first: false, send: 0, receive: 0, deleteHere: 0, deleteThere: 0, conflicts: 0, clashes: 0, skippedHere: 0, skippedThere: 0, tooBig: [], filesHere: 3, filesThere: 3, items: [], itemsTruncated: false };
    },
    sync_run: ({ id, approved }) => {
      window.__runs = [...(window.__runs || []), { id, approved }];
      if (window.__onWifiNow === false && (syncPairing.peers.find((p) => p.id === id) || {}).wifiOnly) fail("sync_wifi_only");
      if (window.__failSyncRun) fail(window.__failSyncRun);
      const peer = syncPairing.peers.find((p) => p.id === id);
      const preview = window.__syncPreview;
      if (preview && preview.first && !approved) return { needsApproval: true, preview, report: null };
      const report = window.__syncReport || { sent: 1, received: 2, deletedHere: 0, deletedThere: 0, conflicts: 0, conflictCopies: [], leftForNext: 0, tooBig: [], clashes: 0 };
      const changed = report.sent + report.received + report.deletedHere + report.deletedThere + report.conflicts;
      if (peer) { peer.hasHistory = true; peer.lastSync = syncStamp(); peer.lastChanged = changed; }
      syncPairing.events.push({ when: syncStamp(), kind: "synced", name: peer ? peer.name : "bob-laptop", changed });
      return { needsApproval: false, preview: null, report };
    },
    sync_set_paused: ({ paused }) => { syncPairing.paused = paused; },
    // The folder rules are Rust's (tested there); this only records the move.
    sync_tie_to_open_folder: ({ id }) => {
      const peer = syncPairing.peers.find((p) => p.id === id);
      if (!peer) fail("pair_refused");
      window.__tiedHere = [...(window.__tiedHere || []), id];
      peer.otherFolder = false;
      peer.folder = "/vault";
    },
    sync_set_wifi_only: ({ id, only }) => {
      const peer = syncPairing.peers.find((p) => p.id === id);
      window.__wifiCalls = [...(window.__wifiCalls || []), { id, only }];
      if (!peer) fail("pair_refused");
      peer.wifiOnly = only;
    },
    sync_set_on_wifi: ({ onWifi }) => { window.__onWifiCalls = [...(window.__onWifiCalls || []), onWifi]; window.__onWifiNow = onWifi; },
    sync_rename_peer: ({ id, name }) => {
      if (window.__failRename) fail("io");
      const peer = syncPairing.peers.find((p) => p.id === id);
      if (!peer) fail("pair_refused");
      peer.name = name.replace(/[^\p{L}\p{N}_ -]/gu, "").trim().replace(/ +/g, "-") || "this-device";
    },
    // Changes whenever a page or folder is added, removed or changed; a test can also bump it.
    vault_signature: () => hash([...files.entries()].map(([p, t]) => p + "\n" + t).join("\n") + [...folders].join("|") + (window.__sigBump || 0)),
    conflicts_list: () => (window.__conflicts || []).map((c) => ({ ...c })),
    conflict_settle: ({ copy, keep }) => {
      window.__settles = [...(window.__settles || []), { copy, keep }];
      if (window.__settleChanged) return false;
      window.__conflicts = (window.__conflicts || []).filter((c) => c.copy !== copy);
      const item = (window.__conflictsAll || []).find((c) => c.copy === copy);
      if (item && keep === "copy") files.set(item.original, files.get(copy));
      files.delete(copy);
      return true;
    },
    sync_remove_peer: ({ id }) => {
      const before = syncPairing.peers.length;
      syncPairing.peers = syncPairing.peers.filter((p) => p.id !== id);
      syncPairing.events.push({ when: syncStamp(), kind: "removed", name: "bob-laptop" });
      return syncPairing.peers.length < before;
    },
    // The page export is made by Rust (tested there with real files); here it is only recorded.
    export_page: ({ path, drawing }) => {
      if (!files.has(path)) fail("not_found");
      window.__pageExports = [...(window.__pageExports || []), path];
      window.__exportDrawings = [...(window.__exportDrawings || []), drawing || null];
      if (window.__failExport) fail(window.__failExport);
      return { path: "/home/alice/ScaleNote (exports)/Page", pictures: 1, missing: window.__missingPictures || 0, drawing: Boolean(drawing) };
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
    // Page words beside a picture. The real rules (only beside an existing picture) are tested in Rust.
    write_page_text: ({ picture, text }) => {
      if (!attachments.has(picture)) fail("not_found");
      (window.__pageTexts = window.__pageTexts || new Map()).set(picture, text);
    },
    read_page_text: ({ picture }) => {
      const kept = window.__pageTexts && window.__pageTexts.get(picture);
      if (kept === undefined) fail("not_found");
      return kept;
    },
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
  // Callbacks handed over by the app, and which event each one listens to, so a test can send
  // an event the way Rust would (window.__mock.emit).
  const callbacks = new Map();
  const listeners = [];
  // Tauri's event helper removes a listener through this object.
  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
  window.__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: "main" }, currentWebview: { windowLabel: "main", label: "main" } },
    transformCallback: (fn) => { const id = callbackId++; callbacks.set(id, fn); return id; },
    unregisterCallback: (id) => callbacks.delete(id),
    convertFileSrc: (p) => p,
    invoke: async (cmd, args) => {
      if (cmd === "plugin:event|listen") { listeners.push({ event: args.event, handler: args.handler }); return args.handler; }
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
  window.__mock = {
    offline,
    account, emit: (event, payload) => { for (const l of listeners) if (l.event === event && callbacks.has(l.handler)) callbacks.get(l.handler)({ event, id: l.handler, payload }); }, installed: [], syncPeers: () => syncPairing.peers, peerPairs: (id) => { syncPairing.peers.push({ id: id || "p" + syncPairing.peers.length, name: "alice-phone", fingerprint: "9999 8888 7777 6666 5555", added: syncStamp(), lastSync: "", lastChanged: 0, hasHistory: false }); syncPairing.events.push({ when: syncStamp(), kind: "paired", name: "alice-phone" }); }, canvases, folderIcons, opened: [], setSettings: (t) => { settings = t; }, files, folders, attachments, trashed, history, logs, hash, getSettings: () => settings };
})();
