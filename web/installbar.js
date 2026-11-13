// The progress bar for downloading an update, shown in the update notice and in Settings. While a
// download runs the Download buttons are switched off, so pressing them again does nothing.
// States: null (nothing), "downloading" (with the bytes so far and in all, 0 when not known),
// "ready" (downloaded, Android's installer is open) and "browser" (the browser has the download).
import { strings } from "./strings.js";

let state = null;

export const isInstallBusy = () => state !== null && (state.kind === "downloading" || state.kind === "browser");

const mb = (bytes) => {
  const value = bytes / 1048576;
  return String(value >= 10 ? Math.round(value) : Math.round(value * 10) / 10);
};

const fill = (text, values) => text.replace(/\{(\w+)\}/g, (_, key) => String(values[key]));

/** The words under the bar for a state. */
export function installText(current) {
  const s = strings.update;
  if (!current) return "";
  if (current.kind === "ready") return s.installReady;
  if (current.kind === "browser") return s.installOpened;
  if (!current.done) return s.installStarting;
  if (current.total > 0) {
    const percent = Math.min(100, Math.floor((current.done / current.total) * 100));
    return fill(s.installProgress, { done: mb(current.done), total: mb(current.total), percent });
  }
  return fill(s.installProgressUnknown, { done: mb(current.done) });
}

const fraction = (current) => {
  if (!current) return 0;
  if (current.kind === "ready") return 1;
  if (current.kind === "downloading" && current.total > 0) return Math.min(1, current.done / current.total);
  return 0;
};

function paintBar(bar) {
  bar.hidden = state === null;
  if (state === null) return;
  const showsBar = state.kind === "ready" || (state.kind === "downloading" && state.total > 0);
  const track = bar.querySelector(".install-bar-track");
  track.hidden = !showsBar;
  const percent = Math.round(fraction(state) * 100);
  track.querySelector(".install-bar-fill").style.width = percent + "%";
  track.setAttribute("aria-valuenow", String(percent));
  bar.querySelector(".install-bar-text").textContent = installText(state);
}

/** A new bar, already showing the current state. Several can exist (notice and Settings). */
export function createInstallBar() {
  const bar = document.createElement("div");
  bar.className = "install-bar";
  const track = document.createElement("div");
  track.className = "install-bar-track";
  track.setAttribute("role", "progressbar");
  track.setAttribute("aria-label", strings.update.installBarLabel);
  track.setAttribute("aria-valuemin", "0");
  track.setAttribute("aria-valuemax", "100");
  const fillPart = document.createElement("div");
  fillPart.className = "install-bar-fill";
  track.append(fillPart);
  const text = document.createElement("p");
  text.className = "install-bar-text";
  text.setAttribute("role", "status");
  bar.append(track, text);
  paintBar(bar);
  return bar;
}

/** Download buttons carry `data-install-button`; they are off while a download runs. */
export function paintInstallButton(button) {
  button.setAttribute("data-install-button", "");
  button.disabled = isInstallBusy();
}

export function setInstallState(next) {
  state = next;
  for (const bar of document.querySelectorAll(".install-bar")) paintBar(bar);
  for (const button of document.querySelectorAll("[data-install-button]")) button.disabled = isInstallBusy();
}
