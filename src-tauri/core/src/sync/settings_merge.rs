//! Syncing the folder colours file (`.scalenote/folder-icons.json`) by folder, not as one file.
//!
//! Why: the file holds the look of every folder. Before 0.6.1 a sync treated it like a page: when
//! both devices had changed it, the newer file won whole, so colours set on one device could be
//! wiped by an empty or older file from the other (seen when a laptop with coloured folders first
//! synced with a phone). Now the two files are merged folder by folder:
//! - a folder set on only one side keeps that look;
//! - a folder changed on one side since the last sync takes that change;
//! - a folder changed on both sides takes the newer file's look (the "winner" of the plan).
//!
//! "Since the last sync" needs the file as it was then, so after each sync in which both devices
//! ended with the same file, its text is kept per paired device (`.scalenote/sync-settings-
//! <device>.json`, never synced). Without it (the first sync), nothing is taken as removed: the
//! looks of both sides are joined.
//!
//! The file came from another device, so it is untrusted: only format 1 with an `icons` object is
//! merged, entries are kept as they are (the interface checks them when it draws), the size limit
//! of the sync applies, and anything else falls back to the old rule (the newer file wins).

use serde_json::{Map, Value};

/// The file format this version can merge (the interface writes format 1, web/foldericons.js).
const FORMAT: u64 = 1;
/// The same limit as the interface keeps (MAX_ENTRIES in foldericons.js).
const MAX_ENTRIES: usize = 5000;

/// The `icons` of a colours file, or `None` when it is not a file this version may merge.
#[cfg(test)]
fn icons_of(text: &[u8]) -> Option<(Map<String, Value>, Map<String, Value>)> {
    entries_of(text, "icons", MAX_ENTRIES)
}

/// The object under `field` of a format 1 file, and the rest of the file.
fn entries_of(text: &[u8], field: &str, max: usize) -> Option<(Map<String, Value>, Map<String, Value>)> {
    let Value::Object(mut whole) = serde_json::from_slice::<Value>(text).ok()? else { return None };
    if whole.get("format").and_then(Value::as_u64) != Some(FORMAT) {
        return None;
    }
    let Some(Value::Object(entries)) = whole.remove(field) else { return None };
    (entries.len() <= max).then_some((whole, entries))
}

/// Merges the two colours files (see the top of this file). `base` is the file both devices had
/// after the last sync, if known. `local_wins` says which file is newer. Returns the merged file,
/// or `None` when one of them cannot be merged (then the newer file wins whole, as before).
pub fn merge(base: Option<&[u8]>, local: &[u8], remote: &[u8], local_wins: bool) -> Option<Vec<u8>> {
    merge_keyed(base, local, remote, local_wins, "icons", MAX_ENTRIES)
}

/// The same merge for any format 1 file that keeps its entries in one object under `field`, by
/// key (since 0.6.4 also the share records, shares.rs): an entry changed on one side since the
/// last sync takes that change; changed on both, the newer file's entry.
pub fn merge_keyed(base: Option<&[u8]>, local: &[u8], remote: &[u8], local_wins: bool, field: &str, max: usize) -> Option<Vec<u8>> {
    let (local_rest, local_icons) = entries_of(local, field, max)?;
    let (remote_rest, remote_icons) = entries_of(remote, field, max)?;
    let base_icons = base.and_then(|b| entries_of(b, field, max)).map(|(_, icons)| icons).unwrap_or_default();
    let mut merged = Map::new();
    let keys: std::collections::BTreeSet<&String> = local_icons.keys().chain(remote_icons.keys()).collect();
    for key in keys {
        let (b, l, r) = (base_icons.get(key), local_icons.get(key), remote_icons.get(key));
        let chosen = if l == r {
            l
        } else if l == b {
            r
        } else if r == b {
            l
        } else if local_wins {
            // Changed on both sides; a look removed on the newer side stays removed.
            l
        } else {
            r
        };
        if let Some(value) = chosen {
            if merged.len() < max {
                merged.insert(key.clone(), value.clone());
            }
        }
    }
    // Anything else in the file is taken from the newer one.
    let mut whole = if local_wins { local_rest } else { remote_rest };
    whole.insert("format".to_string(), Value::from(FORMAT));
    whole.insert(field.to_string(), Value::Object(merged));
    serde_json::to_vec(&Value::Object(whole)).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn file(icons: &str) -> Vec<u8> {
        format!("{{\"format\":1,\"icons\":{{{icons}}}}}").into_bytes()
    }

    fn icons(text: &[u8]) -> Map<String, Value> {
        icons_of(text).expect("mergeable").1
    }

    #[test]
    fn colours_set_on_one_device_are_kept_when_the_other_has_none() {
        // The case that was seen: a laptop with four coloured folders, a phone with an empty file
        // that was newer. The phone's file used to win whole.
        let laptop = file(r#""Cytology":{"style":"folder","colour":"blue"},"Histology":{"style":"folder","colour":"green"}"#);
        let phone = file("");
        for local_wins in [true, false] {
            let merged = merge(None, &laptop, &phone, local_wins).expect("merge");
            assert_eq!(icons(&merged), icons(&laptop));
        }
    }

    #[test]
    fn a_change_on_one_side_since_the_last_sync_is_taken_and_a_clash_goes_to_the_newer_file() {
        let base = file(r#""A":{"colour":"blue"},"B":{"colour":"red"},"C":{"colour":"teal"}"#);
        // Here: A changed, B removed. There: C changed, D added, A changed too.
        let local = file(r#""A":{"colour":"green"},"C":{"colour":"teal"}"#);
        let remote = file(r#""A":{"colour":"yellow"},"B":{"colour":"red"},"C":{"colour":"silver"},"D":{"colour":"apple"}"#);
        let merged = icons(&merge(Some(&base), &local, &remote, true).expect("merge"));
        assert_eq!(merged.get("A"), Some(&serde_json::json!({"colour": "green"})), "both changed: the newer side");
        assert_eq!(merged.get("B"), None, "removed here, unchanged there: removed");
        assert_eq!(merged.get("C"), Some(&serde_json::json!({"colour": "silver"})));
        assert_eq!(merged.get("D"), Some(&serde_json::json!({"colour": "apple"})));
        let other_way = icons(&merge(Some(&base), &local, &remote, false).expect("merge"));
        assert_eq!(other_way.get("A"), Some(&serde_json::json!({"colour": "yellow"})));
    }

    #[test]
    fn a_file_that_cannot_be_merged_falls_back_to_the_newer_file() {
        let good = file(r#""A":{"colour":"blue"}"#);
        for bad in [&b"not json"[..], b"{\"format\":2,\"icons\":{}}", b"{\"format\":1}", b"[1,2]", b"{\"format\":1,\"icons\":[]}"] {
            assert!(merge(None, &good, bad, true).is_none());
            assert!(merge(None, bad, &good, false).is_none());
        }
        // A damaged base only means "no history": the looks are joined.
        let merged = merge(Some(b"junk"), &good, &file(r#""B":{"colour":"red"}"#), true).expect("merge");
        assert_eq!(icons(&merged).len(), 2);
    }
}
