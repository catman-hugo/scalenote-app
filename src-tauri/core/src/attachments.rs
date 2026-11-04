//! Pictures that belong to notes. They are copied into the `attachments` folder of the
//! vault and referenced from a note as plain markdown: `![](attachments/name.png)`.
//!
//! What a file *is* is decided by its first bytes, never by its name or by what the
//! interface claims. SVG is refused because it can carry scripts.

use crate::atomic::write_atomic;
use crate::base64;
use crate::vault::{Result, Vault, VaultError};
use std::fs;
use std::path::Path;

/// Name of the folder inside the vault. It is the same for every vault, so notes stay
/// readable by other apps (Obsidian shows `attachments/name.png` from any note).
pub const ATTACHMENT_DIR: &str = "attachments";
/// Largest picture accepted. Bigger files make the app slow and fill the disk.
pub const MAX_ATTACHMENT_BYTES: usize = 10 * 1024 * 1024;
/// The same limit as seen in base64 text (four characters for every three bytes).
pub const MAX_ATTACHMENT_BASE64: usize = MAX_ATTACHMENT_BYTES.div_ceil(3) * 4;
const MAX_STEM_CHARS: usize = 60;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ImageKind {
    Png,
    Jpeg,
    Gif,
    Webp,
}

impl ImageKind {
    pub fn extension(self) -> &'static str {
        match self {
            ImageKind::Png => "png",
            ImageKind::Jpeg => "jpg",
            ImageKind::Gif => "gif",
            ImageKind::Webp => "webp",
        }
    }

    pub fn mime(self) -> &'static str {
        match self {
            ImageKind::Png => "image/png",
            ImageKind::Jpeg => "image/jpeg",
            ImageKind::Gif => "image/gif",
            ImageKind::Webp => "image/webp",
        }
    }
}

/// Recognises the four allowed picture types from their first bytes.
pub fn detect_image(bytes: &[u8]) -> Option<ImageKind> {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some(ImageKind::Png)
    } else if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
        Some(ImageKind::Jpeg)
    } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        Some(ImageKind::Gif)
    } else if bytes.len() >= 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        Some(ImageKind::Webp)
    } else {
        None
    }
}

/// A file name stem that is safe on every system and in a markdown link: only letters,
/// digits, `_` and `-`. Spaces, brackets and parentheses would break the markdown link, and a
/// dot in the middle would look like a second file extension, so they all become `-`.
fn attachment_stem(suggested: &str) -> String {
    let file = suggested.rsplit(['/', '\\']).next().unwrap_or("");
    let without_extension = match file.rfind('.') {
        Some(dot) if dot > 0 => &file[..dot],
        _ => file,
    };
    let mut stem = String::new();
    for ch in without_extension.chars() {
        let keep = ch.is_alphanumeric() || ch == '_' || ch == '-';
        let ch = if keep { ch } else { '-' };
        if ch == '-' && stem.ends_with('-') {
            continue;
        }
        stem.push(ch);
    }
    let stem: String = stem.trim_matches('-').chars().take(MAX_STEM_CHARS).collect();
    let stem = stem.trim_matches('-').to_string();
    if stem.is_empty() {
        "image".to_string()
    } else {
        stem
    }
}

impl Vault {
    /// Copies a picture into `attachments/` and returns its vault-relative path.
    ///
    /// The same picture added twice under the same name is stored once. A different
    /// picture with a taken name gets a number. The write is atomic like a note's.
    pub fn write_attachment(&self, suggested_name: &str, bytes: &[u8]) -> Result<String> {
        if bytes.len() > MAX_ATTACHMENT_BYTES {
            return Err(VaultError::TooLarge);
        }
        let kind = detect_image(bytes).ok_or(VaultError::UnsupportedType)?;
        let dir = self.resolve(ATTACHMENT_DIR)?;
        fs::create_dir_all(&dir)?;
        // Check again now that the folder exists: it could have been a link out of the vault.
        self.ensure_inside(&dir)?;
        let stem = attachment_stem(suggested_name);
        for attempt in 1..=1000 {
            let name = if attempt == 1 { stem.clone() } else { format!("{stem}-{attempt}") };
            let file_name = format!("{name}.{}", kind.extension());
            let path = dir.join(&file_name);
            match fs::symlink_metadata(&path) {
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                    write_atomic(&path, bytes)?;
                    return Ok(format!("{ATTACHMENT_DIR}/{file_name}"));
                }
                Err(error) => return Err(error.into()),
                Ok(meta) if meta.is_file() && meta.len() == bytes.len() as u64 => {
                    if fs::read(&path)? == bytes {
                        return Ok(format!("{ATTACHMENT_DIR}/{file_name}"));
                    }
                }
                Ok(_) => {}
            }
        }
        Err(VaultError::AlreadyExists)
    }

    /// Reads a picture for display and returns it as a `data:` address.
    ///
    /// Only files directly inside `attachments/` are served, and only when their content
    /// really is one of the allowed picture types.
    pub fn read_attachment_data_url(&self, relative: &str) -> Result<String> {
        let name = relative
            .strip_prefix(ATTACHMENT_DIR)
            .and_then(|rest| rest.strip_prefix('/'))
            .ok_or(VaultError::InvalidPath)?;
        let extension = Path::new(name).extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase();
        if name.contains('/') || !["png", "jpg", "jpeg", "gif", "webp"].contains(&extension.as_str()) {
            return Err(VaultError::UnsupportedType);
        }
        let path = self.resolve(relative)?;
        let meta = fs::metadata(&path)?;
        if !meta.is_file() {
            return Err(VaultError::NotFound);
        }
        if meta.len() > MAX_ATTACHMENT_BYTES as u64 {
            return Err(VaultError::TooLarge);
        }
        let bytes = fs::read(&path)?;
        let kind = detect_image(&bytes).ok_or(VaultError::UnsupportedType)?;
        Ok(format!("data:{};base64,{}", kind.mime(), base64::encode(&bytes)))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("sn-attach-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).expect("create scratch dir");
        dir
    }

    fn png(extra: u8) -> Vec<u8> {
        let mut bytes = b"\x89PNG\r\n\x1a\n".to_vec();
        bytes.extend_from_slice(&[0, 0, 0, 13, extra]);
        bytes
    }

    #[test]
    fn picture_types_are_recognised_by_content() {
        assert_eq!(detect_image(&png(0)), Some(ImageKind::Png));
        assert_eq!(detect_image(&[0xFF, 0xD8, 0xFF, 0xE0, 0]), Some(ImageKind::Jpeg));
        assert_eq!(detect_image(b"GIF89a\x01\x00"), Some(ImageKind::Gif));
        assert_eq!(detect_image(b"RIFF\x24\0\0\0WEBPVP8 "), Some(ImageKind::Webp));
        assert_eq!(detect_image(b"RIFF\x24\0\0\0WAVEfmt "), None);
        assert_eq!(detect_image(b"<svg xmlns=\"http://www.w3.org/2000/svg\"></svg>"), None);
        assert_eq!(detect_image(b"<?xml version=\"1.0\"?><svg/>"), None);
        assert_eq!(detect_image(b"#!/bin/sh\necho hi"), None);
        assert_eq!(detect_image(b""), None);
    }

    #[test]
    fn names_become_safe_for_files_and_markdown_links() {
        assert_eq!(attachment_stem("My photo (1).PNG"), "My-photo-1");
        assert_eq!(attachment_stem("../../etc/passwd"), "passwd");
        assert_eq!(attachment_stem("a\\b\\c.png"), "c");
        assert_eq!(attachment_stem(""), "image");
        assert_eq!(attachment_stem("...png"), "image");
        assert_eq!(attachment_stem("[x](y).png"), "x-y");
        assert_eq!(attachment_stem(&"é".repeat(200)).chars().count(), 60);
        assert_eq!(attachment_stem("cel.diagram.v2.webp"), "cel-diagram-v2");
    }

    #[test]
    fn a_picture_is_stored_under_a_safe_name_with_the_real_extension() {
        let dir = scratch("store");
        let vault = Vault::open(&dir).expect("open");
        // The name claims .svg, the content is a PNG: the content decides.
        let path = vault.write_attachment("cell diagram.svg", &png(1)).expect("write");
        assert_eq!(path, "attachments/cell-diagram.png");
        assert_eq!(fs::read(dir.join(&path)).expect("read back"), png(1));
        assert!(fs::read_dir(dir.join("attachments")).expect("list").flatten().all(|e| !e.file_name().to_string_lossy().ends_with(".sn-tmp")));
    }

    #[test]
    fn the_same_picture_twice_is_stored_once_and_a_different_one_gets_a_number() {
        let dir = scratch("dedupe");
        let vault = Vault::open(&dir).expect("open");
        let a = vault.write_attachment("pic.png", &png(1)).expect("a");
        let again = vault.write_attachment("pic.png", &png(1)).expect("again");
        let other = vault.write_attachment("pic.png", &png(2)).expect("other");
        assert_eq!(a, again);
        assert_eq!(other, "attachments/pic-2.png");
        assert_eq!(fs::read_dir(dir.join("attachments")).expect("list").count(), 2);
    }

    #[test]
    fn files_that_are_not_pictures_are_refused_and_nothing_is_written() {
        let dir = scratch("refuse");
        let vault = Vault::open(&dir).expect("open");
        for bad in [&b"<svg onload=alert(1)></svg>"[..], b"plain text", b"", b"MZ\x90\x00"] {
            assert_eq!(vault.write_attachment("x.png", bad), Err(VaultError::UnsupportedType));
        }
        assert!(!dir.join("attachments").exists() || fs::read_dir(dir.join("attachments")).expect("list").count() == 0);
    }

    #[test]
    fn a_picture_over_the_size_limit_is_refused() {
        let dir = scratch("big");
        let vault = Vault::open(&dir).expect("open");
        let mut big = png(0);
        big.resize(MAX_ATTACHMENT_BYTES + 1, 0);
        assert_eq!(vault.write_attachment("big.png", &big), Err(VaultError::TooLarge));
        big.truncate(MAX_ATTACHMENT_BYTES);
        assert!(vault.write_attachment("big.png", &big).is_ok());
    }

    #[test]
    fn a_picture_comes_back_as_a_data_address_and_other_paths_are_refused() {
        let dir = scratch("read");
        let vault = Vault::open(&dir).expect("open");
        let path = vault.write_attachment("pic.png", &png(3)).expect("write");
        let url = vault.read_attachment_data_url(&path).expect("read");
        assert!(url.starts_with("data:image/png;base64,"));
        let encoded = url.trim_start_matches("data:image/png;base64,");
        assert_eq!(base64::decode(encoded), Some(png(3)));
        fs::write(dir.join("secret.png"), png(0)).expect("outside file");
        fs::write(dir.join("attachments").join("fake.png"), b"just text").expect("fake");
        fs::write(dir.join("attachments").join("vector.svg"), b"<svg/>").expect("svg");
        for bad in ["secret.png", "attachments/../secret.png", "attachments/fake.png", "attachments/vector.svg", "attachments/missing.png", "attachments/sub/x.png", "/attachments/pic.png", "attachments", "attachments/"] {
            assert!(vault.read_attachment_data_url(bad).is_err(), "{bad}");
        }
    }

    #[cfg(unix)]
    #[test]
    fn an_attachments_folder_that_links_out_of_the_vault_is_refused() {
        let outside = scratch("link-outside");
        let dir = scratch("link-vault");
        std::os::unix::fs::symlink(&outside, dir.join("attachments")).expect("symlink");
        let vault = Vault::open(&dir).expect("open");
        assert_eq!(vault.write_attachment("pic.png", &png(1)), Err(VaultError::InvalidPath));
        assert_eq!(fs::read_dir(&outside).expect("list").count(), 0);
        fs::write(outside.join("pic.png"), png(1)).expect("file outside");
        assert!(vault.read_attachment_data_url("attachments/pic.png").is_err());
    }

    #[test]
    fn the_attachments_folder_is_not_listed_as_a_note_folder() {
        let dir = scratch("tree");
        let vault = Vault::open(&dir).expect("open");
        vault.write_attachment("pic.png", &png(1)).expect("write");
        vault.create_note("", "A").expect("note");
        let names: Vec<String> = vault.tree().expect("tree").entries.into_iter().map(|e| e.path).collect();
        assert_eq!(names, vec!["A.md".to_string()]);
    }
}
