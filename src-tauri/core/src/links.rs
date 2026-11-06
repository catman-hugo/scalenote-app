//! Links between pages, in the form Obsidian uses: `[[Page]]`, `[[Page|shown text]]`,
//! `[[Page#Heading]]` and `[[Page#^block-id]]`. This file finds them in page text, works out
//! which page a link means, and lists the pages that link to a given page ("backlinks").
//!
//! The same rules are written a second time in `web/wikilinks.js` so the editor can colour a
//! link without asking the backend. Both are tested against the same file of cases,
//! `tests/fixtures/wikilinks.txt`, so they cannot drift apart.
//!
//! Like search, backlinks keep no index: each call reads the pages again, with limits.

use crate::search::{fold_text, snippet_around};
use crate::vault::{Result, Vault, MAX_NOTE_BYTES};
use std::collections::HashMap;
use std::fs;

/// Longest text between `[[` and `]]` that counts as a link.
const MAX_INNER_BYTES: usize = 300;
/// A page with more links than this is read only up to this many (a page of nothing but links
/// must not make a search for backlinks slow).
const MAX_LINKS_PER_PAGE: usize = 5_000;
/// Most pages listed as linking to one page.
pub const MAX_BACKLINKS: usize = 200;
/// A backlink search stops reading after this much text, as search does.
const MAX_TOTAL_BYTES: u64 = 512 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WikiLink {
    /// The page part: `Plan`, `School/Plan` or `Plan.md`. Empty for a link to a place in the same page.
    pub page: String,
    /// After `#`: a heading, or `^id` for a block.
    pub anchor: Option<String>,
    /// After `|`: the text shown instead of the page name.
    pub alias: Option<String>,
    /// `![[Page]]` shows the page inside this one; it still counts as a link.
    pub embed: bool,
    /// Where the `[[` starts, in bytes from the start of the text.
    pub start: usize,
    /// Where the closing `]]` ends.
    pub end: usize,
}

/// Splits the text between the brackets. Returns None when nothing is left to point at.
pub fn parse_inner(inner: &str) -> Option<(String, Option<String>, Option<String>)> {
    // In a table cell the bar has to be written "\|"; the backslash is not part of the name.
    let (target, alias) = match inner.find('|') {
        Some(at) => (inner[..at].trim_end_matches('\\'), Some(inner[at + 1..].trim())),
        None => (inner, None),
    };
    let (page, anchor) = match target.find('#') {
        Some(at) => (&target[..at], Some(target[at + 1..].trim())),
        None => (target, None),
    };
    let page = page.trim();
    let anchor = anchor.filter(|a| !a.is_empty());
    if page.is_empty() && anchor.is_none() {
        return None;
    }
    let alias = alias.filter(|a| !a.is_empty());
    Some((page.to_string(), anchor.map(str::to_string), alias.map(str::to_string)))
}

/// All links in a page's text, in order. Links inside fenced code and inline code are not
/// links, and a `[[` without a matching `]]` on the same line is just text.
pub fn find_wikilinks(text: &str) -> Vec<WikiLink> {
    let mut links = Vec::new();
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
            (None, None) => scan_line(line, offset, &mut links),
        }
        offset += line.len();
        if links.len() >= MAX_LINKS_PER_PAGE {
            break;
        }
    }
    links
}

fn scan_line(line: &str, offset: usize, links: &mut Vec<WikiLink>) {
    let bytes = line.as_bytes();
    let mut i = 0;
    while i < bytes.len() && links.len() < MAX_LINKS_PER_PAGE {
        match bytes[i] {
            b'\\' => i += 2, // an escaped bracket is text
            b'`' => i = skip_code_span(bytes, i),
            b'[' if bytes.get(i + 1) == Some(&b'[') => match read_link(line, i) {
                Some((inner_end, link)) => {
                    links.push(WikiLink { start: offset + i, end: offset + inner_end + 2, embed: i > 0 && bytes[i - 1] == b'!', ..link });
                    i = inner_end + 2;
                }
                None => i += 1,
            },
            _ => i += 1,
        }
    }
}

// A run of backticks closed by a run of the same length is a code span; an unclosed run is text.
fn skip_code_span(bytes: &[u8], from: usize) -> usize {
    let mut run = 0;
    while bytes.get(from + run) == Some(&b'`') {
        run += 1;
    }
    let mut i = from + run;
    while i < bytes.len() {
        if bytes[i] == b'`' {
            let mut closing = 0;
            while bytes.get(i + closing) == Some(&b'`') {
                closing += 1;
            }
            if closing == run {
                return i + closing;
            }
            i += closing;
        } else {
            i += 1;
        }
    }
    from + run
}

// `at` is the first "[". Returns the position of the closing "]]" and the link.
fn read_link(line: &str, at: usize) -> Option<(usize, WikiLink)> {
    let rest = &line.as_bytes()[at + 2..];
    let close = rest.iter().position(|&b| b == b']' || b == b'[' || b == b'\n' || b == b'\r')?;
    if rest[close] != b']' || rest.get(close + 1) != Some(&b']') || close == 0 || close > MAX_INNER_BYTES {
        return None;
    }
    let inner = &line[at + 2..at + 2 + close];
    let (page, anchor, alias) = parse_inner(inner)?;
    Some((at + 2 + close, WikiLink { page, anchor, alias, embed: false, start: 0, end: 0 }))
}

fn without_extension(name: &str) -> &str {
    let bytes = name.as_bytes();
    if bytes.len() > 3 && bytes[bytes.len() - 3..].eq_ignore_ascii_case(b".md") {
        &name[..name.len() - 3]
    } else {
        name
    }
}

fn parent_of(path: &str) -> &str {
    path.rfind('/').map_or("", |at| &path[..at])
}

/// Works out which page a link means, the way Obsidian does: names are matched without regard
/// to case and without `.md`; a name with folders in it must match the end of the path; when
/// several pages fit, the one in the same folder as the page holding the link wins, then the
/// one with the fewest folders, then the first in alphabetical order.
pub struct Resolver {
    pages: Vec<String>,
    /// lower-case last name (no `.md`) -> positions in `pages`
    by_name: HashMap<String, Vec<usize>>,
}

impl Resolver {
    pub fn new(pages: &[String]) -> Resolver {
        let mut by_name: HashMap<String, Vec<usize>> = HashMap::new();
        for (index, path) in pages.iter().enumerate() {
            let key = without_extension(path).to_lowercase();
            let name = key.rsplit('/').next().unwrap_or("").to_string();
            by_name.entry(name).or_default().push(index);
        }
        Resolver { pages: pages.to_vec(), by_name }
    }

    /// `page` is the page part of a link; `from` is the path of the page that holds the link.
    /// An empty `page` (a link like `[[#Heading]]`) means the page itself.
    pub fn resolve(&self, page: &str, from: &str) -> Option<&str> {
        let wanted = without_extension(page.trim().trim_start_matches('/')).to_lowercase();
        if wanted.is_empty() {
            return self.pages.iter().find(|p| p.as_str() == from).map(String::as_str);
        }
        let name = wanted.rsplit('/').next().unwrap_or("");
        let suffix = format!("/{wanted}");
        let mut fits: Vec<&String> = self
            .by_name
            .get(name)?
            .iter()
            .map(|&i| &self.pages[i])
            .filter(|path| {
                let key = without_extension(path).to_lowercase();
                key == wanted || key.ends_with(&suffix)
            })
            .collect();
        let home = parent_of(from);
        fits.sort_by(|a, b| {
            let same = |p: &&String| parent_of(p) != home;
            let depth = |p: &&String| p.matches('/').count();
            same(a).cmp(&same(b)).then(depth(a).cmp(&depth(b))).then(a.cmp(b))
        });
        fits.first().map(|p| p.as_str())
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Backlink {
    /// The page that holds the link.
    pub path: String,
    pub title: String,
    /// How many links in that page point here.
    pub count: usize,
    /// The line of the first such link, as pieces; `true` marks the link itself.
    pub snippet: Vec<(String, bool)>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BacklinkResults {
    pub items: Vec<Backlink>,
    pub truncated: bool,
}

impl Vault {
    /// The pages that link to `relative`, in alphabetical order of title. A page that links to
    /// itself is not listed. Hidden folders (the trash) are not searched, so a deleted page
    /// stops being listed and is listed again when restored.
    pub fn backlinks(&self, relative: &str) -> Result<BacklinkResults> {
        self.resolve(relative)?; // refuses a path that is not inside the vault
        let mut truncated = false;
        let files = self.page_files(&mut truncated);
        let paths: Vec<String> = files.iter().map(|(relative, _)| relative.clone()).collect();
        let resolver = Resolver::new(&paths);
        let mut items = Vec::new();
        let mut read_bytes: u64 = 0;
        for (path, full) in &files {
            if path == relative {
                continue;
            }
            if read_bytes >= MAX_TOTAL_BYTES {
                truncated = true;
                break;
            }
            let Ok(meta) = fs::metadata(full) else { continue };
            if meta.len() > MAX_NOTE_BYTES {
                continue;
            }
            read_bytes += meta.len();
            let Ok(bytes) = fs::read(full) else { continue };
            let Ok(text) = String::from_utf8(bytes) else { continue };
            if let Some(item) = backlink_from(path, &text, relative, &resolver) {
                if items.len() >= MAX_BACKLINKS {
                    truncated = true;
                    break;
                }
                items.push(item);
            }
        }
        items.sort_by(|a, b| a.title.to_lowercase().cmp(&b.title.to_lowercase()).then_with(|| a.path.cmp(&b.path)));
        Ok(BacklinkResults { items, truncated })
    }
}

fn backlink_from(path: &str, text: &str, target: &str, resolver: &Resolver) -> Option<Backlink> {
    let mut count = 0;
    let mut first: Option<(usize, usize)> = None;
    for link in find_wikilinks(text) {
        if link.page.is_empty() || resolver.resolve(&link.page, path) != Some(target) {
            continue;
        }
        count += 1;
        first.get_or_insert((link.start, link.end));
    }
    let (start, end) = first?;
    let file_name = path.rsplit('/').next().unwrap_or(path);
    let title = without_extension(file_name).to_string();
    // The snippet functions count letters, not bytes, so the position is converted once.
    let at = text[..start].chars().count();
    let literal = fold_text(&text[start..end]);
    let snippet = snippet_around(text, &fold_text(text), at, &[literal]);
    Some(Backlink { path: path.to_string(), title, count, snippet })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn links(text: &str) -> Vec<(String, Option<String>, Option<String>, bool)> {
        find_wikilinks(text).into_iter().map(|l| (l.page, l.anchor, l.alias, l.embed)).collect()
    }

    fn plain(page: &str) -> (String, Option<String>, Option<String>, bool) {
        (page.to_string(), None, None, false)
    }

    #[test]
    fn finds_every_form_of_link() {
        let found = links("a [[Plan]] b [[Plan|the plan]] c [[Plan#Goals]] d [[Plan#^abc-1]] e [[#Here]] f ![[Picture]]");
        assert_eq!(found[0], plain("Plan"));
        assert_eq!(found[1], ("Plan".into(), None, Some("the plan".into()), false));
        assert_eq!(found[2], ("Plan".into(), Some("Goals".into()), None, false));
        assert_eq!(found[3], ("Plan".into(), Some("^abc-1".into()), None, false));
        assert_eq!(found[4], ("".into(), Some("Here".into()), None, false));
        assert_eq!(found[5], ("Picture".into(), None, None, true));
        assert_eq!(found.len(), 6);
    }

    #[test]
    fn the_positions_cut_out_exactly_the_link() {
        let text = "héllo [[Plan|x]] and ![[Pic]].";
        let found = find_wikilinks(text);
        assert_eq!(&text[found[0].start..found[0].end], "[[Plan|x]]");
        assert_eq!(&text[found[1].start..found[1].end], "[[Pic]]");
    }

    #[test]
    fn code_is_not_searched_for_links() {
        let text = "`[[a]]` and ``[[b]]`` and [[c]]\n```\n[[d]]\n```\n    ~~~\n[[e]]\n~~~\n[[f]]\n~~~\n[[g]]\n";
        let found: Vec<String> = links(text).into_iter().map(|l| l.0).collect();
        // The indented "~~~" is not a fence (four spaces); the next "~~~" opens one that hides "f".
        assert_eq!(found, vec!["c", "e", "g"]);
    }

    #[test]
    fn broken_or_odd_brackets_are_plain_text() {
        for text in ["[[", "[[]]", "[[ ]]", "[[a", "[[a]", "[[a\nb]]", "[[a[b]]", "[ [a]]", "[[#]]", "[[|x]]"] {
            assert!(links(text).is_empty(), "{text:?}");
        }
        // A stray bracket in front does not hide the link behind it.
        assert_eq!(links("[[[a]]]"), vec![plain("a")]);
        let long = format!("[[{}]]", "a".repeat(MAX_INNER_BYTES + 1));
        assert!(links(&long).is_empty());
        assert_eq!(links(&format!("[[{}]]", "a".repeat(MAX_INNER_BYTES))).len(), 1);
    }

    #[test]
    fn a_table_cell_bar_and_spaces_are_handled() {
        assert_eq!(links("| [[Plan\\|alias]] |")[0], ("Plan".into(), None, Some("alias".into()), false));
        assert!(links("\\[[a]]").is_empty());
        assert_eq!(links("[[ Plan # Goals | shown ]]")[0], ("Plan".into(), Some("Goals".into()), Some("shown".into()), false));
    }

    #[test]
    fn hostile_text_is_read_in_reasonable_time_and_never_panics() {
        let started = std::time::Instant::now();
        let many = "[[a]]".repeat(100_000);
        assert_eq!(find_wikilinks(&many).len(), MAX_LINKS_PER_PAGE);
        for text in ["`".repeat(100_000), "[[".repeat(100_000), "[[a".repeat(50_000), "é[[é]]é".repeat(1000), "\0[[\0]]".to_string()] {
            let _ = find_wikilinks(&text);
        }
        assert!(started.elapsed().as_secs() < 5, "{:?}", started.elapsed());
    }

    // The cases shared with the editor's version of the rules.
    fn fixture() -> String {
        let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../tests/fixtures/wikilinks.txt");
        fs::read_to_string(path).expect("the shared test cases")
    }

    #[test]
    fn the_shared_cases_for_reading_and_resolving_links() {
        let mut pages: Vec<String> = Vec::new();
        let (mut parsed, mut resolved) = (0, 0);
        for line in fixture().lines() {
            let line = line.trim();
            if line.is_empty() || line.starts_with('#') {
                continue;
            }
            if let Some(list) = line.strip_prefix("pages =") {
                pages = list.split(',').map(|p| p.trim().to_string()).collect();
            } else if let Some(case) = line.strip_prefix("parse ") {
                let (input, expected) = case.split_once(" => ").expect("parse line");
                let got = match parse_inner(input) {
                    Some((page, anchor, alias)) => format!("{page} | {} | {}", anchor.unwrap_or_default(), alias.unwrap_or_default()),
                    None => "none".to_string(),
                };
                let squash = |s: &str| s.split_whitespace().collect::<Vec<_>>().join(" ");
                assert_eq!(squash(&got), squash(expected), "parse {input}");
                parsed += 1;
            } else if let Some(case) = line.strip_prefix("resolve ") {
                let (head, expected) = case.split_once(" -> ").expect("resolve line");
                let (from, page) = head.split_once(" | ").expect("from | page");
                let got = Resolver::new(&pages).resolve(page, from).unwrap_or("(none)").to_string();
                assert_eq!(got, expected.trim(), "resolve {head}");
                resolved += 1;
            }
        }
        assert!(parsed >= 8 && resolved >= 12, "the file was read: {parsed} {resolved}");
    }

    fn vault(name: &str, pages: &[(&str, &str)]) -> (PathBuf, Vault) {
        let dir = std::env::temp_dir().join(format!("sn-links-{name}-{}", std::process::id()));
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
    fn backlinks_lists_the_pages_that_link_here_with_a_marked_line() {
        let (dir, vault) = vault("back", &[
            ("School/Plan.md", "# Plan\n"),
            ("Biology.md", "intro\nsee [[Plan|the plan]] for goals, and [[plan#Goals]] too\n"),
            ("Notes/Zed.md", "[[School/Plan]]\n"),
            ("Other.md", "[[Plans]] and `[[Plan]]` and [[Missing]]\n"),
            ("School/Self.md", "[[Self]] [[Plan]]\n"),
            (".trash/1-0/item", "[[Plan]]\n"),
        ]);
        let found = vault.backlinks("School/Plan.md").expect("backlinks");
        let list: Vec<(&str, usize)> = found.items.iter().map(|b| (b.path.as_str(), b.count)).collect();
        assert_eq!(list, vec![("Biology.md", 2), ("School/Self.md", 1), ("Notes/Zed.md", 1)]);
        let line: String = found.items[0].snippet.iter().map(|(t, _)| t.as_str()).collect();
        assert!(line.starts_with("see [[Plan|the plan]] for goals"), "{line}");
        let marked: Vec<&str> = found.items[0].snippet.iter().filter(|(_, m)| *m).map(|(t, _)| t.as_str()).collect();
        assert_eq!(marked, vec!["[[Plan|the plan]]"]);
        assert!(vault.backlinks("../x.md").is_err());
        assert!(vault.backlinks("Nothing.md").expect("none").items.is_empty());
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn a_page_with_the_same_name_in_the_same_folder_wins_and_trash_is_ignored() {
        let (dir, vault) = vault("same", &[
            ("A/Plan.md", "x"),
            ("B/Plan.md", "x"),
            ("A/Reader.md", "[[Plan]]"),
            ("B/Reader.md", "[[Plan]] [[Plan]]"),
        ]);
        let a = vault.backlinks("A/Plan.md").expect("a");
        let b = vault.backlinks("B/Plan.md").expect("b");
        assert_eq!(a.items.iter().map(|i| i.path.as_str()).collect::<Vec<_>>(), vec!["A/Reader.md"]);
        assert_eq!(b.items.iter().map(|i| (i.path.as_str(), i.count)).collect::<Vec<_>>(), vec![("B/Reader.md", 2)]);
        let item = vault.move_to_trash("A/Reader.md").expect("trash");
        assert!(vault.backlinks("A/Plan.md").expect("after").items.is_empty());
        vault.restore_from_trash(&item.id).expect("restore");
        assert_eq!(vault.backlinks("A/Plan.md").expect("restored").items.len(), 1);
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn big_vaults_are_scanned_in_reasonable_time() {
        let pages: Vec<(String, String)> = (0..2_000).map(|i| (format!("F{}/P{i}.md", i % 20), format!("text [[P{}]] and [[P{}]]\n{}", i + 1, (i * 7) % 2_000, "filler ".repeat(100)))).collect();
        let refs: Vec<(&str, &str)> = pages.iter().map(|(a, b)| (a.as_str(), b.as_str())).collect();
        let (dir, vault) = vault("speed", &refs);
        let started = std::time::Instant::now();
        let found = vault.backlinks("F1/P1.md").expect("backlinks");
        let took = started.elapsed();
        eprintln!("backlinks over 2000 pages in {took:?}");
        assert!(!found.items.is_empty());
        assert!(took.as_secs() < 10, "{took:?}");
        let _ = fs::remove_dir_all(dir);
    }
}
