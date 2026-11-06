// The rules for #tags, in the form Obsidian uses: a "#" at the start of a line or after a space,
// then letters, digits, "_", "-" and "/" (a slash makes a nested tag, "school/maths"), with at
// least one character that is not a digit, so "#1984" is a number and not a tag.
//
// These are written a second time in src-tauri/core/src/tags.rs (the list of all tags). Both are
// tested against tests/fixtures/tags.txt so they cannot drift apart. This file has no editor
// code in it, so the tests can load it on their own.

import { readLinkAt } from "./wikilinkrules.js";

export const MAX_TAG_CHARS = 100;
export const MAX_TAGS = 5000;

const TAG_CHAR = /^[\p{Alphabetic}\p{N}_\-/]$/u;
const NUMBER = /^\p{N}$/u;
const SPACE = /^\p{White_Space}$/u;

/** True when `name` (written without the "#") is a tag name. */
export function isTagName(name) {
  const letters = Array.from(name);
  return letters.length >= 1 && letters.length <= MAX_TAG_CHARS && letters.every((l) => TAG_CHAR.test(l)) && letters.some((l) => !NUMBER.test(l));
}

// A run of backticks closed by a run of the same length is a code span; an unclosed run is text.
function skipCodeSpan(line, from) {
  let run = 0;
  while (line[from + run] === "`") run++;
  let i = from + run;
  while (i < line.length) {
    if (line[i] === "`") {
      let closing = 0;
      while (line[i + closing] === "`") closing++;
      if (closing === run) return i + closing;
      i += closing;
    } else i++;
  }
  return from + run;
}

// Reads the tag name that starts right after the "#" at `at`. Returns the end of the name, or -1
// when it is not a tag. Reads at most one letter past the longest name, so a very long run of
// letters is not read again and again.
function tagEnd(line, at) {
  let i = at + 1;
  let count = 0;
  let allNumbers = true;
  while (i < line.length && count <= MAX_TAG_CHARS) {
    const letter = String.fromCodePoint(line.codePointAt(i));
    if (!TAG_CHAR.test(letter)) break;
    count++;
    if (!NUMBER.test(letter)) allNumbers = false;
    i += letter.length;
  }
  return count >= 1 && count <= MAX_TAG_CHARS && !allNumbers ? i : -1;
}

function scanLine(line, offset, tags) {
  let i = 0;
  while (i < line.length && tags.length < MAX_TAGS) {
    const letter = line[i];
    if (letter === "\\") i += 2; // an escaped letter is text
    else if (letter === "`") i = skipCodeSpan(line, i);
    else if (letter === "[" && line[i + 1] === "[") {
      const link = readLinkAt(line, i);
      i = link ? link.end : i + 1; // a "#" inside a link is the link's heading, not a tag
    } else if (letter === "#") {
      // Every space character is a single UTF-16 unit, so the unit before the "#" is enough.
      const end = i === 0 || SPACE.test(line[i - 1]) ? tagEnd(line, i) : -1;
      if (end === -1) {
        i++;
      } else {
        tags.push({ name: line.slice(i + 1, end), start: offset + i, end: offset + end });
        i = end;
      }
    } else i++;
  }
}

/**
 * All tags in a text, in order, with their positions. Tags in fenced code and in code spans are
 * not tags, and neither is the "#" of a link's heading ("[[Page#Heading]]").
 */
export function findTags(text) {
  const tags = [];
  let fence = null;
  let offset = 0;
  while (offset < text.length && tags.length < MAX_TAGS) {
    const newline = text.indexOf("\n", offset);
    const line = text.slice(offset, newline === -1 ? text.length : newline + 1);
    const indent = line.length - line.replace(/^ +/, "").length;
    const rest = line.slice(indent);
    const marker = indent > 3 ? null : rest.startsWith("```") ? "`" : rest.startsWith("~~~") ? "~" : null;
    if (fence === null && marker) fence = marker;
    else if (fence !== null && marker === fence) fence = null;
    else if (fence === null) scanLine(line, offset, tags);
    offset += line.length;
  }
  return tags;
}

/**
 * The text with every tag replaced by a letter. blocks.js checks what is left for syntax the
 * editor cannot keep, and a tag is not one of those.
 */
export function withoutTags(text) {
  if (!text.includes("#")) return text;
  let out = "";
  let at = 0;
  for (const tag of findTags(text)) {
    out += `${text.slice(at, tag.start)}x`;
    at = tag.end;
  }
  return out + text.slice(at);
}

/** True when the text has at least one tag. */
export function hasTags(text) {
  return text.includes("#") && findTags(text).length > 0;
}

/** The tags of a text as plain strings, to compare before and after the editor rewrote a block. */
export function tagSignature(text) {
  return findTags(text).map((tag) => tag.name);
}

export function sameTags(a, b) {
  const x = tagSignature(a);
  const y = tagSignature(b);
  return x.length === y.length && x.every((item, i) => item === y[i]);
}
