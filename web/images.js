// Getting a picture from a pasted, dropped or chosen file into the vault.
//
// The checks here only give a quick, friendly answer before anything is sent. The Rust side
// checks the real file content again and is the one that decides.

import { backend } from "./backend.js";

export const MAX_PICTURE_BYTES = 10 * 1024 * 1024;
const ALLOWED = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp" };
export const PICTURE_ACCEPT = Object.values(ALLOWED).filter((v, i, all) => all.indexOf(v) === i).join(",");

/** The file name's extension in lower case, or "". */
function extensionOf(name) {
  const dot = String(name || "").lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

/**
 * Returns null when a file may be tried, or an error code from the language file.
 * `file` only needs `name`, `type` and `size`.
 */
export function checkPicture(file) {
  const byType = Object.values(ALLOWED).includes(String(file.type || "").toLowerCase());
  const byName = extensionOf(file.name) in ALLOWED;
  // SVG is never accepted, whatever its name or type says.
  if (/svg/i.test(file.type || "") || extensionOf(file.name) === "svg") return "unsupported_type";
  if (!byType && !byName) return "unsupported_type";
  if (file.size > MAX_PICTURE_BYTES) return "too_large_picture";
  if (file.size === 0) return "unsupported_type";
  return null;
}

function readAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("read failed"));
    reader.onload = () => {
      const text = String(reader.result || "");
      const comma = text.indexOf(",");
      resolve(comma === -1 ? "" : text.slice(comma + 1));
    };
    reader.readAsDataURL(file);
  });
}

/** Stores a picture file in the vault. Resolves to the path, or throws an error with a `code`. */
export async function storePicture(file) {
  const problem = checkPicture(file);
  if (problem) throw Object.assign(new Error(problem), { code: problem });
  return backend.saveAttachment(file.name || "image", await readAsBase64(file));
}

/** Opens the system's file chooser and resolves to the chosen file, or null. */
export function choosePicture() {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = PICTURE_ACCEPT;
    input.hidden = true;
    input.addEventListener("change", () => {
      resolve(input.files && input.files[0] ? input.files[0] : null);
      input.remove();
    });
    input.addEventListener("cancel", () => {
      resolve(null);
      input.remove();
    });
    document.body.append(input);
    input.click();
  });
}

/** A path as written in markdown, with %20 style escapes turned back into characters. */
export function pathForVault(path) {
  try {
    return decodeURI(path);
  } catch {
    return path;
  }
}
