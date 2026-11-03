//! Turning what a person types into a safe file name.

/// Longest file name stem we create, in characters. Leaves room for " 2" and ".md"
/// under the 255-byte limit most file systems have.
const MAX_STEM_CHARS: usize = 100;

const RESERVED: [&str; 22] = [
    "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8",
    "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
];

/// Cleans a title for use as a file or folder name. Never returns an empty string.
///
/// Characters Windows does not allow are dropped on every system, so a vault made on
/// Linux can always be opened on Windows and the other way around.
pub fn sanitize_name(input: &str, fallback: &str) -> String {
    let mut cleaned = String::with_capacity(input.len());
    for ch in input.chars() {
        if ch.is_control() || "<>:\"/\\|?*".contains(ch) {
            continue;
        }
        cleaned.push(ch);
    }
    // Collapse runs of spaces and trim. Leading dots would make a hidden file.
    let collapsed = cleaned.split_whitespace().collect::<Vec<_>>().join(" ");
    let trimmed = collapsed.trim_start_matches('.').trim_end_matches(['.', ' ']);
    let limited: String = trimmed.chars().take(MAX_STEM_CHARS).collect();
    let limited = limited.trim_end_matches(['.', ' ']).to_string();

    if limited.is_empty() {
        return fallback.to_string();
    }
    let upper = limited.to_uppercase();
    let stem_upper = upper.split('.').next().unwrap_or("");
    if RESERVED.contains(&stem_upper) {
        return format!("{limited}_");
    }
    limited
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_normal_names() {
        assert_eq!(sanitize_name("Week 1 notes", "Untitled"), "Week 1 notes");
        assert_eq!(sanitize_name("Cellen & weefsels", "Untitled"), "Cellen & weefsels");
    }

    #[test]
    fn removes_characters_windows_forbids() {
        assert_eq!(sanitize_name("a/b\\c:d*e?f\"g<h>i|j", "Untitled"), "abcdefghij");
    }

    #[test]
    fn empty_or_dots_only_uses_fallback() {
        assert_eq!(sanitize_name("", "Untitled"), "Untitled");
        assert_eq!(sanitize_name("   ", "Untitled"), "Untitled");
        assert_eq!(sanitize_name("...", "Untitled"), "Untitled");
        assert_eq!(sanitize_name("///", "Untitled"), "Untitled");
    }

    #[test]
    fn leading_dot_is_not_allowed_so_files_are_never_hidden() {
        assert_eq!(sanitize_name(".secret", "Untitled"), "secret");
    }

    #[test]
    fn trailing_dots_and_spaces_are_trimmed() {
        assert_eq!(sanitize_name("Name. . ", "Untitled"), "Name");
    }

    #[test]
    fn reserved_windows_names_get_a_suffix() {
        assert_eq!(sanitize_name("con", "Untitled"), "con_");
        assert_eq!(sanitize_name("LPT1", "Untitled"), "LPT1_");
        assert_eq!(sanitize_name("nul.txt", "Untitled"), "nul.txt_");
    }

    #[test]
    fn very_long_names_are_cut_by_characters_not_bytes() {
        let long = "é".repeat(500);
        let out = sanitize_name(&long, "Untitled");
        assert_eq!(out.chars().count(), 100);
    }

    #[test]
    fn control_characters_and_newlines_are_dropped() {
        assert_eq!(sanitize_name("a\nb\u{0}c\td", "Untitled"), "abcd");
    }
}
