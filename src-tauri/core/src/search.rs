//! Search over the pages of a vault.
//!
//! There is no index. Every search reads the pages again, so the result can never be out of
//! date and there is nothing to repair when another program (Obsidian, a sync tool) changes
//! the folder. The cost is speed on very large vaults, which is why the limits below exist.
//! If an index is ever added it must stay a cache that can be rebuilt from the files.
//!
//! Matching ignores upper and lower case, works on letters of any language, and needs every
//! word of the query to appear in the page, either in its title or in its text.

use crate::attachments::ATTACHMENT_DIR;
use crate::vault::{has_md_extension, Result, Vault, MAX_NOTE_BYTES, MAX_TREE_DEPTH, MAX_TREE_ENTRIES};
use std::fs;
use std::path::PathBuf;

/// Longest query used (in letters) and most words used. The rest is ignored.
pub const MAX_QUERY_CHARS: usize = 200;
pub const MAX_QUERY_WORDS: usize = 8;
/// Most results one search returns.
pub const MAX_RESULTS: usize = 50;
/// A search stops collecting after this many matching pages, so a one-letter query in a huge
/// vault does not build a giant list. The best ones among those are still returned.
const MAX_COLLECTED: usize = 2_000;
/// A search stops reading after this much text, so it always ends in reasonable time.
const MAX_TOTAL_BYTES: u64 = 512 * 1024 * 1024;
/// Length of the line shown under a result, in letters.
const SNIPPET_CHARS: usize = 120;
/// How much of the snippet may come before the first match.
const SNIPPET_LEAD: usize = 40;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SearchHit {
    /// Path inside the vault, with `/` as the separator.
    pub path: String,
    /// The file name without `.md`.
    pub title: String,
    /// A line from the page as pieces; `true` marks the pieces that matched. The pieces are
    /// cut here so the interface never has to count letters itself.
    pub snippet: Vec<(String, bool)>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SearchResults {
    pub hits: Vec<SearchHit>,
    /// True when a limit stopped the search early, so there may be more pages.
    pub truncated: bool,
}

/// Lower-cases one letter without ever changing the number of letters. A few characters
/// lower-case to two (for example a capital I with a dot), and that would shift every
/// position after it, so those are left as they are.
fn fold(c: char) -> char {
    let mut lower = c.to_lowercase();
    match (lower.next(), lower.next()) {
        (Some(single), None) => single,
        _ => c,
    }
}

pub(crate) fn fold_text(text: &str) -> Vec<char> {
    text.chars().map(fold).collect()
}

/// First place at or after `from` where `word` starts.
fn find(haystack: &[char], word: &[char], from: usize) -> Option<usize> {
    if word.is_empty() || haystack.len() < word.len() {
        return None;
    }
    let last = haystack.len() - word.len();
    let first = word[0];
    (from..=last).find(|&at| haystack[at] == first && haystack[at..at + word.len()] == *word)
}

fn split_query(query: &str) -> Vec<Vec<char>> {
    let limited: String = query.chars().take(MAX_QUERY_CHARS).collect();
    limited.split_whitespace().take(MAX_QUERY_WORDS).map(fold_text).collect()
}

/// How well a page fits: lower is better.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
enum Rank {
    ExactTitle,
    TitleHasAll,
    Other,
}

struct Candidate {
    rank: Rank,
    hit: SearchHit,
    title_key: String,
}

impl Vault {
    /// Finds pages for a query. Hidden folders (including the trash) and the picture folder
    /// are not searched. Pages that are too big to open, or are not valid text, are skipped
    /// without an error, because one odd file must not break the search.
    pub fn search(&self, query: &str, limit: usize) -> Result<SearchResults> {
        let words = split_query(query);
        let limit = limit.clamp(1, MAX_RESULTS);
        let mut results = SearchResults { hits: Vec::new(), truncated: false };
        if words.is_empty() {
            return Ok(results);
        }
        let whole_query: Vec<char> = words.iter().enumerate().fold(Vec::new(), |mut all, (i, word)| {
            if i > 0 {
                all.push(' ');
            }
            all.extend_from_slice(word);
            all
        });

        let mut candidates: Vec<Candidate> = Vec::new();
        let mut read_bytes: u64 = 0;
        for (relative, path) in self.page_files(&mut results.truncated) {
            if candidates.len() >= MAX_COLLECTED || read_bytes >= MAX_TOTAL_BYTES {
                results.truncated = true;
                break;
            }
            let Ok(meta) = fs::metadata(&path) else { continue };
            if meta.len() > MAX_NOTE_BYTES {
                continue;
            }
            read_bytes += meta.len();
            let Ok(bytes) = fs::read(&path) else { continue };
            let Ok(text) = String::from_utf8(bytes) else { continue };
            if let Some(candidate) = match_page(&relative, &text, &words, &whole_query) {
                candidates.push(candidate);
            }
        }

        candidates.sort_by(|a, b| {
            a.rank
                .cmp(&b.rank)
                .then_with(|| a.title_key.cmp(&b.title_key))
                .then_with(|| a.hit.path.cmp(&b.hit.path))
        });
        results.hits = candidates.into_iter().take(limit).map(|c| c.hit).collect();
        Ok(results)
    }

    /// Every page in the vault as (vault path, real path), within the same limits and with
    /// the same skipped entries as the page list. Links to folders are not followed, so a
    /// loop cannot hang the search.
    pub(crate) fn page_files(&self, truncated: &mut bool) -> Vec<(String, PathBuf)> {
        let mut files = Vec::new();
        let mut folders: Vec<(PathBuf, usize)> = vec![(self.root().to_path_buf(), 0)];
        while let Some((dir, depth)) = folders.pop() {
            if depth >= MAX_TREE_DEPTH {
                *truncated = true;
                continue;
            }
            let Ok(read) = fs::read_dir(&dir) else { continue };
            for entry in read.flatten() {
                let Ok(file_type) = entry.file_type() else { continue };
                let Some(name) = entry.file_name().to_str().map(str::to_owned) else { continue };
                if name.starts_with('.') || (depth == 0 && name == ATTACHMENT_DIR && file_type.is_dir()) {
                    continue;
                }
                let path = entry.path();
                if file_type.is_dir() {
                    folders.push((path, depth + 1));
                } else if file_type.is_file() && has_md_extension(&name) {
                    if files.len() >= MAX_TREE_ENTRIES {
                        *truncated = true;
                        return files;
                    }
                    if let Some(relative) = self.relative_path(&path) {
                        files.push((relative, path));
                    }
                }
            }
        }
        files
    }

    fn relative_path(&self, path: &std::path::Path) -> Option<String> {
        let relative = path.strip_prefix(self.root()).ok()?;
        let parts: Option<Vec<&str>> = relative.components().map(|c| c.as_os_str().to_str()).collect();
        Some(parts?.join("/"))
    }
}

/// The page's text with its `id:` line blanked out. The id is bookkeeping for the app and must
/// not turn up in a search result. Letters are replaced one for one (line breaks stay), so
/// positions in the result are the same as in the original text.
pub(crate) fn without_page_id(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut in_front = false;
    for (number, line) in text.split_inclusive('\n').enumerate() {
        let bare = line.trim_end_matches(['\r', '\n']);
        let mut hide = false;
        if number == 0 {
            in_front = bare.trim_start_matches('\u{feff}').trim_end() == "---";
        } else if in_front {
            if bare.trim_end() == "---" {
                in_front = false;
            } else {
                hide = bare.starts_with("id:");
            }
        }
        if hide {
            out.extend(line.chars().map(|c| if c == '\r' || c == '\n' { c } else { ' ' }));
        } else {
            out.push_str(line);
        }
    }
    out
}

fn match_page(relative: &str, text: &str, words: &[Vec<char>], whole_query: &[char]) -> Option<Candidate> {
    let hidden = without_page_id(text);
    let text = hidden.as_str();
    let file_name = relative.rsplit('/').next().unwrap_or(relative);
    let title = file_name[..file_name.len().saturating_sub(3)].to_string();
    let folded_title = fold_text(&title);
    let body = fold_text(text);

    // Where each word first appears in the text; a word missing from both title and text
    // means the page does not match.
    let mut first_in_body: Vec<Option<usize>> = Vec::with_capacity(words.len());
    let mut all_in_title = true;
    for word in words {
        let in_title = find(&folded_title, word, 0).is_some();
        let in_body = find(&body, word, 0);
        if !in_title && in_body.is_none() {
            return None;
        }
        all_in_title &= in_title;
        first_in_body.push(in_body);
    }

    let rank = if folded_title == whole_query {
        Rank::ExactTitle
    } else if all_in_title {
        Rank::TitleHasAll
    } else {
        Rank::Other
    };
    let earliest = first_in_body.iter().flatten().min().copied();
    let snippet = earliest.map(|at| snippet_around(text, &body, at, words)).unwrap_or_default();
    Some(Candidate {
        rank,
        title_key: title.to_lowercase(),
        hit: SearchHit { path: relative.to_string(), title, snippet },
    })
}

/// The line that holds position `at`, cut to a short piece around it and split into
/// matching and other pieces. `text` and `body` have the same number of letters, so a
/// position in one is the same position in the other.
pub(crate) fn snippet_around(text: &str, body: &[char], at: usize, words: &[Vec<char>]) -> Vec<(String, bool)> {
    let line_start = body[..at].iter().rposition(|&c| c == '\n').map_or(0, |i| i + 1);
    let line_end = body[at..].iter().position(|&c| c == '\n').map_or(body.len(), |i| at + i);
    let start = line_start.max(at.saturating_sub(SNIPPET_LEAD));
    let end = line_end.min(start + SNIPPET_CHARS);

    let original: Vec<char> = text.chars().skip(start).take(end - start).collect();
    let folded = &body[start..end];
    let mut marked = vec![false; folded.len()];
    for word in words {
        let mut from = 0;
        while let Some(found) = find(folded, word, from) {
            marked[found..found + word.len()].iter_mut().for_each(|m| *m = true);
            from = found + word.len();
        }
    }

    let mut pieces: Vec<(String, bool)> = Vec::new();
    if start > line_start {
        pieces.push(("…".to_string(), false));
    }
    for (letter, is_match) in original.iter().zip(marked.iter()) {
        // Tabs and other control characters would break the layout.
        let letter = if letter.is_control() { ' ' } else { *letter };
        match pieces.last_mut() {
            Some((text, kind)) if *kind == *is_match => text.push(letter),
            _ => pieces.push((letter.to_string(), *is_match)),
        }
    }
    if end < line_end {
        pieces.push(("…".to_string(), false));
    }
    // Spaces at the two ends are not worth showing.
    if let Some(first) = pieces.first_mut() {
        first.0 = first.0.trim_start().to_string();
    }
    if let Some(last) = pieces.last_mut() {
        last.0 = last.0.trim_end().to_string();
    }
    pieces.retain(|(text, _)| !text.is_empty());
    pieces
}

#[cfg(test)]
mod tests {
    use super::*;

    fn vault(name: &str, pages: &[(&str, &str)]) -> (PathBuf, Vault) {
        let dir = std::env::temp_dir().join(format!("sn-search-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).expect("make folder");
        for (path, text) in pages {
            let full = dir.join(path);
            if let Some(parent) = full.parent() {
                fs::create_dir_all(parent).expect("parent");
            }
            fs::write(full, text).expect("write page");
        }
        let vault = Vault::open(&dir).expect("open");
        (dir, vault)
    }

    fn paths(results: &SearchResults) -> Vec<&str> {
        results.hits.iter().map(|h| h.path.as_str()).collect()
    }

    fn joined(hit: &SearchHit) -> String {
        hit.snippet.iter().map(|(t, _)| t.as_str()).collect()
    }

    #[test]
    fn finds_words_in_titles_and_text_ignoring_case() {
        let (dir, vault) = vault("basic", &[
            ("Biology.md", "Cells and Mitochondria\n"),
            ("School/Maths.md", "Nothing here\nthe quadratic formula\n"),
            ("Other.md", "unrelated\n"),
        ]);
        assert_eq!(paths(&vault.search("MITOCHONDRIA", 10).expect("search")), vec!["Biology.md"]);
        assert_eq!(paths(&vault.search("quadratic", 10).expect("search")), vec!["School/Maths.md"]);
        assert!(vault.search("zebra", 10).expect("search").hits.is_empty());
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn the_page_id_is_not_searched_and_not_shown() {
        let id = "0b9c7e52-3f1a-4d6e-9a58-2c7d41e6b0aa";
        let page = format!("---\nid: {id}\ntags: [x]\n---\n\nSome id text here\n");
        let (_dir, vault) = vault("hidden-id", &[("Plan.md", page.as_str())]);
        assert!(vault.search("0b9c7e52", 10).unwrap().hits.is_empty());
        let found = vault.search("id", 10).unwrap();
        assert_eq!(found.hits.len(), 1);
        assert_eq!(joined(&found.hits[0]), "Some id text here");
        assert_eq!(without_page_id(&page).len(), page.len());
        assert_eq!(without_page_id("no front\nid: kept\n"), "no front\nid: kept\n");
    }

    #[test]
    fn every_word_is_needed_but_they_can_be_in_title_or_text() {
        let (dir, vault) = vault("words", &[
            ("Recipes.md", "pasta with tomato\n"),
            ("Pasta.md", "boil water\n"),
            ("Other.md", "pasta only\n"),
        ]);
        let found = vault.search("pasta tomato", 10).expect("search");
        assert_eq!(paths(&found), vec!["Recipes.md"]);
        let found = vault.search("pasta water", 10).expect("search");
        assert_eq!(paths(&found), vec!["Pasta.md"], "one word in the title, one in the text");
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn titles_come_before_text_and_an_exact_title_comes_first() {
        let (dir, vault) = vault("rank", &[
            ("A body.md", "all about plants\n"),
            ("Plants and soil.md", "x\n"),
            ("Plants.md", "x\n"),
        ]);
        let found = vault.search("plants", 10).expect("search");
        assert_eq!(paths(&found), vec!["Plants.md", "Plants and soil.md", "A body.md"]);
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn the_snippet_marks_the_matching_pieces_and_keeps_the_original_case() {
        let (dir, vault) = vault("snippet", &[("Note.md", "first line\nThe Quick brown fox\nlast\n")]);
        let found = vault.search("quick fox", 10).expect("search");
        let hit = &found.hits[0];
        assert_eq!(joined(hit), "The Quick brown fox");
        let marked: Vec<&str> = hit.snippet.iter().filter(|(_, m)| *m).map(|(t, _)| t.as_str()).collect();
        assert_eq!(marked, vec!["Quick", "fox"]);
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn a_long_line_is_cut_around_the_match() {
        let line = format!("{} needle {}", "a".repeat(500), "b".repeat(500));
        let (dir, vault) = vault("long", &[("Long.md", &line)]);
        let found = vault.search("needle", 10).expect("search");
        let shown = joined(&found.hits[0]);
        assert!(shown.contains("needle") && shown.starts_with('…') && shown.ends_with('…'));
        assert!(shown.chars().count() <= SNIPPET_CHARS + 2);
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn other_alphabets_and_accents_work_and_positions_stay_right() {
        // The capital I with a dot lower-cases to two letters; it must not shift the snippet.
        let (dir, vault) = vault("unicode", &[("Ünï.md", "İstanbul is big. ÉCOLE du soir\n"), ("Greek.md", "ΑΘΗΝΑ\n")]);
        let found = vault.search("école", 10).expect("search");
        let hit = &found.hits[0];
        let marked: Vec<&str> = hit.snippet.iter().filter(|(_, m)| *m).map(|(t, _)| t.as_str()).collect();
        assert_eq!(marked, vec!["ÉCOLE"]);
        assert_eq!(paths(&vault.search("αθηνα", 10).expect("search")), vec!["Greek.md"]);
        assert_eq!(paths(&vault.search("ünï", 10).expect("search")), vec!["Ünï.md"]);
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn the_trash_hidden_folders_pictures_and_other_files_are_not_searched() {
        let (dir, vault) = vault("skip", &[
            ("Real.md", "secret\n"),
            (".trash/1-0/item", "secret\n"),
            (".obsidian/notes.md", "secret\n"),
            ("attachments/inside.md", "secret\n"),
            ("readme.txt", "secret\n"),
        ]);
        assert_eq!(paths(&vault.search("secret", 10).expect("search")), vec!["Real.md"]);
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn deleted_pages_leave_the_results_and_come_back_after_restore() {
        let (dir, vault) = vault("trash", &[("Gone.md", "findme\n")]);
        let item = vault.move_to_trash("Gone.md").expect("trash");
        assert!(vault.search("findme", 10).expect("search").hits.is_empty());
        vault.restore_from_trash(&item.id).expect("restore");
        assert_eq!(paths(&vault.search("findme", 10).expect("search")), vec!["Gone.md"]);
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn odd_queries_do_not_fail() {
        let (dir, vault) = vault("odd", &[("A.md", "a (b) [c] *d* \\ . ^ $ + ? {e}\n")]);
        for query in ["", "   ", "\n\t", "(", "[", "\\", ".*", "\0", "((((((", "?+*"] {
            assert!(vault.search(query, 10).is_ok(), "{query:?}");
        }
        assert!(vault.search("", 10).expect("search").hits.is_empty());
        assert_eq!(paths(&vault.search("[c]", 10).expect("search")), vec!["A.md"], "no pattern syntax");
        assert_eq!(paths(&vault.search(".*", 10).expect("search")), Vec::<&str>::new(), "not a pattern");
        let huge = "word ".repeat(10_000);
        assert!(vault.search(&huge, 10).is_ok());
        assert!(vault.search("a", 0).expect("limit raised to 1").hits.len() <= 1);
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn the_result_list_is_limited_and_big_or_broken_pages_are_skipped() {
        let mut pages: Vec<(String, String)> = (0..70).map(|i| (format!("Page {i:02}.md"), "common\n".to_string())).collect();
        pages.push(("Binary.md".to_string(), String::new()));
        let refs: Vec<(&str, &str)> = pages.iter().map(|(a, b)| (a.as_str(), b.as_str())).collect();
        let (dir, vault) = vault("limit", &refs);
        fs::write(dir.join("Binary.md"), [0xff, 0xfe, b'c', b'o', b'm', b'm', b'o', b'n']).expect("not text");
        let big = vec![b'x'; (MAX_NOTE_BYTES + 1) as usize];
        fs::write(dir.join("Big.md"), big).expect("big");
        assert_eq!(vault.search("common", 1_000).expect("search").hits.len(), MAX_RESULTS);
        assert_eq!(vault.search("common", 5).expect("search").hits.len(), 5);
        assert!(vault.search("xxxx", 10).expect("search").hits.is_empty(), "too big to read");
        let _ = fs::remove_dir_all(dir);
    }

    #[cfg(unix)]
    #[test]
    fn links_to_folders_are_not_followed() {
        let (dir, vault) = vault("link", &[("A.md", "x\n")]);
        let outside = std::env::temp_dir().join(format!("sn-search-outside-{}", std::process::id()));
        let _ = fs::remove_dir_all(&outside);
        fs::create_dir_all(&outside).expect("outside");
        fs::write(outside.join("Out.md"), "needle\n").expect("out");
        std::os::unix::fs::symlink(&outside, dir.join("link")).expect("link");
        std::os::unix::fs::symlink(&dir, dir.join("loop")).expect("loop");
        assert!(vault.search("needle", 10).expect("search").hits.is_empty());
        let _ = fs::remove_dir_all(dir);
        let _ = fs::remove_dir_all(outside);
    }

    #[test]
    fn a_big_vault_is_searched_in_reasonable_time() {
        let pages: Vec<(String, String)> = (0..3_000)
            .map(|i| (format!("Folder {}/Page {i}.md", i % 30), format!("line one\nsome text about topic {i}\n{}\n", "filler ".repeat(200))))
            .collect();
        let refs: Vec<(&str, &str)> = pages.iter().map(|(a, b)| (a.as_str(), b.as_str())).collect();
        let (dir, vault) = vault("speed", &refs);
        let started = std::time::Instant::now();
        let found = vault.search("topic 2999", 10).expect("search");
        let took = started.elapsed();
        assert_eq!(paths(&found), vec!["Folder 29/Page 2999.md"], "both words are needed");
        eprintln!("searched 3000 pages in {took:?}");
        assert!(took.as_secs() < 10, "{took:?}");
        let _ = fs::remove_dir_all(dir);
    }
}
