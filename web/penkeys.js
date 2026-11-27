// Pen buttons that arrive as keys (0.6.8).
//
// Some tablet pens do not send the usual "side button held" signal with the pen. Their buttons
// send a key instead when tapped with the pen away from the screen: Page Down for one button and
// Page Up for the other (the Pen test shows which). Holding them while touching the screen is
// often kept by the tablet's system for its own shortcuts, so a tap is all an app gets.
//
// Each key can be given a job while drawing. Outside drawing, and while typing in a field, the
// keys keep their normal job (scrolling), so a real keyboard's Page Up and Page Down still work.

/** The jobs a pen key can have. "eraser" switches between the eraser and the tool before it. */
export const PEN_KEY_ACTIONS = ["none", "eraser", "undo", "redo"];

/** The setting names, by key. */
export const PEN_KEY_SETTINGS = { PageDown: "penKeyDown", PageUp: "penKeyUp" };

/** A setting value that is one of the jobs, or "none". */
export function cleanPenKey(value) {
  return PEN_KEY_ACTIONS.includes(value) ? value : "none";
}

/**
 * The job for a key press while drawing, or null when the press keeps its normal job: another
 * key, a key held with Ctrl, Alt, Shift or Meta, a key held down (repeats), a press in a text
 * field, or a key with no job set.
 */
export function penKeyAction(event, settings) {
  const name = PEN_KEY_SETTINGS[event.key];
  if (!name || event.ctrlKey || event.altKey || event.shiftKey || event.metaKey || event.repeat) return null;
  if (event.inTextField) return null;
  const action = cleanPenKey(settings[name]);
  return action === "none" ? null : action;
}

/** The tool after the eraser job: the eraser, or back to the tool before it (the pen if none). */
export function toggledTool(current, before) {
  if (current !== "eraser") return "eraser";
  return before && before !== "eraser" ? before : "pen";
}
