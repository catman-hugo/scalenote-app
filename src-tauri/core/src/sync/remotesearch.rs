//! Searching the text of pages that are not on this device, through one of this person's own
//! paired devices that has them (0.6.5).
//!
//! The asking device sends the query (`KIND_SEARCH`); the paired device searches its own notes
//! folder for at most `ANSWER_TIME` and answers with the results (`KIND_FOUND`): paths, titles and
//! the short line around the match, never whole pages. Only paired devices may ask; another
//! person's device in a share may not (it is refused like any other request it is not allowed).
//!
//! The answer is still checked when it arrives, like everything from the network: one message of
//! at most `MAX_ANSWER_BYTES`, at most `MAX_HITS` results, safe paths of pages only, titles and
//! lines cut to a fixed length. The asking device keeps only results for pages it does not have.
//! Apps before 0.6.5 refuse the request, which reads as "that device cannot search yet".

use super::manifest::safe_path;
use crate::search::{SearchHit, MAX_RESULTS};
use serde_json::{json, Value};
use std::time::Duration;

pub const KIND_SEARCH: u8 = 0x70;
pub const KIND_FOUND: u8 = 0x71;
/// How long the answering device searches before it answers with what it has.
pub const ANSWER_TIME: Duration = Duration::from_secs(4);
/// How long the asking device waits for the answer.
pub const WAIT_TIME: Duration = Duration::from_secs(8);
pub const MAX_QUERY_BYTES: usize = 800;
/// Fits in one channel message (60 000 bytes) with room to spare.
pub const MAX_ANSWER_BYTES: usize = 48 * 1024;
pub const MAX_HITS: usize = MAX_RESULTS;
const MAX_TITLE_CHARS: usize = 255;
const MAX_PIECES: usize = 32;
const MAX_LINE_CHARS: usize = 400;

/// The answer's JSON, shortened until it fits: results are dropped from the end, and then it
/// says it is incomplete.
pub fn encode_answer(hits: &[SearchHit], truncated: bool) -> Vec<u8> {
    let mut count = hits.len().min(MAX_HITS);
    loop {
        let list: Vec<Value> = hits[..count]
            .iter()
            .map(|h| json!({ "path": h.path, "title": h.title, "snippet": h.snippet.iter().map(|(t, m)| json!([t, m])).collect::<Vec<_>>() }))
            .collect();
        let text = serde_json::to_vec(&json!({ "hits": list, "truncated": truncated || count < hits.len() })).unwrap_or_default();
        if text.len() <= MAX_ANSWER_BYTES || count == 0 {
            return text;
        }
        count = count * 3 / 4;
    }
}

/// Reads an answer, keeping only results that pass every check. `None` when it is not an answer.
pub fn decode_answer(bytes: &[u8]) -> Option<(Vec<SearchHit>, bool)> {
    if bytes.len() > MAX_ANSWER_BYTES {
        return None;
    }
    let value: Value = serde_json::from_slice(bytes).ok()?;
    let truncated = value.get("truncated")?.as_bool()?;
    let Value::Array(list) = value.get("hits")? else { return None };
    let hits = list.iter().take(MAX_HITS).filter_map(read_hit).collect();
    Some((hits, truncated || list.len() > MAX_HITS))
}

fn read_hit(value: &Value) -> Option<SearchHit> {
    let path = value.get("path")?.as_str()?.to_string();
    if !safe_path(&path) || !path.to_ascii_lowercase().ends_with(".md") || path.starts_with('.') || path.starts_with("attachments/") {
        return None;
    }
    let title: String = value.get("title")?.as_str()?.chars().filter(|c| !c.is_control()).take(MAX_TITLE_CHARS).collect();
    let Value::Array(pieces) = value.get("snippet")? else { return None };
    let mut snippet = Vec::new();
    let mut length = 0;
    for piece in pieces.iter().take(MAX_PIECES) {
        let Value::Array(pair) = piece else { return None };
        let text: String = pair.first()?.as_str()?.chars().map(|c| if c.is_control() { ' ' } else { c }).take(MAX_LINE_CHARS - length).collect();
        length += text.chars().count();
        snippet.push((text, pair.get(1)?.as_bool()?));
        if length >= MAX_LINE_CHARS {
            break;
        }
    }
    Some(SearchHit { path, title, snippet })
}

/// The query as sent, cut to the limit on a letter boundary.
pub fn encode_query(query: &str) -> Vec<u8> {
    let mut end = query.len().min(MAX_QUERY_BYTES);
    while !query.is_char_boundary(end) {
        end -= 1;
    }
    let mut message = vec![KIND_SEARCH];
    message.extend_from_slice(query[..end].as_bytes());
    message
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hit(path: &str) -> SearchHit {
        SearchHit { path: path.to_string(), title: "Cells".to_string(), snippet: vec![("the ".to_string(), false), ("cell".to_string(), true)] }
    }

    #[test]
    fn an_answer_reads_back_and_bad_results_are_dropped() {
        let hits = vec![hit("Biology/Cells.md"), hit("../etc/passwd.md"), hit(".scalenote/x.md"), hit("attachments/x.md"), hit("Biology/run.exe")];
        let (back, truncated) = decode_answer(&encode_answer(&hits, false)).expect("answer");
        assert_eq!(back, vec![hit("Biology/Cells.md")]);
        assert!(!truncated);
        for junk in [&b"junk"[..], b"{}", br#"{"hits":3,"truncated":false}"#] {
            assert!(decode_answer(junk).is_none());
        }
    }

    #[test]
    fn a_big_answer_is_shortened_to_fit_and_says_so() {
        let long = "w".repeat(2000);
        let hits: Vec<SearchHit> = (0..MAX_HITS).map(|n| SearchHit { path: format!("p{n}.md"), title: long.clone(), snippet: vec![(long.clone(), true)] }).collect();
        let bytes = encode_answer(&hits, false);
        assert!(bytes.len() <= MAX_ANSWER_BYTES);
        let (back, truncated) = decode_answer(&bytes).expect("answer");
        assert!(truncated && back.len() < MAX_HITS && !back.is_empty());
        assert!(back.iter().all(|h| h.title.chars().count() <= MAX_TITLE_CHARS && h.snippet.iter().map(|(t, _)| t.chars().count()).sum::<usize>() <= MAX_LINE_CHARS));
    }

    #[test]
    fn a_long_query_is_cut_on_a_letter() {
        let query = "é".repeat(MAX_QUERY_BYTES);
        let message = encode_query(&query);
        assert!(message.len() <= MAX_QUERY_BYTES + 1);
        assert!(std::str::from_utf8(&message[1..]).is_ok());
    }
}
