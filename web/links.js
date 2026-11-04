// Turns what the user typed into a link address, or refuses it.
//
// Only web and mail addresses are accepted. Anything else with a scheme (javascript:, data:,
// file: and so on) is refused, because a link in a note can be opened by a later click.

/** Returns the address to store, or null when the text is not an acceptable link. */
export function normalizeUrl(input) {
  const text = String(input || "").trim();
  if (!text || /\s/.test(text) || text.length > 2000) return null;
  if (/^(https?|mailto):/i.test(text)) return text;
  // "example.local:8080" looks like a scheme but is a host with a port.
  if (/^[^/:]+:\d+(\/|$)/.test(text)) return `https://${text}`;
  if (/^[a-z][a-z0-9+.-]*:/i.test(text)) return null;
  if (/^(\/|#|\.\/|\.\.\/)/.test(text)) return text;
  return `https://${text}`;
}
