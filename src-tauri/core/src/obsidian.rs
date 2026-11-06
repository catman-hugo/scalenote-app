//! A copy of the vault that other programs, Obsidian in particular, show without odd markup.
//!
//! ScaleNote keeps text and background colours in the note as small html spans with a class
//! (`<span class="sn-bg-yellow">`). Other programs do not know those classes, so in the copy a
//! background colour becomes a plain `==highlight==` and a text colour is simply removed. The
//! words themselves are never touched, and the original vault is never changed: everything is
//! written into a new folder next to it.
//!
//! The rules for what counts as a ScaleNote colour span are the same as in `web/inlinestyles.js`
//! (a test there reads the colour names from this file, so the two cannot drift apart).

use crate::atomic::write_atomic;
use crate::vault::{Result, Vault, VaultError, MAX_NOTE_BYTES, MAX_TREE_DEPTH, MAX_TREE_ENTRIES};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};

/// The colour names ScaleNote writes. Order does not matter here.
pub const COLOUR_NAMES: [&str; 9] =
    ["gray", "brown", "orange", "yellow", "green", "blue", "purple", "pink", "red"];

/// Files bigger than this are not copied (and are counted in `skipped`): the copy is for notes
/// and pictures, and a single huge file could fill the disk.
const MAX_COPY_FILE_BYTES: u64 = 256 * 1024 * 1024;
/// How many "name 2", "name 3" ... folders are tried before giving up.
const MAX_NAME_TRIES: usize = 99;

// ---------------------------------------------------------------------------------------------
// Turning one note into its plain version
// ---------------------------------------------------------------------------------------------

/// What an opening `<span ...>` of ours says: does it carry a background colour?
struct OpenTag {
    length: usize,
    background: bool,
}

fn is_colour_name(name: &str) -> bool {
    COLOUR_NAMES.contains(&name)
}

/// Reads `<span class="sn-text-red sn-bg-yellow">` (one or both classes, nothing else) or the
/// older form `<span style="color: #f72525">` written by 0.2.9. Anything else is not ours.
fn parse_open(s: &str) -> Option<OpenTag> {
    if let Some(rest) = s.strip_prefix("<span class=\"") {
        let end = rest.find("\">")?;
        // A class list is short; refusing long ones keeps a hostile line from costing time.
        if end > 80 {
            return None;
        }
        let (mut text, mut background) = (false, false);
        for class in rest[..end].split_whitespace() {
            if let Some(name) = class.strip_prefix("sn-text-") {
                if !is_colour_name(name) || text {
                    return None;
                }
                text = true;
            } else {
                let name = class.strip_prefix("sn-bg-")?;
                if !is_colour_name(name) || background {
                    return None;
                }
                background = true;
            }
        }
        if !text && !background {
            return None;
        }
        let length = "<span class=\"".len() + end + 2;
        return Some(OpenTag { length, background });
    }
    if let Some(rest) = s.strip_prefix("<span style=\"color:") {
        let hex = rest.trim_start_matches(' ').strip_prefix('#')?;
        let digits = hex.chars().take_while(|c| c.is_ascii_hexdigit()).count();
        if digits != 3 && digits != 6 {
            return None;
        }
        let after = &hex[digits..];
        let after = after.strip_prefix(';').unwrap_or(after);
        let tail = after.strip_prefix("\">")?;
        return Some(OpenTag { length: s.len() - tail.len(), background: false });
    }
    None
}

/// For every `<span` in `s`, the position of the `</span>` that closes it (spans that open in
/// between are counted). One pass over the text, so a line full of unclosed spans costs the
/// same as any other line instead of a search for every one of them.
fn match_spans(s: &str) -> HashMap<usize, usize> {
    let bytes = s.as_bytes();
    let mut open: Vec<usize> = Vec::new();
    let mut pairs = HashMap::new();
    let mut i = 0usize;
    while i < bytes.len() {
        if bytes[i] == b'<' {
            if s[i..].starts_with("</span>") {
                if let Some(start) = open.pop() {
                    pairs.insert(start, i);
                }
                i += "</span>".len();
                continue;
            }
            if s[i..].starts_with("<span") && matches!(bytes.get(i + 5), Some(b' ') | Some(b'>')) {
                open.push(i);
            }
        }
        i += 1;
    }
    pairs
}

/// Puts `==` around `text`, keeping spaces at its edges outside the markers (`== a ==` is not
/// a highlight). Empty or blank text gets no markers.
fn highlight(text: &str) -> String {
    let start_trimmed = text.trim_start();
    let lead = &text[..text.len() - start_trimmed.len()];
    let core = start_trimmed.trim_end();
    let trail = &start_trimmed[core.len()..];
    if core.is_empty() {
        return text.to_string();
    }
    format!("{lead}=={core}=={trail}")
}

/// Styles inside styles go this deep and no deeper; past that the text is left as written.
/// It also keeps a hostile note from nesting the work without end.
const MAX_SPAN_DEPTH: usize = 16;

fn convert_prose(s: &str, inside_highlight: bool, depth: usize) -> String {
    if !s.contains("<span") {
        return if inside_highlight { s.replace("==", "") } else { s.to_string() };
    }
    let bytes = s.as_bytes();
    let mut out = String::with_capacity(s.len());
    let mut i = 0usize;
    let closers = if depth < MAX_SPAN_DEPTH { match_spans(s) } else { HashMap::new() };
    // Backtick run lengths for which no closing run exists later in the text: asking again
    // would only repeat the same search.
    let mut no_closing_run: HashSet<usize> = HashSet::new();
    while i < s.len() {
        let byte = bytes[i];
        if byte == b'`' {
            // A code span is copied as it is: a "span" shown as code must stay as written.
            let run = s[i..].bytes().take_while(|b| *b == b'`').count();
            let ticks = &s[i..i + run];
            let after = i + run;
            let close =
                if no_closing_run.contains(&run) { None } else { find_backtick_run(s, after, run) };
            if close.is_none() {
                no_closing_run.insert(run);
            }
            match close {
                Some(end) => {
                    out.push_str(&s[i..end + run]);
                    i = end + run;
                }
                None => {
                    out.push_str(ticks);
                    i = after;
                }
            }
            continue;
        }
        if byte == b'\\' {
            out.push('\\');
            i += 1;
            if let Some(next) = s[i..].chars().next() {
                out.push(next);
                i += next.len_utf8();
            }
            continue;
        }
        if byte == b'<' {
            if let Some(tag) = parse_open(&s[i..]) {
                let content_start = i + tag.length;
                if let Some(close) = closers.get(&i).copied().filter(|c| *c >= content_start) {
                    let inner = &s[content_start..close];
                    // A style never reaches across paragraphs; if this one seems to, it is
                    // not a style of ours that was written properly, so it is left alone.
                    if !inner.contains("\n\n") {
                        let converted = convert_prose(inner, inside_highlight || tag.background, depth + 1);
                        if tag.background && !inside_highlight {
                            out.push_str(&highlight(&converted));
                        } else {
                            out.push_str(&converted);
                        }
                        i = close + "</span>".len();
                        continue;
                    }
                }
            }
        }
        if inside_highlight && s[i..].starts_with("==") {
            i += 2;
            continue;
        }
        let ch = match s[i..].chars().next() {
            Some(c) => c,
            None => break,
        };
        out.push(ch);
        i += ch.len_utf8();
    }
    out
}

/// Position of the next run of exactly `run` backticks at or after `from`.
fn find_backtick_run(s: &str, from: usize, run: usize) -> Option<usize> {
    let bytes = s.as_bytes();
    let mut i = from;
    while i < bytes.len() {
        if bytes[i] == b'`' {
            let length = s[i..].bytes().take_while(|b| *b == b'`').count();
            if length == run {
                return Some(i);
            }
            i += length;
        } else {
            i += 1;
        }
    }
    None
}

/// The note as other programs should see it. Text without a ScaleNote colour span comes back
/// exactly as it was, byte for byte. Fenced code blocks are never changed.
pub fn to_obsidian(text: &str) -> String {
    if !text.contains("<span") {
        return text.to_string();
    }
    let mut out = String::with_capacity(text.len());
    let mut prose = String::new();
    let mut fence: Option<(char, usize)> = None;
    for line in text.split_inclusive('\n') {
        let trimmed = line.trim_start_matches(' ');
        let marker = trimmed.chars().next().filter(|c| *c == '`' || *c == '~');
        let run = marker.map(|m| trimmed.chars().take_while(|c| *c == m).count()).unwrap_or(0);
        match fence {
            Some((kind, length)) => {
                out.push_str(line);
                // A fence closes with at least as many of the same character and nothing else.
                if marker == Some(kind) && run >= length && trimmed[run..].trim().is_empty() {
                    fence = None;
                }
            }
            None => {
                if let (Some(kind), true) = (marker, run >= 3) {
                    out.push_str(&convert_prose(&prose, false, 0));
                    prose.clear();
                    out.push_str(line);
                    fence = Some((kind, run));
                } else {
                    prose.push_str(line);
                }
            }
        }
    }
    out.push_str(&convert_prose(&prose, false, 0));
    out
}

// ---------------------------------------------------------------------------------------------
// Writing the copy
// ---------------------------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExportReport {
    /// Where the copy is.
    pub path: PathBuf,
    /// Notes written.
    pub notes: usize,
    /// Of those, the notes that had colours to convert.
    pub changed: usize,
    /// Other files (pictures and so on) copied as they are.
    pub files: usize,
    /// Files left out: too big, or not readable.
    pub skipped: usize,
}

struct Counts {
    notes: usize,
    changed: usize,
    files: usize,
    skipped: usize,
    entries: usize,
}

fn is_md(name: &str) -> bool {
    name.len() > 3 && name[name.len() - 3..].eq_ignore_ascii_case(".md")
}

/// Makes a new folder next to the vault and fills it with the converted notes and the other
/// files. Never changes the vault and never replaces anything: if the folder name is taken,
/// the next free "name 2", "name 3" is used. If the copy fails half way, the half-made copy
/// is removed again.
pub fn export_obsidian_copy(vault: &Vault) -> Result<ExportReport> {
    let root = vault.root();
    let parent = root.parent().ok_or(VaultError::InvalidPath)?;
    let base = root
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .filter(|n| !n.is_empty())
        .unwrap_or_else(|| "ScaleNote".to_string());
    let dest = reserve_folder(parent, &format!("{base} (Obsidian copy)"))?;
    let mut counts = Counts { notes: 0, changed: 0, files: 0, skipped: 0, entries: 0 };
    if let Err(error) = copy_dir(root, &dest, 0, &mut counts) {
        // The folder was made by this call and holds only what this call wrote.
        let _ = fs::remove_dir_all(&dest);
        return Err(error);
    }
    Ok(ExportReport {
        path: dest,
        notes: counts.notes,
        changed: counts.changed,
        files: counts.files,
        skipped: counts.skipped,
    })
}

/// `create_dir` fails if the name exists, which makes taking the name and checking it free
/// one single step.
pub(crate) fn reserve_folder(parent: &Path, name: &str) -> Result<PathBuf> {
    for attempt in 1..=MAX_NAME_TRIES {
        let candidate =
            if attempt == 1 { parent.join(name) } else { parent.join(format!("{name} {attempt}")) };
        match fs::create_dir(&candidate) {
            Ok(()) => return Ok(candidate),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(VaultError::from(error)),
        }
    }
    Err(VaultError::AlreadyExists)
}

fn copy_dir(from: &Path, to: &Path, depth: usize, counts: &mut Counts) -> Result<()> {
    if depth >= MAX_TREE_DEPTH {
        counts.skipped += 1;
        return Ok(());
    }
    for entry in fs::read_dir(from)?.flatten() {
        if counts.entries >= MAX_TREE_ENTRIES {
            counts.skipped += 1;
            return Ok(());
        }
        let Ok(file_type) = entry.file_type() else {
            counts.skipped += 1;
            continue;
        };
        let Some(name) = entry.file_name().to_str().map(str::to_owned) else {
            counts.skipped += 1;
            continue;
        };
        // Hidden entries (.obsidian, .git, our own cache and half-written temp files) stay out.
        // Links are not followed, so a loop or a link out of the vault copies nothing.
        if name.starts_with('.') || file_type.is_symlink() {
            continue;
        }
        counts.entries += 1;
        let source = entry.path();
        let target = to.join(&name);
        if file_type.is_dir() {
            fs::create_dir(&target)?;
            copy_dir(&source, &target, depth + 1, counts)?;
        } else if file_type.is_file() {
            copy_file(&source, &target, &name, counts)?;
        }
    }
    Ok(())
}

fn copy_file(source: &Path, target: &Path, name: &str, counts: &mut Counts) -> Result<()> {
    let size = match fs::metadata(source) {
        Ok(meta) => meta.len(),
        Err(_) => {
            counts.skipped += 1;
            return Ok(());
        }
    };
    if size > MAX_COPY_FILE_BYTES {
        counts.skipped += 1;
        return Ok(());
    }
    let bytes = match fs::read(source) {
        Ok(bytes) => bytes,
        Err(_) => {
            counts.skipped += 1;
            return Ok(());
        }
    };
    if is_md(name) {
        counts.notes += 1;
        // A note that is too big or is not text is copied untouched rather than risked.
        let converted = if size <= MAX_NOTE_BYTES { std::str::from_utf8(&bytes).ok().map(to_obsidian) } else { None };
        match converted {
            Some(text) if text.as_bytes() != bytes.as_slice() => {
                counts.changed += 1;
                write_atomic(target, text.as_bytes())?;
            }
            _ => write_atomic(target, &bytes)?,
        }
    } else {
        counts.files += 1;
        write_atomic(target, &bytes)?;
    }
    Ok(())
}

/// A path as a person should read it. On Windows the vault path can come back in the long
/// "\\?\C:\..." form, which is correct for the system but odd to show; the prefix is dropped
/// for drive paths. Other paths (including network shares) are shown unchanged.
pub fn friendly_path(path: &Path) -> String {
    let text = path.to_string_lossy().into_owned();
    match text.strip_prefix("\\\\?\\") {
        Some(rest) if rest.len() > 2 && rest.as_bytes()[1] == b':' => rest.to_string(),
        _ => text,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("sn-obsidian-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).expect("make temp dir");
        dir
    }

    #[test]
    fn a_background_becomes_a_highlight_and_a_text_colour_is_removed() {
        assert_eq!(
            to_obsidian("a <span class=\"sn-bg-yellow\">marked</span> b <span class=\"sn-text-red\">red</span> c"),
            "a ==marked== b red c"
        );
    }

    #[test]
    fn one_span_with_both_classes_keeps_only_the_highlight() {
        assert_eq!(to_obsidian("<span class=\"sn-text-blue sn-bg-pink\">both</span>"), "==both==");
    }

    #[test]
    fn spans_inside_each_other_are_handled() {
        assert_eq!(
            to_obsidian("<span class=\"sn-bg-green\">a <span class=\"sn-text-red\">b</span> c</span>"),
            "==a b c=="
        );
        assert_eq!(
            to_obsidian("<span class=\"sn-text-red\">a <span class=\"sn-bg-green\">b</span> c</span>"),
            "a ==b== c"
        );
        // A highlight inside a background does not double the markers.
        assert_eq!(
            to_obsidian("<span class=\"sn-bg-green\">a <span class=\"sn-bg-red\">b</span> ==c==</span>"),
            "==a b c=="
        );
    }

    #[test]
    fn spaces_stay_outside_the_markers() {
        assert_eq!(to_obsidian("x<span class=\"sn-bg-gray\"> pad </span>y"), "x ==pad== y");
        assert_eq!(to_obsidian("x<span class=\"sn-bg-gray\"> </span>y"), "x y");
    }

    #[test]
    fn the_old_colour_form_from_0_2_9_is_removed_too() {
        assert_eq!(to_obsidian("<span style=\"color: #f72525\">red</span>"), "red");
        assert_eq!(to_obsidian("<span style=\"color:#F72525;\">red</span>"), "red");
        assert_eq!(to_obsidian("<span style=\"color: #fff\">w</span>"), "w");
    }

    #[test]
    fn spans_that_are_not_ours_are_left_alone() {
        for text in [
            "<span class=\"other\">x</span>",
            "<span class=\"sn-text-chartreuse\">x</span>",
            "<span class=\"sn-text-red sn-text-blue\">x</span>",
            "<span class=\"sn-bg-red extra\">x</span>",
            "<span style=\"color: red\">x</span>",
            "<span style=\"color: #12\">x</span>",
            "<span class=\"sn-bg-red\" onclick=\"x()\">x</span>",
            "<span class=\"\">x</span>",
        ] {
            assert_eq!(to_obsidian(text), text, "{text}");
        }
    }

    #[test]
    fn broken_or_split_spans_are_left_alone() {
        let unclosed = "<span class=\"sn-bg-red\">never closed";
        assert_eq!(to_obsidian(unclosed), unclosed);
        let split = "<span class=\"sn-bg-red\">one\n\ntwo</span>";
        assert_eq!(to_obsidian(split), split);
    }

    #[test]
    fn code_is_never_changed() {
        let inline = "see `<span class=\"sn-bg-red\">x</span>` here";
        assert_eq!(to_obsidian(inline), inline);
        let fenced = "```html\n<span class=\"sn-bg-red\">x</span>\n```\n";
        assert_eq!(to_obsidian(fenced), fenced);
        let tilde = "~~~\n<span class=\"sn-text-red\">x</span>\n~~~\n";
        assert_eq!(to_obsidian(tilde), tilde);
        // Text after a fence is converted again.
        assert_eq!(
            to_obsidian("```\ncode\n```\n<span class=\"sn-bg-red\">x</span>\n"),
            "```\ncode\n```\n==x==\n"
        );
        // An unclosed fence protects the rest of the note instead of risking changes.
        let open = "```\n<span class=\"sn-bg-red\">x</span>\n";
        assert_eq!(to_obsidian(open), open);
    }

    #[test]
    fn an_escaped_angle_bracket_is_not_a_tag() {
        let text = "\\<span class=\"sn-bg-red\">x</span>";
        assert_eq!(to_obsidian(text), text);
    }

    #[test]
    fn other_syntax_and_text_survive_byte_for_byte() {
        let plain = "# Title\n\n- [ ] task with ==marked== and <u>under</u> and H<sub>2</sub>O\n\n> [!note] ünïcödé ✓\n";
        assert_eq!(to_obsidian(plain), plain);
        let mixed = "é <span class=\"sn-bg-red\">ü</span> ✓\n| <span class=\"sn-text-blue\">a</span> | b |\n";
        assert_eq!(to_obsidian(mixed), "é ==ü== ✓\n| a | b |\n");
    }

    #[test]
    fn converting_twice_changes_nothing_more() {
        let once = to_obsidian("<span class=\"sn-text-red sn-bg-blue\">a</span> <span class=\"sn-text-red\">b</span>");
        assert_eq!(to_obsidian(&once), once);
    }

    #[test]
    fn hostile_input_is_quick() {
        let start = std::time::Instant::now();
        let many_open = "<span class=\"sn-bg-red\">".repeat(20_000);
        let _ = to_obsidian(&many_open);
        let ticks = "`".repeat(100_000);
        let _ = to_obsidian(&format!("<span class=\"sn-bg-red\">{ticks}"));
        let long_class = format!("<span class=\"{}\">x</span>", "sn-bg-red ".repeat(10_000));
        let _ = to_obsidian(&long_class);
        // Deeply nested, correctly closed spans, and backtick runs of every length with no partner.
        let nested = format!("{}x{}", "<span class=\"sn-bg-red\">".repeat(20_000), "</span>".repeat(20_000));
        let _ = to_obsidian(&nested);
        let runs: String = (1..3_000).map(|n| format!("{} ", "`".repeat(n))).collect();
        let _ = to_obsidian(&format!("<span class=\"sn-bg-red\">{runs}</span>"));
        assert!(start.elapsed().as_secs() < 5, "took {:?}", start.elapsed());
    }

    #[test]
    fn nesting_past_the_limit_is_left_as_written() {
        let deep = format!("{}x{}", "<span class=\"sn-text-red\">".repeat(40), "</span>".repeat(40));
        let out = to_obsidian(&deep);
        assert!(out.contains("x") && out.contains("<span"), "deep part kept");
        let shallow = format!("{}x{}", "<span class=\"sn-text-red\">".repeat(5), "</span>".repeat(5));
        assert_eq!(to_obsidian(&shallow), "x");
    }

    // Two spellings of one folder (short or long Windows names, the "\\?\" prefix) are the same place.
    fn assert_same_place(a: &Path, b: &Path) {
        assert_eq!(fs::canonicalize(a).expect("a exists"), fs::canonicalize(b).expect("b exists"));
    }

    #[test]
    fn long_windows_paths_are_shown_without_the_prefix() {
        assert_eq!(friendly_path(Path::new("\\\\?\\C:\\Users\\alice\\Notes")), "C:\\Users\\alice\\Notes");
        assert_eq!(friendly_path(Path::new("\\\\?\\UNC\\server\\share")), "\\\\?\\UNC\\server\\share");
        assert_eq!(friendly_path(Path::new("/home/alice/Notes")), "/home/alice/Notes");
    }

    fn sample_vault(name: &str) -> (PathBuf, Vault) {
        let parent = temp_dir(name);
        let root = parent.join("My Notes");
        fs::create_dir_all(root.join("sub")).expect("sub");
        fs::create_dir_all(root.join("attachments")).expect("attachments");
        fs::create_dir_all(root.join(".obsidian")).expect("hidden");
        fs::write(root.join("a.md"), "a <span class=\"sn-bg-red\">x</span>\n").expect("a");
        fs::write(root.join("sub").join("b.md"), "plain\n").expect("b");
        fs::write(root.join("attachments").join("p.png"), [137u8, 80, 78, 71, 0, 1, 2]).expect("png");
        fs::write(root.join(".obsidian").join("app.json"), "{}").expect("config");
        fs::write(root.join("bad.md"), [0xffu8, 0xfe, b'<', b's']).expect("not utf8");
        let vault = Vault::open(&root).expect("open");
        (parent, vault)
    }

    #[test]
    fn the_copy_is_converted_and_the_vault_is_untouched() {
        let (parent, vault) = sample_vault("copy");
        let report = export_obsidian_copy(&vault).expect("export");
        assert_same_place(&report.path, &parent.join("My Notes (Obsidian copy)"));
        assert_eq!((report.notes, report.changed, report.files, report.skipped), (3, 1, 1, 0));
        assert_eq!(fs::read_to_string(report.path.join("a.md")).expect("a"), "a ==x==\n");
        assert_eq!(fs::read_to_string(report.path.join("sub").join("b.md")).expect("b"), "plain\n");
        assert_eq!(fs::read(report.path.join("attachments").join("p.png")).expect("png"), [137u8, 80, 78, 71, 0, 1, 2]);
        // A file that is not text is copied as it is.
        assert_eq!(fs::read(report.path.join("bad.md")).expect("bad"), [0xffu8, 0xfe, b'<', b's']);
        // Hidden folders are not copied.
        assert!(!report.path.join(".obsidian").exists());
        // The original has not changed.
        let original = fs::read_to_string(vault.root().join("a.md")).expect("original");
        assert_eq!(original, "a <span class=\"sn-bg-red\">x</span>\n");
        // No half-written files are left.
        let leftovers = fs::read_dir(&report.path).expect("list").flatten().filter(|e| e.file_name().to_string_lossy().ends_with(".sn-tmp")).count();
        assert_eq!(leftovers, 0);
        let _ = fs::remove_dir_all(parent);
    }

    #[test]
    fn a_second_copy_gets_a_new_name_and_nothing_is_replaced() {
        let (parent, vault) = sample_vault("twice");
        let first = export_obsidian_copy(&vault).expect("first");
        fs::write(first.path.join("a.md"), "edited by the owner\n").expect("edit");
        let second = export_obsidian_copy(&vault).expect("second");
        assert_same_place(&second.path, &parent.join("My Notes (Obsidian copy) 2"));
        assert_eq!(fs::read_to_string(first.path.join("a.md")).expect("kept"), "edited by the owner\n");
        let _ = fs::remove_dir_all(parent);
    }

    #[cfg(unix)]
    #[test]
    fn links_are_not_followed() {
        let (parent, vault) = sample_vault("links");
        let outside = parent.join("outside.md");
        fs::write(&outside, "secret\n").expect("outside");
        std::os::unix::fs::symlink(&outside, vault.root().join("link.md")).expect("file link");
        std::os::unix::fs::symlink(vault.root(), vault.root().join("loop")).expect("folder loop");
        let report = export_obsidian_copy(&vault).expect("export");
        assert!(!report.path.join("link.md").exists());
        assert!(!report.path.join("loop").exists());
        let _ = fs::remove_dir_all(parent);
    }
}
