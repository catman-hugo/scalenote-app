// Small pure helpers for the pairing screen (kept apart so they can be tested without the app).

// "12345678" is shown as "1234 5678": easier to read out and to copy by eye.
export function groupCode(code) {
  return code.length === 8 ? `${code.slice(0, 4)} ${code.slice(4)}` : code;
}

export function timeLeftText(seconds) {
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, "0")}`;
}

