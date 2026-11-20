// The pairing part of the Sync tab: this device's fingerprint, the paired devices, showing a
// code for another device to enter, entering a code from another device, and the activity list.
//
// While a code is shown the screen asks Rust for the state once a second, so the countdown and
// "paired" show up without a button. When the Settings window closes, the code is stopped at
// once so the device does not keep listening for pairings nobody can see.

import { BackendError, backend } from "./backend.js";
import { openConflictReview } from "./conflictreview.js";
import { groupCode, timeLeftText } from "./syncpairrules.js";
import { peerControls } from "./syncrun.js";
import { strings } from "./strings.js";

const POLL_MS = 1000;

// The last part of a folder path, for showing ("C:\\Users\\bob\\Notes" and "/home/bob/Notes" both give "Notes").
function folderName(path) {
  const parts = String(path).split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] || String(path);
}

function fill(template, values) {
  return template.replace(/\{(\w+)\}/g, (_, key) => String(values[key] ?? ""));
}

function errorSentence(error) {
  const code = error instanceof BackendError ? error.code : "unknown";
  return strings.errors[code] || strings.errors.unknown;
}

function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text) node.textContent = text;
  if (className) node.className = className;
  return node;
}

function button(text, onClick, primary) {
  const node = element("button", text, primary ? "primary" : "");
  node.type = "button";
  node.addEventListener("click", onClick);
  return node;
}

function activityLine(event) {
  const s = strings.settings;
  const synced = event.changed > 0 ? s.activitySynced : s.activitySyncedNone;
  const template = { paired: s.activityPaired, refused: s.activityRefused, removed: s.activityRemoved, synced, syncFailed: s.activitySyncFailed }[event.kind];
  return fill(template || "{when}", { when: event.when.replace("T", " ").replace("Z", " UTC"), name: event.name, changed: event.changed });
}

/** Returns the rows to append to the Sync tab. `isOn()` says whether the switch is on. */
export function pairingRows(logProblem, { onVaultChanged = async () => {}, wifi = null } = {}) {
  const s = strings.settings;
  const message = element("p", "", "setting-hint");
  message.id = "pairMessage";
  message.setAttribute("role", "status");

  const fingerprint = element("p", "", "setting-hint");
  fingerprint.id = "pairFingerprint";
  // This device's Tailscale address, or a short note on what Tailscale is for (tailscale.rs).
  const tailscaleText = element("p", "", "setting-hint");
  tailscaleText.id = "pairTailscale";
  const list = element("ul", "", "pair-list");
  list.id = "pairList";
  const activity = element("ul", "", "pair-list");
  activity.id = "pairActivity";

  const codeBox = element("div", "", "pair-code-box");
  codeBox.id = "pairCodeBox";
  codeBox.hidden = true;
  const codeText = element("p", "", "pair-code");
  codeText.id = "pairCode";
  const addressText = element("p", "", "setting-hint");
  addressText.id = "pairAddressText";
  const codeTailscale = element("p", "", "setting-hint");
  codeTailscale.id = "pairCodeTailscale";
  const leftText = element("p", "", "setting-hint");
  leftText.id = "pairLeft";
  codeBox.append(element("p", s.pairShow, "setting-hint"), codeText, addressText, codeTailscale, leftText);

  let pairing = false;
  let knownPeers = null;
  let timer = null;
  let removing = null;
  // The device whose "move to this folder" button was pressed once (a second press does it).
  let moving = null;
  let paused = false;
  let lastStatus = null;

  const startButton = button(s.pairStart, () => start());
  startButton.id = "pairStart";
  const stopButton = button(s.pairStop, () => stop(s.pairEnded));
  stopButton.id = "pairStop";
  stopButton.hidden = true;

  const address = element("input");
  address.type = "text";
  address.id = "pairJoinAddress";
  address.maxLength = 255;
  address.autocomplete = "off";
  address.placeholder = s.pairAddressExample;
  const code = element("input");
  code.type = "text";
  code.id = "pairJoinCode";
  code.maxLength = 12;
  code.inputMode = "numeric";
  code.autocomplete = "off";
  const joinButton = button(s.pairJoin, () => join());
  joinButton.id = "pairJoin";
  const findButton = button(s.pairFind, () => find());
  findButton.id = "pairFind";
  const nearby = element("ul", "", "pair-list");
  nearby.id = "pairNearby";
  nearby.hidden = true;

  const pauseButton = button(s.pauseButton, async () => {
    try {
      await backend.syncSetPaused(!paused);
      await refresh();
      document.dispatchEvent(new Event("scalenote-sync-changed"));
    } catch (error) {
      logProblem("pausing sync failed", error);
      message.textContent = errorSentence(error);
    }
  });
  pauseButton.id = "syncPause";
  const pausedHint = element("p", s.pausedHint, "setting-hint");
  pausedHint.id = "syncPausedHint";
  pausedHint.hidden = true;
  const conflictsButton = button(s.conflictsOpen, () => openConflictReview({ logProblem, onSettled: onVaultChanged }));
  conflictsButton.id = "conflictsOpen";

  const labelled = (text, input) => {
    const row = element("label", "", "setting-row pair-field");
    row.append(element("span", text, "setting-label"), input);
    return row;
  };

  function showPeers(peers) {
    list.replaceChildren();
    if (peers.length === 0) {
      list.append(element("li", s.pairNone));
      return;
    }
    for (const peer of peers) {
      const item = element("li", "", "pair-peer");
      const head = element("div", "", "pair-item");
      const text = element("span", `${peer.name} (${peer.fingerprint})`, "pair-name");
      const remove = button(removing === peer.id ? s.pairRemoveConfirm : s.pairRemove, async () => {
        if (removing !== peer.id) {
          removing = peer.id;
          showPeers(peers);
          return;
        }
        removing = null;
        try {
          await backend.syncRemovePeer(peer.id);
          await refresh();
        } catch (error) {
          logProblem("removing a paired device failed", error);
          message.textContent = errorSentence(error);
        }
      });
      remove.className = "pair-remove";
      head.append(text, remove);
      const stamp = peer.lastSync.replace("T", " ").replace("Z", " UTC");
      const when = peer.lastSync ? (peer.lastChanged > 0 ? fill(s.pairLastSync, { when: stamp, n: peer.lastChanged }) : fill(s.pairLastSyncPlain, { when: stamp })) : peer.hasHistory ? "" : s.pairNeverSynced;
      item.append(head);
      if (when) item.append(element("p", when, "setting-hint pair-last"));
      // The version the device reported at the last sync. An older one is said plainly, since it may lack newer fixes.
      if (peer.version) item.append(element("p", fill(peer.olderVersion ? s.pairVersionOlder : s.pairVersion, { v: peer.version }), "setting-hint pair-version"));
      // Learned from the device itself at a sync; used when it cannot be found on this network.
      if (peer.tailscale) item.append(element("p", fill(s.pairPeerTailscale, { address: peer.tailscale }), "setting-hint pair-tailscale"));
      // Each paired device belongs to one notes folder here. Shown by its folder name; when it
      // is another folder than the open one, the device does not sync now, and it can be moved.
      if (peer.folder) {
        const name = folderName(peer.folder);
        const line = element("p", fill(peer.otherFolder ? s.pairFolderOther : s.pairFolder, { folder: name }), "setting-hint pair-folder");
        line.title = peer.folder;
        item.append(line);
        if (peer.otherFolder) {
          const move = button(moving === peer.id ? s.pairMoveConfirm : s.pairMove, async () => {
            if (moving !== peer.id) {
              moving = peer.id;
              showPeers(peers);
              return;
            }
            moving = null;
            try {
              await backend.syncTieToOpenFolder(peer.id);
              await refresh();
            } catch (error) {
              logProblem("moving a paired device to this folder failed", error);
              message.textContent = errorSentence(error);
            }
          });
          move.className = "pair-move";
          item.append(move);
        }
      }
      item.append(peerControls(peer, { logProblem, paused, wifi, done: afterSync }));
      list.append(item);
    }
  }

  // After a sync or a rename: show the new state here, tell the status line and the page list.
  async function afterSync(report) {
    await refresh();
    document.dispatchEvent(new Event("scalenote-sync-changed"));
    if (report && report.sent + report.received + report.deletedHere + report.deletedThere + report.conflicts > 0) await onVaultChanged();
  }

  function showStatus(status) {
    lastStatus = status;
    paused = status.paused;
    pauseButton.textContent = paused ? s.resumeButton : s.pauseButton;
    pausedHint.hidden = !paused;
    fingerprint.textContent = `${s.pairThisDevice}: ${status.fingerprint}`;
    tailscaleText.textContent = status.tailscale ? fill(s.tailscaleOn, { address: status.tailscale }) : s.tailscaleOff;
    showPeers(status.peers);
    activity.replaceChildren();
    if (status.events.length === 0) activity.append(element("li", s.activityNone));
    for (const event of status.events) activity.append(element("li", activityLine(event)));
    // A device that paired while the code was showing: say so and close the code.
    if (pairing && knownPeers !== null && status.peers.length > knownPeers) {
      const newest = status.peers[status.peers.length - 1];
      showEnded(fill(s.pairDone, { name: newest.name }));
    } else if (pairing && status.pairingSecondsLeft == null) {
      showEnded(s.pairEnded);
    } else if (pairing) {
      leftText.textContent = fill(s.pairLeft, { time: timeLeftText(status.pairingSecondsLeft) });
    }
    knownPeers = status.peers.length;
  }

  function showEnded(text) {
    pairing = false;
    codeBox.hidden = true;
    stopButton.hidden = true;
    startButton.hidden = false;
    message.textContent = text;
  }

  async function refresh() {
    try {
      showStatus(await backend.syncStatus());
    } catch (error) {
      logProblem("reading the sync status failed", error);
      message.textContent = errorSentence(error);
      startButton.disabled = true;
      joinButton.disabled = true;
      stopTimer();
    }
  }

  function stopTimer() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  function watch() {
    stopTimer();
    timer = setInterval(() => {
      // Settings was closed: stop showing the code, so nothing keeps listening unseen.
      if (!list.isConnected || !list.closest("dialog")?.open) {
        stopTimer();
        if (pairing) stop(null);
        return;
      }
      refresh();
    }, POLL_MS);
  }

  async function start() {
    message.textContent = "";
    try {
      const fresh = await backend.syncStartPairing();
      const status = await backend.syncStatus();
      pairing = true;
      knownPeers = status.peers.length;
      codeText.textContent = groupCode(fresh);
      addressText.textContent = `${s.pairAddress}: ${status.address ? `${status.address}:${status.listeningPort ?? ""}` : s.pairNoAddress}`;
      // From another network (eduroam, mobile data) only the Tailscale address can reach this device.
      codeTailscale.textContent = status.tailscale ? fill(s.pairCodeTailscale, { address: status.tailscale }) : "";
      codeTailscale.hidden = !status.tailscale;
      codeBox.hidden = false;
      stopButton.hidden = false;
      startButton.hidden = true;
      showStatus(status);
      watch();
    } catch (error) {
      logProblem("starting pairing failed", error);
      message.textContent = errorSentence(error);
    }
  }

  async function stop(text) {
    try {
      await backend.syncStopPairing();
    } catch (error) {
      logProblem("stopping pairing failed", error);
    }
    if (text !== null) showEnded(text);
    else pairing = false;
  }

  // Listens for devices that are showing a code; choosing one puts its address in the field.
  async function find() {
    message.textContent = "";
    findButton.disabled = true;
    findButton.textContent = s.pairFinding;
    try {
      const found = (await backend.syncFind()).filter((device) => !device.paired);
      nearby.replaceChildren();
      nearby.hidden = false;
      if (found.length === 0) nearby.append(element("li", s.pairFoundNone));
      for (const device of found) {
        const item = element("li", "", "pair-item");
        item.append(element("span", `${device.name} (${device.address})`, "pair-name"));
        const use = button(s.pairUse, () => {
          address.value = device.address;
          code.focus();
        });
        use.className = "pair-use";
        use.setAttribute("aria-label", `${s.pairUse} ${device.name}`);
        item.append(use);
        nearby.append(item);
      }
    } catch (error) {
      logProblem("looking for devices failed", error);
      message.textContent = errorSentence(error);
    } finally {
      findButton.disabled = false;
      findButton.textContent = s.pairFind;
    }
  }

  async function join() {
    message.textContent = "";
    joinButton.disabled = true;
    joinButton.textContent = s.pairJoining;
    try {
      const name = await backend.syncJoin(address.value.trim(), code.value.replace(/\s+/g, ""));
      code.value = "";
      message.textContent = fill(s.pairDone, { name });
      await refresh();
    } catch (error) {
      logProblem("pairing failed", error);
      message.textContent = errorSentence(error);
    } finally {
      joinButton.disabled = false;
      joinButton.textContent = s.pairJoin;
    }
  }

  // The timer only runs while a code is shown (see start); otherwise the list is read once.
  refresh();

  return [
    element("h3", s.pairHeading, "setting-heading"),
    fingerprint,
    tailscaleText,
    list,
    pauseButton,
    pausedHint,
    conflictsButton,
    startButton,
    stopButton,
    codeBox,
    element("h3", s.pairJoinHeading, "setting-heading"),
    element("p", s.pairJoinHint, "setting-hint"),
    findButton,
    nearby,
    labelled(s.pairAddressLabel, address),
    labelled(s.pairCodeLabel, code),
    joinButton,
    message,
    element("h3", s.activityHeading, "setting-heading"),
    activity,
    element("h3", s.netHeading, "setting-heading"),
    ...[s.netUpdates, s.netAnnounce, s.netSync, s.netNothing].map((line) => element("p", line, "setting-hint net-statement")),
  ];
}
