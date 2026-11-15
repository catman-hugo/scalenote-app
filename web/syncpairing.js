// The pairing part of the Sync tab: this device's fingerprint, the paired devices, showing a
// code for another device to enter, entering a code from another device, and the activity list.
//
// While a code is shown the screen asks Rust for the state once a second, so the countdown and
// "paired" show up without a button. When the Settings window closes, the code is stopped at
// once so the device does not keep listening for pairings nobody can see.

import { BackendError, backend } from "./backend.js";
import { groupCode, timeLeftText } from "./syncpairrules.js";
import { strings } from "./strings.js";

const POLL_MS = 1000;

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
  const template = { paired: s.activityPaired, refused: s.activityRefused, removed: s.activityRemoved }[event.kind];
  return fill(template || "{when}", { when: event.when.replace("T", " ").replace("Z", " UTC"), name: event.name });
}

/** Returns the rows to append to the Sync tab. `isOn()` says whether the switch is on. */
export function pairingRows(logProblem) {
  const s = strings.settings;
  const message = element("p", "", "setting-hint");
  message.id = "pairMessage";
  message.setAttribute("role", "status");

  const fingerprint = element("p", "", "setting-hint");
  fingerprint.id = "pairFingerprint";
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
  const leftText = element("p", "", "setting-hint");
  leftText.id = "pairLeft";
  codeBox.append(element("p", s.pairShow, "setting-hint"), codeText, addressText, leftText);

  let pairing = false;
  let knownPeers = null;
  let timer = null;
  let removing = null;

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
      const item = element("li", "", "pair-item");
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
      item.append(text, remove);
      list.append(item);
    }
  }

  function showStatus(status) {
    fingerprint.textContent = `${s.pairThisDevice}: ${status.fingerprint}`;
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
    list,
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
  ];
}
