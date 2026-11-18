//! The add-only inbox: a folder where scripts on the server can drop notes, without ever being
//! able to open, change or delete a note in the vault.
//!
//! How it stays add-only. The script's user may write to the inbox folder only; it has no access
//! to the vault. The server (its own user) moves each accepted file into the vault's `Inbox`
//! folder under a name that is not taken yet, so nothing in the vault is ever overwritten. A file
//! is accepted only if it is a plain, small, text markdown file; everything else is put aside in
//! `.rejected` inside the inbox, so it is not looked at again and nothing is lost.

use crate::atomic::write_atomic;
use crate::names::sanitize_name;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

/// Where accepted notes land, inside the vault.
pub const VAULT_INBOX_FOLDER: &str = "Inbox";
const REJECTED: &str = ".rejected";
/// A note from a script is a note, not a data dump.
pub const MAX_NOTE_BYTES: u64 = 1024 * 1024;
/// At most this many files are handled in one pass, so a flood cannot hold the server up.
const MAX_PER_PASS: usize = 200;
/// The vault's Inbox folder never grows past this many entries through this road.
const MAX_IN_VAULT_INBOX: usize = 5000;
const MAX_REJECTED: usize = 100;
/// A file touched more recently than this may still be being written by the script.
const SETTLE: Duration = Duration::from_secs(2);

#[derive(Debug, Default, PartialEq)]
pub struct Report {
    /// Names (as stored in the vault) of the notes that were added.
    pub added: Vec<String>,
    /// How many files were put aside, and the short reason for each.
    pub rejected: Vec<(String, &'static str)>,
}

/// One pass over the inbox. Never fails as a whole: a problem with one file only concerns that file.
pub fn take(inbox: &Path, vault: &Path) -> Report {
    take_at(inbox, vault, SystemTime::now())
}

pub(crate) fn take_at(inbox: &Path, vault: &Path, now: SystemTime) -> Report {
    let mut report = Report::default();
    let Ok(entries) = fs::read_dir(inbox) else { return report };
    let target_dir = vault.join(VAULT_INBOX_FOLDER);
    let mut handled = 0;
    for entry in entries.flatten() {
        if handled >= MAX_PER_PASS {
            break;
        }
        let raw_name = entry.file_name();
        let Some(name) = raw_name.to_str().map(str::to_string) else { continue };
        // Hidden files are how a script says "still writing": write `.name.tmp`, then rename.
        if name.starts_with('.') {
            continue;
        }
        let path = entry.path();
        // symlink_metadata: a link is never followed, so a script cannot make the server read a file elsewhere.
        let Ok(meta) = fs::symlink_metadata(&path) else { continue };
        if meta.is_dir() {
            continue;
        }
        if let Ok(modified) = meta.modified() {
            if now.duration_since(modified).map_or(true, |age| age < SETTLE) {
                continue;
            }
        }
        handled += 1;
        match accept(&path, &name, &meta, &target_dir) {
            Ok(stored) => {
                let _ = fs::remove_file(&path);
                report.added.push(stored);
            }
            Err(reason) => {
                put_aside(inbox, &path, &name);
                report.rejected.push((name, reason));
            }
        }
    }
    report
}

fn accept(path: &Path, name: &str, meta: &fs::Metadata, target_dir: &Path) -> Result<String, &'static str> {
    if !meta.is_file() {
        return Err("not a plain file");
    }
    if meta.len() > MAX_NOTE_BYTES {
        return Err("too big");
    }
    let stem = name.strip_suffix(".md").ok_or("not a .md file")?;
    let bytes = fs::read(path).map_err(|_| "cannot be read")?;
    if bytes.len() as u64 > MAX_NOTE_BYTES {
        return Err("too big");
    }
    let text = std::str::from_utf8(&bytes).map_err(|_| "not text")?;
    if text.contains('\0') {
        return Err("not text");
    }
    fs::create_dir_all(target_dir).map_err(|_| "the vault cannot be written")?;
    if fs::read_dir(target_dir).map_or(0, |d| d.count()) >= MAX_IN_VAULT_INBOX {
        return Err("the vault's Inbox is full");
    }
    let stem = sanitize_name(stem, "Note");
    let stored = free_name(target_dir, &stem).ok_or("no free name")?;
    write_atomic(&target_dir.join(&stored), bytes.as_slice()).map_err(|_| "the vault cannot be written")?;
    Ok(stored)
}

/// `Note.md`, or `Note 2.md`, `Note 3.md`... whichever is free. An existing note is never replaced.
fn free_name(dir: &Path, stem: &str) -> Option<String> {
    let first = format!("{stem}.md");
    if !dir.join(&first).exists() {
        return Some(first);
    }
    (2..1000).map(|n| format!("{stem} {n}.md")).find(|candidate| !dir.join(candidate).exists())
}

fn put_aside(inbox: &Path, path: &Path, name: &str) {
    let folder: PathBuf = inbox.join(REJECTED);
    if fs::create_dir_all(&folder).is_err() || fs::read_dir(&folder).map_or(0, |d| d.count()) >= MAX_REJECTED {
        return;
    }
    let target = free_name_any(&folder, name);
    let _ = fs::rename(path, target);
}

fn free_name_any(dir: &Path, name: &str) -> PathBuf {
    if !dir.join(name).exists() {
        return dir.join(name);
    }
    (2..1000).map(|n| dir.join(format!("{n}-{name}"))).find(|p| !p.exists()).unwrap_or_else(|| dir.join(format!("x-{name}")))
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Dir(PathBuf);
    impl Dir {
        fn new(label: &str) -> Dir {
            let path = std::env::temp_dir().join(format!("sn-inbox-{label}-{}", std::process::id()));
            let _ = fs::remove_dir_all(&path);
            fs::create_dir_all(path.join("inbox")).expect("inbox");
            fs::create_dir_all(path.join("vault")).expect("vault");
            Dir(path)
        }
        fn inbox(&self) -> PathBuf {
            self.0.join("inbox")
        }
        fn vault(&self) -> PathBuf {
            self.0.join("vault")
        }
    }
    impl Drop for Dir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn later() -> SystemTime {
        SystemTime::now() + Duration::from_secs(60)
    }

    #[test]
    fn a_markdown_note_moves_into_the_vault_inbox_and_leaves_the_script_folder() {
        let d = Dir::new("move");
        fs::write(d.inbox().join("Backup report.md"), "# Done\nall fine\n").expect("write");
        let report = take_at(&d.inbox(), &d.vault(), later());
        assert_eq!(report.added, vec!["Backup report.md"]);
        assert_eq!(fs::read_to_string(d.vault().join("Inbox/Backup report.md")).expect("note"), "# Done\nall fine\n");
        assert!(!d.inbox().join("Backup report.md").exists());
    }

    #[test]
    fn nothing_in_the_vault_is_ever_replaced() {
        let d = Dir::new("nooverwrite");
        fs::create_dir_all(d.vault().join("Inbox")).expect("dir");
        fs::write(d.vault().join("Inbox/A.md"), "mine\n").expect("existing");
        fs::write(d.vault().join("Outside.md"), "untouched\n").expect("outside");
        for _ in 0..3 {
            fs::write(d.inbox().join("A.md"), "from a script\n").expect("write");
            take_at(&d.inbox(), &d.vault(), later());
        }
        assert_eq!(fs::read_to_string(d.vault().join("Inbox/A.md")).expect("kept"), "mine\n");
        for n in ["A 2.md", "A 3.md", "A 4.md"] {
            assert_eq!(fs::read_to_string(d.vault().join("Inbox").join(n)).expect("copy"), "from a script\n");
        }
        assert_eq!(fs::read_to_string(d.vault().join("Outside.md")).expect("outside"), "untouched\n");
    }

    #[test]
    fn only_small_plain_text_markdown_is_taken_and_the_rest_is_put_aside_once() {
        let d = Dir::new("rules");
        fs::write(d.inbox().join("a.txt"), "text\n").expect("txt");
        fs::write(d.inbox().join("b.md"), [0xff, 0xfe, 0x00]).expect("binary");
        fs::write(d.inbox().join("c.md"), "has\0nul").expect("nul");
        fs::write(d.inbox().join("big.md"), vec![b'x'; (MAX_NOTE_BYTES + 1) as usize]).expect("big");
        fs::write(d.inbox().join(".hidden.md"), "still being written\n").expect("hidden");
        fs::create_dir_all(d.inbox().join("folder")).expect("folder");
        fs::write(d.inbox().join("ok.md"), "fine\n").expect("ok");
        let report = take_at(&d.inbox(), &d.vault(), later());
        assert_eq!(report.added, vec!["ok.md"]);
        let mut reasons: Vec<_> = report.rejected.iter().map(|(n, r)| (n.as_str(), *r)).collect();
        reasons.sort();
        assert_eq!(reasons, vec![("a.txt", "not a .md file"), ("b.md", "not text"), ("big.md", "too big"), ("c.md", "not text")]);
        assert!(d.inbox().join(".rejected/a.txt").exists(), "kept, not deleted");
        assert!(d.inbox().join(".hidden.md").exists(), "a script's temporary file is left alone");
        assert!(d.inbox().join("folder").is_dir());
        // A second pass has nothing new to say.
        assert_eq!(take_at(&d.inbox(), &d.vault(), later()), Report::default());
    }

    #[test]
    fn a_file_that_was_just_written_waits_until_it_is_settled() {
        let d = Dir::new("settle");
        fs::write(d.inbox().join("new.md"), "x\n").expect("write");
        assert!(take(&d.inbox(), &d.vault()).added.is_empty(), "too fresh");
        assert_eq!(take_at(&d.inbox(), &d.vault(), later()).added, vec!["new.md"]);
    }

    #[test]
    fn names_with_odd_characters_are_made_safe_and_a_link_is_never_followed() {
        let d = Dir::new("odd");
        fs::write(d.inbox().join("a<b>:c?.md"), "x\n").expect("odd");
        fs::write(d.inbox().join("CON.md"), "y\n").expect("reserved");
        #[cfg(unix)]
        {
            fs::write(d.0.join("secret.md"), "do not read\n").expect("secret");
            std::os::unix::fs::symlink(d.0.join("secret.md"), d.inbox().join("link.md")).expect("link");
        }
        let report = take_at(&d.inbox(), &d.vault(), later());
        assert!(report.added.contains(&"abc.md".to_string()), "{:?}", report.added);
        assert!(report.added.contains(&"CON_.md".to_string()), "{:?}", report.added);
        #[cfg(unix)]
        {
            assert!(!d.vault().join("Inbox/link.md").exists(), "the target of a link is never copied");
            assert!(report.rejected.iter().any(|(n, r)| n == "link.md" && *r == "not a plain file"));
        }
    }

    #[test]
    fn a_missing_inbox_and_a_flood_do_no_harm() {
        let d = Dir::new("flood");
        assert_eq!(take_at(&d.0.join("nope"), &d.vault(), later()), Report::default());
        for i in 0..(MAX_PER_PASS + 30) {
            fs::write(d.inbox().join(format!("n{i}.md")), "x\n").expect("write");
        }
        assert_eq!(take_at(&d.inbox(), &d.vault(), later()).added.len(), MAX_PER_PASS);
        assert_eq!(take_at(&d.inbox(), &d.vault(), later()).added.len(), 30, "the rest follows on the next pass");
    }
}
