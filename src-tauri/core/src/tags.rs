//! Tags and favourites. A tag is written `#plan` or `#school/maths` in a page, or listed in the
//! page's properties (`tags: [plan, school/maths]`). A favourite page has `favorite: true` in its
//! properties. This file finds both, and lists them for every page ("page index").
//!
//! The rules for tags in the text are written a second time in `web/tagrules.js` so the editor
//! can mark a tag without asking the backend. Both are tested against the same file of cases,
//! `tests/fixtures/tags.txt`, so they cannot drift apart.
//!
//! Like search, the page index is not stored: each call reads the pages again, with limits.

use crate::links::{read_link, skip_code_span};
use crate::vault::{Result, Vault, MAX_NOTE_BYTES};
use std::fs;

/// Longest tag name, in letters.
const MAX_TAG_CHARS: usize = 100;
/// A page with more tags than this is read only up to this many.
const MAX_TAGS_PER_PAGE: usize = 5_000;
/// The index stops reading after this much text, as search does.
const MAX_TOTAL_BYTES: u64 = 512 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Tag {
    /// The name without the `#`, as written.
    pub name: String,
    /// Where the `#` is, in bytes from the start of the text.
    pub start: usize,
    /// Where the name ends.
    pub end: usize,
}

fn is_tag_char(c: char) -> bool {
    c.is_alphabetic() || c.is_numeric() || c == '_' || c == '-' || c == '/'
}

/// True when `name` (written without the `#`) is a tag name: letters, digits, `_`, `-` and `/`,
/// at least one character that is not a digit (so `1984` is a number, `y1984` is a tag).
pub fn is_tag_name(name: &str) -> bool {
    let count = name.chars().count();
    (1..=MAX_TAG_CHARS).contains(&count) && name.chars().all(is_tag_char) && name.chars().any(|c| !c.is_numeric())
}

/// All tags in a page's text, in order. Tags inside fenced code, inside code spans and inside
/// `[[links]]` are not tags.
pub fn find_tags(text: &str) -> Vec<Tag> {
    let mut tags = Vec::new();
    let mut fence: Option<char> = None;
    let mut offset = 0;
    for line in text.split_inclusive('\n') {
        let indented = line.len() - line.trim_start_matches(' ').len();
        let trimmed = &line[indented..];
        let marker = if indented > 3 {
            None
        } else if trimmed.starts_with("```") {
            Some('`')
        } else if trimmed.starts_with("~~~") {
            Some('~')
        } else {
            None
        };
        match (fence, marker) {
            (None, Some(open)) => fence = Some(open),
            (Some(open), Some(close)) if open == close => fence = None,
            (Some(_), _) => {}
            (None, None) => scan_line(line, offset, &mut tags),
        }
        offset += line.len();
        if tags.len() >= MAX_TAGS_PER_PAGE {
            break;
        }
    }
    tags
}

fn scan_line(line: &str, offset: usize, tags: &mut Vec<Tag>) {
    let bytes = line.as_bytes();
    let mut i = 0;
    while i < bytes.len() && tags.len() < MAX_TAGS_PER_PAGE {
        match bytes[i] {
            b'\\' => i += 2, // an escaped letter is text
            b'`' => i = skip_code_span(bytes, i),
            b'[' if bytes.get(i + 1) == Some(&b'[') => match read_link(line, i) {
                Some((inner_end, _)) => i = inner_end + 2, // a `#` in a link is its heading
                None => i += 1,
            },
            // A `#` is always at a letter boundary, so cutting the line here is safe.
            b'#' if line[..i].chars().next_back().map_or(true, char::is_whitespace) => match tag_end(line, i) {
                Some(end) => {
                    tags.push(Tag { name: line[i + 1..end].to_string(), start: offset + i, end: offset + end });
                    i = end;
                }
                None => i += 1,
            },
            _ => i += 1,
        }
    }
}

// The end of the tag name that starts after the `#` at `at`, or None when it is not a tag. Reads
// at most one letter past the longest name, so a very long run of letters is not read again.
fn tag_end(line: &str, at: usize) -> Option<usize> {
    let mut count = 0;
    let mut all_numbers = true;
    let mut end = at + 1;
    for c in line[at + 1..].chars() {
        if !is_tag_char(c) || count > MAX_TAG_CHARS {
            break;
        }
        count += 1;
        all_numbers &= c.is_numeric();
        end += c.len_utf8();
    }
    ((1..=MAX_TAG_CHARS).contains(&count) && !all_numbers).then_some(end)
}

/// The properties block at the top of a page (`---` ... `---`) as its inner lines, or None when
/// the page has none. Same shape as `splitFrontmatter` in `web/blocks.js`.
pub(crate) fn front_lines(text: &str) -> Option<Vec<&str>> {
    let is_fence = |line: &str| line.trim_end_matches(['\r', '\n']).trim_end_matches([' ', '\t']) == "---";
    let mut lines = text.split_inclusive('\n');
    let first = lines.next()?;
    if !first.ends_with('\n') || !is_fence(first) {
        return None;
    }
    let mut inner = Vec::new();
    for line in lines {
        if is_fence(line) {
            return Some(inner);
        }
        inner.push(line);
    }
    None
}

fn clean_tag(raw: &str) -> Option<String> {
    let name = raw.trim().trim_matches(['"', '\'']).trim_start_matches('#');
    is_tag_name(name).then(|| name.to_string())
}

/// The tags listed under `tags:` (or `tag:`) in a page's properties, in the forms Obsidian
/// writes: `tags: a, b`, `tags: [a, b]` and a list with one `- a` per line.
pub fn front_tags(text: &str) -> Vec<String> {
    let Some(lines) = front_lines(text) else { return Vec::new() };
    let mut found = Vec::new();
    let mut i = 0;
    while i < lines.len() && found.len() < MAX_TAGS_PER_PAGE {
        let line = lines[i].trim_end_matches(['\r', '\n']);
        i += 1;
        let Some(value) = line.strip_prefix("tags:").or_else(|| line.strip_prefix("tag:")) else { continue };
        let value = value.trim();
        if value.is_empty() {
            while i < lines.len() {
                let item = lines[i].trim_end_matches(['\r', '\n']);
                let Some(item) = item.trim_start().strip_prefix('-').filter(|rest| rest.is_empty() || rest.starts_with([' ', '\t'])) else { break };
                found.extend(clean_tag(item));
                i += 1;
            }
        } else {
            let list = value.strip_prefix('[').map_or(value, |inner| inner.strip_suffix(']').unwrap_or(inner));
            found.extend(list.split(|c: char| c == ',' || c.is_whitespace()).filter(|part| !part.is_empty()).filter_map(clean_tag));
        }
    }
    found
}

/// True when the page's properties have `favorite: true`.
pub fn front_favorite(text: &str) -> bool {
    let Some(lines) = front_lines(text) else { return false };
    lines.iter().find_map(|line| line.trim_end_matches(['\r', '\n']).strip_prefix("favorite:")).is_some_and(|value| value.trim().eq_ignore_ascii_case("true"))
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PageInfo {
    pub path: String,
    /// The page's tags, once each (no regard to case), the properties' tags first.
    pub tags: Vec<String>,
    pub favorite: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PageIndex {
    pub pages: Vec<PageInfo>,
    pub truncated: bool,
}

fn page_info(path: &str, text: &str) -> PageInfo {
    let mut tags: Vec<String> = Vec::new();
    let mut seen = std::collections::HashSet::new();
    let body_tags = find_tags(text).into_iter().map(|tag| tag.name);
    for name in front_tags(text).into_iter().chain(body_tags) {
        if seen.insert(name.to_lowercase()) {
            tags.push(name);
        }
    }
    PageInfo { path: path.to_string(), tags, favorite: front_favorite(text) }
}

impl Vault {
    /// The tags and favourite mark of every page that has either. Hidden folders (the trash) are
    /// not read, and a page that is too big to open or is not valid text is skipped without an
    /// error, as in search.
    pub fn page_index(&self) -> Result<PageIndex> {
        let mut truncated = false;
        let mut pages = Vec::new();
        let mut read_bytes: u64 = 0;
        for (path, full) in self.page_files(&mut truncated) {
            if read_bytes >= MAX_TOTAL_BYTES {
                truncated = true;
                break;
            }
            let Ok(meta) = fs::metadata(&full) else { continue };
            if meta.len() > MAX_NOTE_BYTES {
                continue;
            }
            read_bytes += meta.len();
            let Ok(bytes) = fs::read(&full) else { continue };
            let Ok(text) = String::from_utf8(bytes) else { continue };
            let info = page_info(&path, &text);
            if info.favorite || !info.tags.is_empty() {
                pages.push(info);
            }
        }
        pages.sort_by(|a, b| a.path.cmp(&b.path));
        Ok(PageIndex { pages, truncated })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn names(text: &str) -> Vec<String> {
        find_tags(text).into_iter().map(|t| t.name).collect()
    }

    // In the shared cases \n is a line break, \t a tab and \\ a backslash.
    fn unescape(text: &str) -> String {
        let mut out = String::new();
        let mut chars = text.chars();
        while let Some(c) = chars.next() {
            if c != '\\' {
                out.push(c);
                continue;
            }
            match chars.next() {
                Some('n') => out.push('\n'),
                Some('t') => out.push('\t'),
                Some(other) => out.push(other),
                None => out.push('\\'),
            }
        }
        out
    }

    #[test]
    fn the_shared_cases_for_tag_names_and_tags_in_text() {
        let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../tests/fixtures/tags.txt");
        let file = fs::read_to_string(path).expect("the shared test cases");
        let (mut checked_names, mut checked_finds) = (0, 0);
        for line in file.lines() {
            if line.trim().is_empty() || line.starts_with('#') {
                continue;
            }
            if let Some(case) = line.strip_prefix("name ") {
                let (input, expected) = case.split_once(" => ").expect("name line");
                assert_eq!(is_tag_name(input), expected.trim() == "yes", "name {input:?}");
                checked_names += 1;
            } else if let Some(case) = line.strip_prefix("find ") {
                let (input, expected) = case.split_once(" => ").expect("find line");
                let want: Vec<String> = if expected.trim() == "(none)" { Vec::new() } else { expected.split(", ").map(str::to_string).collect() };
                assert_eq!(names(&unescape(input)), want, "find {input:?}");
                checked_finds += 1;
            }
        }
        assert!(checked_names >= 15 && checked_finds >= 25, "the file was read: {checked_names} {checked_finds}");
    }

    #[test]
    fn the_positions_cut_out_exactly_the_tag() {
        let text = "héllo #plan and #日本語.";
        let found = find_tags(text);
        assert_eq!(&text[found[0].start..found[0].end], "#plan");
        assert_eq!(&text[found[1].start..found[1].end], "#日本語");
    }

    #[test]
    fn name_length_is_limited_in_letters() {
        assert!(is_tag_name(&"é".repeat(MAX_TAG_CHARS)));
        assert!(!is_tag_name(&"é".repeat(MAX_TAG_CHARS + 1)));
        assert!(names(&format!("#{}", "a".repeat(MAX_TAG_CHARS + 1))).is_empty());
        assert_eq!(names(&format!("#{}", "a".repeat(MAX_TAG_CHARS))).len(), 1);
    }

    #[test]
    fn hostile_text_is_read_in_reasonable_time_and_never_panics() {
        let started = std::time::Instant::now();
        assert_eq!(find_tags(&"#a ".repeat(100_000)).len(), MAX_TAGS_PER_PAGE);
        for text in ["`".repeat(100_000), "#".repeat(100_000), "# ".repeat(100_000), format!("#{}", "a".repeat(1_000_000)), "é#é".repeat(1000), "\\".repeat(100_001), "\0#\0".to_string()] {
            let _ = find_tags(&text);
        }
        assert!(started.elapsed().as_secs() < 5, "{:?}", started.elapsed());
    }

    #[test]
    fn tags_in_the_properties_are_read_in_every_form() {
        assert_eq!(front_tags("---\ntags: a, b/c, #d\n---\n"), vec!["a", "b/c", "d"]);
        assert_eq!(front_tags("---\ntags: [a, \"b\", 'c']\n---\n"), vec!["a", "b", "c"]);
        assert_eq!(front_tags("---\ntags:\n  - a\n  - \"#b\"\n-c\nother: 1\n---\n"), vec!["a", "b"]);
        assert_eq!(front_tags("---\r\ntag: a b\r\n---\r\n"), vec!["a", "b"]);
        assert_eq!(front_tags("---\ntags: [1984, ok, a.b]\n---\n"), vec!["ok"]);
        assert!(front_tags("---\ntags: a\n").is_empty(), "not closed");
        assert!(front_tags("tags: a\n").is_empty(), "no block");
        assert!(front_tags("text\n---\ntags: a\n---\n").is_empty(), "block not at the top");
        assert!(front_tags("---\n  tags: a\n---\n").is_empty(), "nested key");
    }

    #[test]
    fn a_favourite_page_has_favorite_true() {
        assert!(front_favorite("---\nfavorite: true\n---\n"));
        assert!(front_favorite("---\nid: x\r\nfavorite:   True \r\n---\r\n"));
        for text in ["---\nfavorite: false\n---\n", "---\nfavorite: yes\n---\n", "---\n favorite: true\n---\n", "favorite: true\n", "---\nfavorite: true\n"] {
            assert!(!front_favorite(text), "{text:?}");
        }
    }

    fn vault(name: &str, pages: &[(&str, &str)]) -> (PathBuf, Vault) {
        let dir = std::env::temp_dir().join(format!("sn-tags-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).expect("folder");
        for (path, text) in pages {
            let full = dir.join(path);
            fs::create_dir_all(full.parent().expect("parent")).expect("parent folder");
            fs::write(full, text).expect("page");
        }
        let vault = Vault::open(&dir).expect("open");
        (dir, vault)
    }

    #[test]
    fn the_index_lists_tags_and_favourites_once_per_page() {
        let (dir, vault) = vault("index", &[
            ("A.md", "---\ntags: [Plan]\nfavorite: true\n---\n#plan and #Other and #other\n"),
            ("School/B.md", "text #school/maths here\n"),
            ("None.md", "no tags, issue #12, a#b\n"),
            ("Code.md", "```\n#hidden\n```\n"),
            (".trash/1-0/item", "#trashed\n"),
            ("attachments/x.md", "#attached\n"),
        ]);
        let index = vault.page_index().expect("index");
        let shown: Vec<(String, Vec<String>, bool)> = index.pages.iter().map(|p| (p.path.clone(), p.tags.clone(), p.favorite)).collect();
        assert_eq!(shown, vec![
            ("A.md".to_string(), vec!["Plan".to_string(), "Other".to_string()], true),
            ("School/B.md".to_string(), vec!["school/maths".to_string()], false),
        ]);
        assert!(!index.truncated);
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn a_big_or_odd_page_does_not_stop_the_index() {
        let (dir, vault) = vault("odd", &[("Good.md", "#good\n")]);
        fs::write(dir.join("Binary.md"), [0xff, 0xfe, b'#', b'a']).expect("binary page");
        fs::write(dir.join("Huge.md"), vec![b'x'; (MAX_NOTE_BYTES + 1) as usize]).expect("huge page");
        let index = vault.page_index().expect("index");
        assert_eq!(index.pages.len(), 1);
        assert_eq!(index.pages[0].path, "Good.md");
        let _ = fs::remove_dir_all(dir);
    }
}
