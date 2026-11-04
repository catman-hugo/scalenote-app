// Saves after the user stops typing, and always before leaving the note or closing.
//
// Why a short delay: saving on every key press would rewrite the file hundreds of times.
// Why not longer: whatever is typed in the last moments before the window closes is the
// only text at risk, so the delay stays under a second.

export class Autosave {
  constructor({ delayMs, save, onStatus }) {
    this.delayMs = delayMs;
    this.save = save;
    this.onStatus = onStatus;
    this.timer = null;
    this.running = null;
    this.pending = false;
  }

  // Called after every edit.
  touch() {
    this.pending = true;
    this.onStatus("unsaved");
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), this.delayMs);
  }

  // Saves right now if there is anything unsaved. Safe to call many times at once.
  async flush() {
    clearTimeout(this.timer);
    this.timer = null;
    if (this.running) await this.running;
    if (!this.pending) return;
    this.pending = false;
    this.onStatus("saving");
    this.running = (async () => {
      try {
        await this.save();
        // New edits may have arrived while saving; they have their own timer.
        if (!this.pending) this.onStatus("saved");
      } catch {
        // The text is still on screen. Try again soon rather than giving up.
        this.pending = true;
        this.onStatus("failed");
        this.timer = setTimeout(() => this.flush(), 3000);
      }
    })();
    await this.running;
    this.running = null;
  }

  // Drops anything waiting, for when the note on screen is being replaced.
  cancel() {
    clearTimeout(this.timer);
    this.timer = null;
    this.pending = false;
  }
}
