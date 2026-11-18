// The app lock in the window: the lock screen, locking after a time away, and its settings.
//
// The rules (the PIN or passcode, its hash, the waits after wrong tries) are in Rust
// (core/src/applock.rs, src/lock.rs). While locked, Rust refuses every command that reads or
// writes pages, so this screen is not the only thing standing in the way. Off unless turned on.

import { backend, BackendError } from "./backend.js";
import { strings } from "./strings.js";

/** Minutes away (no typing, tapping or clicking) before the lock closes again. 0: as soon as the app is left. */
export const LOCK_AFTER = [0, 1, 5, 15, 60];
export const DEFAULT_LOCK_AFTER = 5;
export const cleanLockAfter = (value) => (LOCK_AFTER.includes(value) ? value : DEFAULT_LOCK_AFTER);

const fill = (text, values) => text.replace(/\{(\w+)\}/g, (_, key) => String(values[key] ?? ""));

function make(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function codeOf(error) {
  return error instanceof BackendError ? error.code : "unknown";
}

function lockError(error) {
  const t = strings.lock.errors;
  return t[codeOf(error)] || strings.errors[codeOf(error)] || strings.errors.unknown;
}

// A field for a PIN or passcode. A PIN gets the number pad on a phone.
function secretInput(kind, label) {
  const input = make("input", "lock-input");
  input.type = "password";
  input.autocomplete = "off";
  input.spellcheck = false;
  input.maxLength = 64;
  input.setAttribute("aria-label", label);
  input.placeholder = label;
  setKind(input, kind);
  return input;
}

function setKind(input, kind) {
  input.inputMode = kind === "pin" ? "numeric" : "text";
  input.pattern = kind === "pin" ? "[0-9]*" : "";
}

/**
 * Shows the lock screen until the app is unlocked. `status` is what lock_status said.
 * Resolves when unlocked. The screen is a modal dialog with a solid backdrop, so nothing of the
 * app shows through, and Esc cannot close it.
 */
export function showLockScreen(status) {
  const t = strings.lock;
  const dialog = make("dialog", "lock-screen");
  dialog.id = "lockScreen";
  dialog.setAttribute("aria-label", t.screenLabel);
  const form = make("form", "lock-form");
  const logo = make("img", "logo lock-logo");
  logo.src = "logo.png";
  logo.alt = "";
  const title = make("h1", "lock-title", t.title);
  const input = secretInput(status.kind, status.kind === "pin" ? t.enterPin : t.enterPasscode);
  input.id = "lockInput";
  const unlock = make("button", "primary", t.unlock);
  unlock.type = "submit";
  unlock.id = "lockUnlock";
  const message = make("p", "lock-message");
  message.id = "lockMessage";
  message.setAttribute("role", "status");
  form.append(logo, title, input, unlock, message);
  let fingerprint = null;
  if (status.biometric && status.biometricAvailable) {
    fingerprint = make("button", "lock-biometric", t.useBiometric);
    fingerprint.type = "button";
    fingerprint.id = "lockBiometric";
    form.append(fingerprint);
  }
  dialog.append(form);
  document.body.append(dialog);
  document.body.classList.add("is-locked");
  dialog.addEventListener("cancel", (event) => event.preventDefault());

  return new Promise((resolve) => {
    let waitTimer = 0;
    const done = () => {
      clearInterval(waitTimer);
      document.body.classList.remove("is-locked");
      dialog.close();
      dialog.remove();
      resolve();
    };
    // While a wait runs, the button counts down and cannot be pressed.
    const waitFor = (seconds) => {
      let left = seconds;
      unlock.disabled = true;
      const tick = () => {
        if (left <= 0) {
          clearInterval(waitTimer);
          unlock.disabled = false;
          message.textContent = t.tryAgain;
          return;
        }
        message.textContent = fill(t.wait, { seconds: left });
        left--;
      };
      tick();
      waitTimer = setInterval(tick, 1000);
    };
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      if (unlock.disabled || !input.value) return;
      unlock.disabled = true;
      const secret = input.value;
      input.value = "";
      try {
        const reply = await backend.lockUnlock(secret);
        if (reply.ok) return done();
        if (reply.wait > 0) return waitFor(reply.wait);
        message.textContent = t.wrong;
        unlock.disabled = false;
      } catch (error) {
        message.textContent = lockError(error);
        unlock.disabled = false;
      }
      input.focus();
    });
    if (fingerprint) {
      fingerprint.addEventListener("click", async () => {
        try {
          if (await backend.lockBiometricUnlock(t.biometricTitle)) return done();
          message.textContent = t.biometricFailed;
        } catch (error) {
          message.textContent = lockError(error);
        }
      });
    }
    dialog.showModal();
    input.focus();
  });
}

/**
 * Closes the lock after the chosen time away. `minutes()` gives the setting, `beforeLock()`
 * saves the open page first, `onLocked(status)` shows the lock screen and resolves when open
 * again. Returns `{ touch() }` for tests.
 */
export function watchForLock({ minutes, beforeLock, onLocked }) {
  let lastActive = Date.now();
  let busy = false;
  const touch = () => {
    lastActive = Date.now();
  };
  for (const type of ["pointerdown", "keydown", "wheel", "touchstart"]) window.addEventListener(type, touch, { capture: true, passive: true });

  async function lockIfDue(leaving) {
    if (busy || document.getElementById("lockScreen")) return;
    const after = minutes();
    const due = leaving ? after === 0 : Date.now() - lastActive >= Math.max(after, 0.001) * 60_000;
    if (!due) return;
    busy = true;
    try {
      const status = await backend.lockStatus();
      if (!status.enabled) return;
      await beforeLock();
      if (!(await backend.lockNow())) return;
      await onLocked({ ...status, locked: true });
      touch();
    } catch {
      // Without an answer from Rust nothing is locked or unlocked; the next check tries again.
    } finally {
      busy = false;
    }
  }
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") void lockIfDue(true);
    else void lockIfDue(false);
  });
  setInterval(() => void lockIfDue(false), 15_000);
  return { touch, check: () => lockIfDue(false) };
}

/**
 * The rows for Settings > This device. `settings()` and `save(patch)` read and change the
 * app settings (only the time away is kept there; the lock itself is in Rust).
 */
export function lockSettingsRows({ settings, save }) {
  const t = strings.lock;
  const box = make("div", "lock-settings");
  box.id = "lockSettings";
  const heading = make("h3", "setting-heading", t.heading);
  const hint = make("p", "setting-hint", t.hint);
  const body = make("div", "lock-settings-body");
  const result = make("p", "setting-hint");
  result.id = "lockResult";
  result.setAttribute("role", "status");
  box.append(heading, hint, body, result);

  async function paint() {
    let status;
    try {
      status = await backend.lockStatus();
    } catch (error) {
      body.replaceChildren(make("p", "setting-hint", lockError(error)));
      return;
    }
    body.replaceChildren(...(status.enabled ? onRows(status) : offRows()));
  }

  // A small form: the fields, then Save and Cancel. `submit(values)` does the work.
  function form(fields, saveText, submit) {
    const wrap = make("form", "lock-form-inline");
    const buttons = make("div", "lock-form-buttons");
    const ok = make("button", "primary", saveText);
    ok.type = "submit";
    const cancel = make("button", "", t.cancel);
    cancel.type = "button";
    cancel.addEventListener("click", paint);
    buttons.append(ok, cancel);
    wrap.append(...fields, buttons);
    wrap.addEventListener("submit", async (event) => {
      event.preventDefault();
      ok.disabled = true;
      try {
        if (await submit()) {
          await paint();
        }
      } catch (error) {
        result.textContent = lockError(error);
      } finally {
        ok.disabled = false;
      }
    });
    return wrap;
  }

  // Choosing PIN or passcode, then typing it twice.
  function newSecretFields() {
    const kind = make("select");
    kind.id = "lockKind";
    for (const value of ["pin", "passcode"]) {
      const option = make("option", "", t.kinds[value]);
      option.value = value;
      kind.append(option);
    }
    const first = secretInput("pin", t.newSecret);
    first.id = "lockNew";
    const again = secretInput("pin", t.repeatSecret);
    again.id = "lockRepeat";
    kind.addEventListener("change", () => {
      setKind(first, kind.value);
      setKind(again, kind.value);
    });
    const row = make("label", "setting-row");
    row.append(make("span", "setting-label", t.kind), kind);
    return { kind, first, again, rows: [row, first, again] };
  }

  function checkRepeat(fields) {
    if (fields.first.value !== fields.again.value) {
      result.textContent = t.notSame;
      return false;
    }
    return true;
  }

  function offRows() {
    const turnOn = make("button", "", t.turnOn);
    turnOn.id = "lockTurnOn";
    turnOn.addEventListener("click", () => {
      result.textContent = "";
      const fields = newSecretFields();
      const warning = make("p", "setting-hint lock-warning", t.forgetWarning);
      body.replaceChildren(
        form([...fields.rows, warning], t.save, async () => {
          if (!checkRepeat(fields)) return false;
          await backend.lockSet(fields.kind.value, fields.first.value, null);
          result.textContent = t.turnedOn;
          return true;
        }),
      );
      fields.first.focus();
    });
    return [turnOn];
  }

  function onRows(status) {
    const after = make("select");
    after.id = "lockAfter";
    for (const value of LOCK_AFTER) {
      const option = make("option", "", t.afterOptions[value]);
      option.value = String(value);
      after.append(option);
    }
    after.value = String(cleanLockAfter(settings().lockAfter));
    after.addEventListener("change", () => save({ lockAfter: Number(after.value) }));
    const afterRow = make("label", "setting-row");
    afterRow.append(make("span", "setting-label", t.after), after);
    const rows = [make("p", "setting-hint", fill(t.isOn, { kind: t.kinds[status.kind] })), afterRow];

    if (status.biometricAvailable) {
      const bio = make("input");
      bio.type = "checkbox";
      bio.id = "lockBiometricSetting";
      bio.checked = status.biometric;
      bio.addEventListener("change", async () => {
        try {
          await backend.lockSetBiometric(bio.checked);
        } catch (error) {
          bio.checked = !bio.checked;
          result.textContent = lockError(error);
        }
      });
      const bioRow = make("label", "setting-row");
      bioRow.append(make("span", "setting-label", t.biometric), bio);
      rows.push(bioRow);
    }

    const change = make("button", "", t.change);
    change.id = "lockChange";
    change.addEventListener("click", () => {
      result.textContent = "";
      const current = secretInput(status.kind, t.currentSecret);
      current.id = "lockCurrent";
      const fields = newSecretFields();
      body.replaceChildren(
        form([current, ...fields.rows], t.save, async () => {
          if (!checkRepeat(fields)) return false;
          await backend.lockSet(fields.kind.value, fields.first.value, current.value);
          result.textContent = t.changed;
          return true;
        }),
      );
      current.focus();
    });
    const off = make("button", "", t.turnOff);
    off.id = "lockTurnOff";
    off.addEventListener("click", () => {
      result.textContent = "";
      const current = secretInput(status.kind, t.currentSecret);
      current.id = "lockCurrent";
      body.replaceChildren(
        form([current], t.turnOffConfirm, async () => {
          await backend.lockRemove(current.value);
          result.textContent = t.turnedOff;
          return true;
        }),
      );
      current.focus();
    });
    rows.push(change, off);
    return rows;
  }

  void paint();
  return box;
}
