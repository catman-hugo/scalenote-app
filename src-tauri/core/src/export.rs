//! Taking one page out of the vault as plain markdown.
//!
//! The result is a new folder with the page (colours turned into what other programs show, the
//! same conversion as the Obsidian copy) and the pictures the page uses, so the folder can be
//! moved or sent as it is. Like the Obsidian copy, nothing about the destination comes from
//! the interface: the folder always lands beside the notes folder under a fixed name, and
//! nothing that exists there is ever replaced.

use crate::atomic::write_atomic;
use crate::attachments::{limit_for, ATTACHMENT_DIR, MAX_PDF_BYTES};
use crate::names::sanitize_name;
use crate::obsidian::{reserve_folder, to_obsidian};
use crate::vault::{Result, Vault, VaultError};
use std::fs;
use std::path::PathBuf;

/// A page cannot name more pictures than this; the rest are left out and counted as missing.
const MAX_PICTURES: usize = 200;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PageExport {
    /// The new folder holding the page.
    pub path: PathBuf,
    /// Pictures copied.
    pub pictures: usize,
    /// Pictures the page names that could not be copied (missing, not a picture, too big).
    pub missing: usize,
    /// Whether the page's drawing was written as a picture too.
    pub drawing: bool,
}

/// The name of the picture of the page's drawing, inside `attachments/` of the export folder.
const DRAWING_NAME: &str = "drawing.png";

/// The file names in `](attachments/NAME)` links, each once, in order. Only plain names are
/// accepted: no folders, no `..`, nothing that could point outside `attachments/`.
fn picture_names(text: &str) -> Vec<String> {
    let marker = format!("]({ATTACHMENT_DIR}/");
    let mut names: Vec<String> = Vec::new();
    let mut rest = text;
    while let Some(at) = rest.find(&marker) {
        rest = &rest[at + marker.len()..];
        let Some(end) = rest.find(')') else { break };
        let name = &rest[..end];
        let plain = !name.is_empty()
            && name.len() <= 255
            && !name.starts_with('.')
            && !name.chars().any(|c| matches!(c, '/' | '\\' | '<' | '>' | '"' | '\n' | '\r' | ' ' | '(' | ':'));
        if plain && !names.iter().any(|n| n == name) {
            names.push(name.to_string());
        }
    }
    names
}

/// Reads one picture or PDF from the vault, only if it is a real file (not a link) of an allowed type.
fn read_picture(vault: &Vault, name: &str) -> Option<Vec<u8>> {
    let path = vault.resolve(&format!("{ATTACHMENT_DIR}/{name}")).ok()?;
    let meta = fs::symlink_metadata(&path).ok()?;
    if !meta.is_file() || meta.len() > MAX_PDF_BYTES as u64 {
        return None;
    }
    let bytes = fs::read(&path).ok()?;
    // A picture or a PDF, each within its own size limit.
    if bytes.len() > limit_for(&bytes)? {
        return None;
    }
    Some(bytes)
}

impl Vault {
    /// Writes `relative` and its pictures into a new folder inside "<notes folder> (exports)",
    /// next to the notes folder. If anything fails half way the new folder is removed again.
    ///
    /// `drawing` is a PNG picture of the page's drawing, made by the interface (it has the
    /// painting code). It is only written if it really is a PNG of an allowed size; a page whose
    /// picture is refused is still exported, without it. Ink drawn over the text is not in it:
    /// markdown has no place to put ink over words, so that ink is only printed.
    pub fn export_page(&self, relative: &str, drawing: Option<&[u8]>) -> Result<PageExport> {
        let note = self.read_note(relative)?;
        let root = self.root();
        let parent = root.parent().ok_or(VaultError::InvalidPath)?;
        let base = root
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .filter(|n| !n.is_empty())
            .unwrap_or_else(|| "ScaleNote".to_string());
        let exports = parent.join(format!("{base} (exports)"));
        match fs::create_dir(&exports) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                // Reuse it only if it is a real folder, never a link or a file.
                let meta = fs::symlink_metadata(&exports)?;
                if !meta.is_dir() {
                    return Err(VaultError::InvalidPath);
                }
            }
            Err(error) => return Err(error.into()),
        }
        let stem = relative.rsplit('/').next().unwrap_or(relative).trim_end_matches(".md");
        let title = sanitize_name(stem, "Page");
        let dest = reserve_folder(&exports, &title)?;
        match write_page(self, &dest, &title, &note.text, drawing) {
            Ok((pictures, missing, drawn)) => Ok(PageExport { path: dest, pictures, missing, drawing: drawn }),
            Err(error) => {
                // The folder was made by this call and holds only what this call wrote.
                let _ = fs::remove_dir_all(&dest);
                Err(error)
            }
        }
    }
}

/// True for a PNG of a size the vault would accept as a picture.
fn is_drawing_picture(bytes: &[u8]) -> bool {
    bytes.starts_with(&[0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a]) && limit_for(bytes).is_some_and(|limit| bytes.len() <= limit)
}

fn write_page(vault: &Vault, dest: &std::path::Path, title: &str, text: &str, drawing: Option<&[u8]>) -> Result<(usize, usize, bool)> {
    let picture = drawing.filter(|bytes| is_drawing_picture(bytes));
    let names = picture_names(text);
    // A name no picture of the page already has, so the drawing never replaces one of them.
    let drawing_name = (1..)
        .map(|n| if n == 1 { DRAWING_NAME.to_string() } else { format!("drawing-{n}.png") })
        .find(|candidate| !names.contains(candidate))
        .unwrap_or_else(|| DRAWING_NAME.to_string());
    let mut page = to_obsidian(text);
    if picture.is_some() {
        // The drawing goes at the end of the exported page, as an ordinary picture.
        if !page.ends_with('\n') {
            page.push('\n');
        }
        page.push_str(&format!("\n![Drawing]({ATTACHMENT_DIR}/{drawing_name})\n"));
    }
    write_atomic(&dest.join(format!("{title}.md")), page.as_bytes())?;
    let mut missing = names.len().saturating_sub(MAX_PICTURES);
    let mut pictures = 0;
    for name in names.iter().take(MAX_PICTURES) {
        match read_picture(vault, name) {
            Some(bytes) => {
                let dir = dest.join(ATTACHMENT_DIR);
                fs::create_dir_all(&dir)?;
                write_atomic(&dir.join(name), &bytes)?;
                pictures += 1;
            }
            None => missing += 1,
        }
    }
    let mut drawn = false;
    if let Some(bytes) = picture {
        let dir = dest.join(ATTACHMENT_DIR);
        fs::create_dir_all(&dir)?;
        write_atomic(&dir.join(&drawing_name), bytes)?;
        drawn = true;
    }
    Ok((pictures, missing, drawn))
}

#[cfg(test)]
mod tests {
    use super::*;

    const PNG: [u8; 8] = [0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a];

    fn setup(name: &str) -> (PathBuf, Vault) {
        let parent = std::env::temp_dir().join(format!("sn-export-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&parent);
        let root = parent.join("Notes");
        fs::create_dir_all(root.join("attachments")).expect("attachments");
        fs::create_dir_all(root.join("sub")).expect("sub");
        let vault = Vault::open(&root).expect("open");
        (parent, vault)
    }

    #[test]
    fn names_are_plain_and_unique() {
        let text = "![a](attachments/one.png) ![b](attachments/one.png) ![c](attachments/../x.png) ![d](attachments/sub/y.png) ![e](attachments/.hid.png) ![f](attachments/two.jpg)";
        assert_eq!(picture_names(text), vec!["one.png".to_string(), "two.jpg".to_string()]);
    }

    #[test]
    fn the_page_and_its_pictures_land_beside_the_notes_folder() {
        let (parent, vault) = setup("basic");
        let root = parent.join("Notes");
        fs::write(root.join("sub").join("Plan.md"), "a <span class=\"sn-bg-red\">x</span>\n![p](attachments/p.png)\n![gone](attachments/gone.png)\n").expect("note");
        fs::write(root.join("attachments").join("p.png"), PNG).expect("png");
        let report = vault.export_page("sub/Plan.md", None).expect("export");
        assert_eq!((report.pictures, report.missing), (1, 1));
        assert_eq!(report.path.parent().and_then(|p| p.file_name()).and_then(|n| n.to_str()), Some("Notes (exports)"));
        let text = fs::read_to_string(report.path.join("Plan.md")).expect("page");
        assert!(text.starts_with("a ==x==\n"));
        assert_eq!(fs::read(report.path.join("attachments").join("p.png")).expect("png"), PNG);
        // The vault is untouched.
        assert!(fs::read_to_string(root.join("sub").join("Plan.md")).expect("source").contains("sn-bg-red"));
    }

    #[test]
    fn a_second_export_gets_a_new_folder_and_nothing_is_replaced() {
        let (parent, vault) = setup("twice");
        fs::write(parent.join("Notes").join("A.md"), "one\n").expect("note");
        let first = vault.export_page("A.md", None).expect("first");
        fs::write(first.path.join("A.md"), "edited by hand\n").expect("edit");
        let second = vault.export_page("A.md", None).expect("second");
        assert_ne!(first.path, second.path);
        assert_eq!(fs::read_to_string(first.path.join("A.md")).expect("first page"), "edited by hand\n");
    }

    #[test]
    fn hostile_page_paths_and_non_pictures_are_refused() {
        let (parent, vault) = setup("hostile");
        let root = parent.join("Notes");
        fs::write(parent.join("outside.md"), "secret\n").expect("outside");
        assert!(vault.export_page("../outside.md", None).is_err());
        assert!(vault.export_page("missing.md", None).is_err());
        assert!(vault.export_page("notes.txt", None).is_err());
        // A "picture" that is really text is not copied.
        fs::write(root.join("attachments").join("fake.png"), "not a picture").expect("fake");
        fs::write(root.join("B.md"), "![x](attachments/fake.png)\n").expect("note");
        let report = vault.export_page("B.md", None).expect("export");
        assert_eq!((report.pictures, report.missing), (0, 1));
        assert!(!report.path.join("attachments").exists());
    }

    #[cfg(unix)]
    #[test]
    fn a_link_in_attachments_is_not_followed() {
        let (parent, vault) = setup("link");
        let root = parent.join("Notes");
        fs::write(parent.join("secret.png"), PNG).expect("secret");
        std::os::unix::fs::symlink(parent.join("secret.png"), root.join("attachments").join("l.png")).expect("link");
        fs::write(root.join("C.md"), "![x](attachments/l.png)\n").expect("note");
        let report = vault.export_page("C.md", None).expect("export");
        assert_eq!((report.pictures, report.missing), (0, 1));
    }

    #[cfg(unix)]
    #[test]
    fn an_exports_folder_that_is_a_link_is_refused() {
        let (parent, vault) = setup("exportslink");
        fs::create_dir_all(parent.join("elsewhere")).expect("elsewhere");
        std::os::unix::fs::symlink(parent.join("elsewhere"), parent.join("Notes (exports)")).expect("link");
        fs::write(parent.join("Notes").join("D.md"), "x\n").expect("note");
        assert!(vault.export_page("D.md", None).is_err());
        assert_eq!(fs::read_dir(parent.join("elsewhere")).expect("dir").count(), 0);
    }

    fn tiny_png() -> Vec<u8> {
        let mut bytes = PNG.to_vec();
        bytes.extend_from_slice(b"rest of a picture");
        bytes
    }

    #[test]
    fn the_drawing_picture_is_written_and_linked_at_the_end_of_the_page() {
        let (parent, vault) = setup("drawing");
        fs::write(parent.join("Notes").join("D1.md"), "text\n").expect("note");
        let report = vault.export_page("D1.md", Some(&tiny_png())).expect("export");
        assert!(report.drawing);
        assert_eq!(fs::read(report.path.join("attachments").join("drawing.png")).expect("drawing"), tiny_png());
        assert_eq!(fs::read_to_string(report.path.join("D1.md")).expect("page"), "text\n\n![Drawing](attachments/drawing.png)\n");
    }

    #[test]
    fn a_drawing_that_is_not_a_png_is_left_out_and_the_page_is_still_exported() {
        let (parent, vault) = setup("notpng");
        fs::write(parent.join("Notes").join("D2.md"), "text\n").expect("note");
        let report = vault.export_page("D2.md", Some(b"<script>alert(1)</script>")).expect("export");
        assert!(!report.drawing);
        assert_eq!(fs::read_to_string(report.path.join("D2.md")).expect("page"), "text\n");
        assert!(!report.path.join("attachments").exists());
        let mut big = PNG.to_vec();
        big.resize(MAX_PDF_BYTES, 0);
        let again = vault.export_page("D2.md", Some(&big)).expect("export again");
        assert!(!again.drawing, "a picture over the size limit is refused");
    }

    #[test]
    fn the_drawing_never_replaces_a_picture_of_the_page_with_the_same_name() {
        let (parent, vault) = setup("samename");
        let root = parent.join("Notes");
        fs::write(root.join("attachments").join("drawing.png"), PNG).expect("own picture");
        fs::write(root.join("D3.md"), "![mine](attachments/drawing.png)\n").expect("note");
        let report = vault.export_page("D3.md", Some(&tiny_png())).expect("export");
        assert_eq!(fs::read(report.path.join("attachments").join("drawing.png")).expect("own"), PNG);
        assert_eq!(fs::read(report.path.join("attachments").join("drawing-2.png")).expect("drawing"), tiny_png());
        assert!(fs::read_to_string(report.path.join("D3.md")).expect("page").ends_with("![Drawing](attachments/drawing-2.png)\n"));
    }
}
