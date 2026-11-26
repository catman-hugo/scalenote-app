//! Things shared into ScaleNote from other apps, the clipboard or a file manager (0.6.6), turned
//! into page content.
//!
//! What arrives is untrusted: text from any app, links of any kind, files of any name and size.
//! So everything is checked here, the same way for every road it came by:
//! - text is at most `MAX_TEXT_BYTES`, made of valid UTF-8 (other bytes are refused, not changed),
//!   with line ends made plain; it is written as it is, so it stays exactly the shared words;
//! - a link is only made a link when it is `http`, `https` or `mailto`, at most `MAX_URL_CHARS`,
//!   with no spaces or brackets that could end the markdown early; anything else stays text;
//! - a file is only taken when its bytes really are a picture or a PDF (attachments.rs, which also
//!   sets the size limits), or a markdown or text file that is valid UTF-8; its name is only a
//!   suggestion, cleaned before use; anything else is refused and said so;
//! - at most `MAX_ITEMS` things at once.
//! Nothing shared is ever run or opened by another program.
//!
//! Where it goes: a new page in a folder (by default `Inbox`), or the end of an existing page.
//! A new page never replaces one (the name gets a number), and adding to a page checks that the
//! page did not change in between (`write_note` with the version read), so nothing is lost.

use crate::attachments::{detect_image, detect_pdf};
use crate::names::sanitize_name;
use crate::vault::{Result, Vault, VaultError};
use std::fs;

/// The folder that shared things go to unless another place was chosen in Settings.
pub const DEFAULT_INBOX: &str = "Inbox";
pub const MAX_TEXT_BYTES: usize = 1024 * 1024;
pub const MAX_URL_CHARS: usize = 2000;
pub const MAX_ITEMS: usize = 50;
/// A page title made from shared text is at most this long.
const MAX_TITLE_CHARS: usize = 80;

/// One shared thing.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Item {
    Text(String),
    Link { url: String, title: Option<String> },
    File { name: String, bytes: Vec<u8> },
}

/// Where shared things go.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Target {
    /// A new page in this folder (made when missing).
    NewPageIn(String),
    /// The end of this page.
    EndOf(String),
}

#[derive(Debug, Default, PartialEq, Eq)]
pub struct Added {
    /// The page that now holds the shared things.
    pub page: String,
    /// Things that could not be added: their name (or "text") and a short reason code.
    pub refused: Vec<(String, &'static str)>,
}

/// Whether `url` may become a link: a known safe kind, no spaces, nothing that ends markdown.
pub fn link_ok(url: &str) -> bool {
    let lower = url.to_ascii_lowercase();
    let kind_ok = lower.starts_with("https://") || lower.starts_with("http://") || lower.starts_with("mailto:");
    kind_ok && url.chars().count() <= MAX_URL_CHARS && url.len() > 8 && !url.chars().any(|c| c.is_whitespace() || c.is_control() || matches!(c, '<' | '>' | '(' | ')' | '[' | ']' | '"' | '`'))
}

/// What other apps share as text: a link alone becomes a link (titled by the subject the app
/// gave, if any); anything else is text, with the subject as its first line when it is not
/// already in the text.
pub fn from_shared_text(text: &str, subject: Option<&str>) -> Item {
    let trimmed = text.trim();
    let subject = subject.map(clean_line).filter(|s| !s.is_empty());
    if link_ok(trimmed) {
        return Item::Link { url: trimmed.to_string(), title: subject };
    }
    match subject {
        Some(subject) if !trimmed.contains(subject.as_str()) => Item::Text(format!("{subject}\n\n{trimmed}")),
        _ => Item::Text(trimmed.to_string()),
    }
}

/// One line of text with control characters and markdown brackets taken out, cut to a length.
fn clean_line(text: &str) -> String {
    let flat: String = text.chars().map(|c| if c.is_control() || matches!(c, '[' | ']') { ' ' } else { c }).collect();
    let words: Vec<&str> = flat.split_whitespace().collect();
    words.join(" ").chars().take(MAX_TITLE_CHARS * 2).collect()
}

/// The markdown for a link.
fn link_markdown(url: &str, title: Option<&str>) -> String {
    match title.map(clean_line).filter(|t| !t.is_empty()) {
        Some(title) => format!("[{title}]({url})"),
        None => format!("<{url}>"),
    }
}

/// Text with Windows and old Mac line ends made plain.
fn plain_lines(text: &str) -> String {
    text.replace("\r\n", "\n").replace('\r', "\n")
}

/// A title for a new page: the first words of the first thing shared.
fn title_for(items: &[Item]) -> String {
    let raw = match items.first() {
        Some(Item::Text(text)) => text.lines().map(str::trim).find(|l| !l.is_empty()).unwrap_or("").trim_start_matches('#').to_string(),
        Some(Item::Link { title: Some(title), .. }) => title.clone(),
        Some(Item::Link { url, .. }) => url.split("://").nth(1).unwrap_or(url).split('/').next().unwrap_or("").to_string(),
        Some(Item::File { name, .. }) => base_name(name).rsplit_once('.').map_or(base_name(name), |(stem, _)| stem).to_string(),
        None => String::new(),
    };
    let cut: String = clean_line(&raw).chars().take(MAX_TITLE_CHARS).collect();
    sanitize_name(cut.trim(), "Shared")
}

/// The last part of a file name that may come with folders (`a/b/c.png` is `c.png`).
fn base_name(name: &str) -> &str {
    name.rsplit(['/', '\\']).next().unwrap_or(name)
}

/// Whether a file name says it is markdown or plain text.
fn is_text_name(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    lower.ends_with(".md") || lower.ends_with(".markdown") || lower.ends_with(".txt")
}

impl Vault {
    /// Adds shared things to `target` and returns the page they are in, with what was refused.
    /// When nothing at all could be added, no page is made and the first reason is the error.
    pub fn add_shared(&self, target: &Target, items: Vec<Item>) -> Result<Added> {
        if items.is_empty() {
            return Err(VaultError::InvalidPath);
        }
        let mut parts: Vec<String> = Vec::new();
        let mut refused = Vec::new();
        for item in items.iter().take(MAX_ITEMS) {
            match self.markdown_for(item) {
                Ok(text) if !text.trim().is_empty() => parts.push(text),
                Ok(_) => refused.push((label(item), "empty")),
                Err(error) => refused.push((label(item), reason(&error))),
            }
        }
        for item in items.iter().skip(MAX_ITEMS) {
            refused.push((label(item), "too_many"));
        }
        if parts.is_empty() {
            return Err(match refused.first().map(|(_, r)| *r) {
                Some("too_large") => VaultError::TooLarge,
                Some("not_utf8") => VaultError::NotUtf8,
                _ => VaultError::UnsupportedType,
            });
        }
        let added = parts.join("\n\n");
        let page = match target {
            Target::NewPageIn(folder) => {
                self.ensure_folder(folder)?;
                let page = self.create_note(folder, &title_for(&items))?;
                self.write_note(&page, &format!("{added}\n"), Some(crate::vault::NoteVersion::of(b"")))?;
                page
            }
            Target::EndOf(page) => {
                let current = self.read_note(page)?;
                let joined = if current.text.trim().is_empty() {
                    format!("{added}\n")
                } else {
                    format!("{}\n\n{added}\n", current.text.trim_end_matches(['\n', '\r']))
                };
                self.write_note(page, &joined, Some(current.version))?;
                page.clone()
            }
        };
        Ok(Added { page, refused })
    }

    /// The markdown one shared thing becomes. Pictures and PDFs are saved in `attachments/`.
    fn markdown_for(&self, item: &Item) -> Result<String> {
        match item {
            Item::Text(text) => {
                if text.len() > MAX_TEXT_BYTES {
                    return Err(VaultError::TooLarge);
                }
                Ok(plain_lines(text).trim().to_string())
            }
            Item::Link { url, title } if link_ok(url) => Ok(link_markdown(url, title.as_deref())),
            Item::Link { url, .. } => Ok(url.chars().take(MAX_URL_CHARS).collect::<String>().trim().to_string()),
            Item::File { name, bytes } => {
                if detect_image(bytes).is_some() || detect_pdf(bytes) {
                    let path = self.write_attachment(name, bytes)?;
                    let base = base_name(name);
                    let alt = clean_line(base.rsplit_once('.').map_or(base, |(stem, _)| stem));
                    return Ok(format!("![{}]({path})", alt.replace('|', " ")));
                }
                if is_text_name(name) {
                    if bytes.len() > MAX_TEXT_BYTES {
                        return Err(VaultError::TooLarge);
                    }
                    let text = std::str::from_utf8(bytes).map_err(|_| VaultError::NotUtf8)?;
                    return Ok(plain_lines(text).trim().to_string());
                }
                Err(VaultError::UnsupportedType)
            }
        }
    }

    /// Makes `folder` (and the folders above it) when missing. Only inside the notes folder.
    fn ensure_folder(&self, folder: &str) -> Result<()> {
        let path = self.resolve(folder)?;
        if path.is_dir() {
            return self.ensure_inside(&path);
        }
        self.ensure_inside(&path)?;
        fs::create_dir_all(&path)?;
        self.ensure_inside(&path)
    }
}

fn label(item: &Item) -> String {
    match item {
        Item::Text(_) => "text".to_string(),
        Item::Link { url, .. } => url.chars().take(80).collect(),
        Item::File { name, .. } => clean_line(base_name(name)),
    }
}

/// The short reason code the interface turns into a sentence.
fn reason(error: &VaultError) -> &'static str {
    match error {
        VaultError::TooLarge => "too_large",
        VaultError::UnsupportedType => "unsupported",
        VaultError::NotUtf8 => "not_utf8",
        _ => "failed",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn vault(name: &str) -> (Vault, std::path::PathBuf) {
        let dir = std::env::temp_dir().join(format!("sn-capture-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).expect("dir");
        (Vault::open(&dir).expect("vault"), dir)
    }

    const PNG: &[u8] = b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR\0\0\0\x01\0\0\0\x01\x08\x06\0\0\0\x1f\x15\xc4\x89\0\0\0\rIDATx\x9cc\xf8\xff\xff?\0\x05\xfe\x02\xfe\xa7\x35\x81\x84\0\0\0\0IEND\xaeB`\x82";

    #[test]
    fn shared_text_and_links_become_a_new_page_in_the_inbox() {
        let (v, dir) = vault("new");
        let items = vec![from_shared_text("https://example.org/cells?a=1", Some("Cell walls")), from_shared_text("Notes from the lecture\r\nline two", None)];
        let added = v.add_shared(&Target::NewPageIn(DEFAULT_INBOX.into()), items).expect("added");
        assert_eq!(added.page, "Inbox/Cell walls.md");
        assert!(added.refused.is_empty());
        assert_eq!(fs::read_to_string(dir.join(&added.page)).expect("page"), "[Cell walls](https://example.org/cells?a=1)\n\nNotes from the lecture\nline two\n");
        // The same title again gets a number; nothing is replaced.
        let again = v.add_shared(&Target::NewPageIn(DEFAULT_INBOX.into()), vec![from_shared_text("https://example.org/x", Some("Cell walls"))]).expect("again");
        assert_eq!(again.page, "Inbox/Cell walls 2.md");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn only_safe_links_become_links() {
        assert!(link_ok("https://example.org/page?x=1#top"));
        assert!(link_ok("mailto:alice@example.local"));
        for bad in ["javascript:alert(1)", "file:///etc/passwd", "https://example.org/a b", "https://example.org/a)b", "https://", "data:text/html,hi", "HTTPS://example.org/\u{0}"] {
            assert!(!link_ok(bad), "{bad}");
        }
        assert_eq!(from_shared_text("javascript:alert(1)", Some("click")), Item::Text("click\n\njavascript:alert(1)".into()));
        assert_eq!(link_markdown("https://example.org", Some("a [b] \n c")), "[a b c](https://example.org)");
    }

    #[test]
    fn pictures_pdfs_and_markdown_files_are_taken_and_other_files_are_refused() {
        let (v, dir) = vault("files");
        let pdf = b"%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n".to_vec();
        let items = vec![
            Item::File { name: "Cell (1).png".into(), bytes: PNG.to_vec() },
            Item::File { name: "../../scan.pdf".into(), bytes: pdf },
            Item::File { name: "lecture.md".into(), bytes: b"# Lecture\n\nmembranes".to_vec() },
            Item::File { name: "virus.exe".into(), bytes: b"MZ\x90\0".to_vec() },
            Item::File { name: "fake.png".into(), bytes: b"not a picture".to_vec() },
            Item::File { name: "latin1.txt".into(), bytes: vec![0xe9, 0x74, 0xe9] },
        ];
        let added = v.add_shared(&Target::NewPageIn("Inbox/Week 1".into()), items).expect("added");
        assert_eq!(added.page, "Inbox/Week 1/Cell (1).md");
        let text = fs::read_to_string(dir.join(&added.page)).expect("page");
        assert_eq!(text, "![Cell (1)](attachments/Cell-1.png)\n\n![scan](attachments/scan.pdf)\n\n# Lecture\n\nmembranes\n");
        assert_eq!(added.refused, vec![("virus.exe".to_string(), "unsupported"), ("fake.png".to_string(), "unsupported"), ("latin1.txt".to_string(), "not_utf8")]);
        assert!(dir.join("attachments/Cell-1.png").is_file() && dir.join("attachments/scan.pdf").is_file());
        assert!(!dir.join("scan.pdf").exists() && !std::path::Path::new(&dir).join("../scan.pdf").exists());
        // Nothing usable: no page is made.
        assert!(v.add_shared(&Target::NewPageIn("Inbox".into()), vec![Item::File { name: "a.exe".into(), bytes: vec![1, 2] }]).is_err());
        assert!(!dir.join("Inbox/a.md").exists());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn adding_to_a_page_keeps_what_is_there_and_never_leaves_the_notes_folder() {
        let (v, dir) = vault("append");
        fs::write(dir.join("Plan.md"), "Monday\n\n\n").expect("page");
        let added = v.add_shared(&Target::EndOf("Plan.md".into()), vec![Item::Text("Tuesday".into())]).expect("added");
        assert_eq!(added.page, "Plan.md");
        assert_eq!(fs::read_to_string(dir.join("Plan.md")).expect("page"), "Monday\n\nTuesday\n");
        for bad in [Target::EndOf("../outside.md".into()), Target::EndOf("Missing.md".into()), Target::NewPageIn("../out".into()), Target::NewPageIn(".scalenote".into())] {
            assert!(v.add_shared(&bad, vec![Item::Text("x".into())]).is_err(), "{bad:?}");
        }
        assert!(v.add_shared(&Target::EndOf("Plan.md".into()), vec![Item::Text("x".repeat(MAX_TEXT_BYTES + 1))]).is_err());
        assert!(v.add_shared(&Target::EndOf("Plan.md".into()), vec![]).is_err());
        let many: Vec<Item> = (0..MAX_ITEMS + 3).map(|n| Item::Text(format!("line {n}"))).collect();
        let added = v.add_shared(&Target::NewPageIn("Inbox".into()), many).expect("added");
        assert_eq!(added.refused.len(), 3);
        assert!(added.refused.iter().all(|(_, r)| *r == "too_many"));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn page_titles_come_from_the_first_thing_shared() {
        assert_eq!(title_for(&[Item::Text("\n\n# Cell walls: why?\nmore".into())]), "Cell walls why");
        assert_eq!(title_for(&[Item::Link { url: "https://example.org/a/b".into(), title: None }]), "example.org");
        assert_eq!(title_for(&[Item::File { name: "scan.pdf".into(), bytes: vec![] }]), "scan");
        assert_eq!(title_for(&[Item::Text("   ".into())]), "Shared");
        assert!(title_for(&[Item::Text("w".repeat(500))]).chars().count() <= MAX_TITLE_CHARS);
    }
}
