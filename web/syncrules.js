// Small pure helpers for the sync screens (kept apart from the screens so they can be tested
// without the app): the sentence of the status line, the summary of a preview and of a report.

function fill(template, values) {
  return template.replace(/\{(\w+)\}/g, (_, key) => String(values[key] ?? ""));
}

/**
 * The text for the always-visible status line, or "" when there is nothing to say (sync is off
 * or no device is paired). `lines` are the sentences from the language file (strings.syncLine).
 */
export function statusLineText(status, lines) {
  if (!status || status.problem || !status.enabled || status.peers.length === 0) return "";
  if (status.paused) return lines.paused;
  if (status.syncing) {
    const { name, done, total } = status.syncing;
    return total > 0 ? fill(lines.syncingOf, { name, done, total }) : fill(lines.syncing, { name });
  }
  const newest = status.events.find((e) => e.kind === "synced" || e.kind === "syncFailed");
  if (!newest) return lines.never;
  if (newest.kind === "syncFailed") return lines.failed;
  return newest.changed > 0 ? fill(lines.synced, { n: newest.changed }) : lines.syncedNone;
}

/** How many files a preview or a report would touch on either side (0 means nothing to do). */
export function previewTotal(preview) {
  return preview.send + preview.receive + preview.deleteHere + preview.deleteThere + preview.conflicts;
}

/** The sentences that summarise a preview, one per kind that is not zero. */
export function previewLines(preview, name, text) {
  const out = [];
  const add = (count, template) => {
    if (count > 0) out.push(fill(template, { n: count, name }));
  };
  add(preview.send, text.previewSend);
  add(preview.receive, text.previewReceive);
  add(preview.deleteHere, text.previewDeleteHere);
  add(preview.deleteThere, text.previewDeleteThere);
  add(preview.conflicts, text.previewConflicts);
  add(preview.clashes, text.previewClashes);
  add(preview.tooBig.length, text.previewTooBig);
  add(preview.skippedHere + preview.skippedThere, text.previewSkipped);
  return out;
}

/** The words next to one file in the preview list. */
export function actionLabel(action, text) {
  return { send: text.actionSend, receive: text.actionReceive, deleteHere: text.actionDeleteHere, deleteThere: text.actionDeleteThere, conflict: text.actionConflict }[action] || action;
}

/** The sentence after a sync finished. */
export function reportLine(report, name, text) {
  const changed = report.sent + report.received + report.deletedHere + report.deletedThere + report.conflicts + (report.folders || 0);
  if (changed === 0 && report.leftForNext === 0) return fill(text.reportNone, { name });
  const line = fill(text.reportDone, { name, n: changed });
  return report.leftForNext > 0 ? `${line} ${fill(text.reportLeft, { n: report.leftForNext })}` : line;
}

/** Whether two page lists (from the backend) are the same, so an unchanged list is not redrawn. */
export function sameEntries(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].path !== b[i].path || a[i].kind !== b[i].kind) return false;
  }
  return true;
}

/**
 * Decides what to do with the open page when files changed on disk. `onDisk` is the version of
 * the file now, `shown` the version the editor started from, `busy` whether anything of the page
 * is unsaved or being saved. Returns "keep" (nothing to do), "reload" (show the new text) or
 * "wait" (the person is typing; the save will notice, as it always has).
 */
export function pageAction({ onDisk, shown, busy }) {
  if (onDisk === shown) return "keep";
  return busy ? "wait" : "reload";
}

/**
 * Decides what to do with the ink over the open page when files changed on disk. The ink lives in
 * the page's drawing file, so a sync can change it while the text stays the same. `onDisk` is the
 * version of the drawing file now (null when there is none), `shown` the version the ink on screen
 * came from, `loaded` whether a drawing is in memory for this page, `busy` whether ink is being
 * drawn or saved. Returns "keep", "load" (read the drawing and show its ink) or "wait" (the save
 * will notice the change, as it does for the canvas).
 */
export function inkAction({ onDisk, shown, loaded, busy }) {
  if (busy) return "wait";
  if (loaded && onDisk === shown) return "keep";
  return "load";
}
