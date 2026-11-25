//! Joining two edited versions of a page into one, word by word (0.6.4).
//!
//! When two devices (or two people sharing a page) changed the same page since they last had the
//! same text, sync used to keep both versions and let the person pick one. Now it first tries to
//! join them, the way version control tools join two edits of a file ("three-way merge"):
//! - `base` is the text both had last, `ours` and `theirs` the two edited texts;
//! - every text is cut into words, runs of spaces and single other characters (so a line break,
//!   a `*` or a `#` is a piece of its own, and a change to one word does not touch its neighbours);
//! - the parts that only one side changed are taken from that side;
//! - where both sides changed the same place differently, nothing is guessed: `merge` gives up and
//!   sync keeps both versions as before. Both making the very same change is not a clash.
//!
//! This only looks at the text. A page whose markdown is joined this way is still valid markdown
//! in practice, because the pieces are small and each side's change stays whole.

/// The largest page that is joined; bigger ones keep both versions as before (the comparison
/// grows with the size of the changes, and pages this long are rare).
pub const MAX_MERGE_BYTES: usize = 2 * 1024 * 1024;

/// Cuts a text into pieces: words (letters and digits, also accented ones), runs of spaces or
/// tabs, and every other character on its own.
fn pieces(text: &str) -> Vec<&str> {
    let mut out = Vec::new();
    let mut start = 0;
    let mut kind = 0u8; // 0 none, 1 word, 2 spaces
    for (index, c) in text.char_indices() {
        let next = if c.is_alphanumeric() || c == '_' || c == '\'' { 1 } else if c == ' ' || c == '\t' { 2 } else { 3 };
        if next == 3 || next != kind {
            if index > start {
                out.push(&text[start..index]);
            }
            start = index;
        }
        if next == 3 {
            out.push(&text[index..index + c.len_utf8()]);
            start = index + c.len_utf8();
            kind = 0;
        } else {
            kind = next;
        }
    }
    if start < text.len() {
        out.push(&text[start..]);
    }
    out
}

/// The pairs of positions (in `a`, in `b`) of the pieces both have in common, in order: the
/// longest such list, found with Myers' method (it takes time in the size of the change, not the
/// size of the page). The common start and end are taken off first.
fn common(a: &[&str], b: &[&str]) -> Vec<(usize, usize)> {
    let mut prefix = 0;
    while prefix < a.len() && prefix < b.len() && a[prefix] == b[prefix] {
        prefix += 1;
    }
    let mut suffix = 0;
    while suffix < a.len() - prefix && suffix < b.len() - prefix && a[a.len() - 1 - suffix] == b[b.len() - 1 - suffix] {
        suffix += 1;
    }
    let mut pairs: Vec<(usize, usize)> = (0..prefix).map(|i| (i, i)).collect();
    let (ma, mb) = (&a[prefix..a.len() - suffix], &b[prefix..b.len() - suffix]);
    for (i, j) in myers(ma, mb) {
        pairs.push((i + prefix, j + prefix));
    }
    pairs.extend((0..suffix).map(|k| (a.len() - suffix + k, b.len() - suffix + k)));
    pairs
}

/// Myers' shortest edit script, returned as the matched pairs.
fn myers(a: &[&str], b: &[&str]) -> Vec<(usize, usize)> {
    let (n, m) = (a.len() as isize, b.len() as isize);
    if n == 0 || m == 0 {
        return Vec::new();
    }
    let max = (n + m) as usize;
    let offset = max as isize;
    let mut v = vec![0isize; 2 * max + 2];
    let mut trace: Vec<Vec<isize>> = Vec::new();
    'outer: for d in 0..=max as isize {
        trace.push(v.clone());
        let mut k = -d;
        while k <= d {
            let idx = (k + offset) as usize;
            let mut x = if k == -d || (k != d && v[idx - 1] < v[idx + 1]) { v[idx + 1] } else { v[idx - 1] + 1 };
            let mut y = x - k;
            while x < n && y < m && a[x as usize] == b[y as usize] {
                x += 1;
                y += 1;
            }
            v[idx] = x;
            if x >= n && y >= m {
                break 'outer;
            }
            k += 2;
        }
    }
    // Walk back through the saved rounds to find the matched pieces.
    let mut pairs = Vec::new();
    let (mut x, mut y) = (n, m);
    for d in (0..trace.len() as isize).rev() {
        let v = &trace[d as usize];
        let k = x - y;
        let idx = (k + offset) as usize;
        let prev_k = if k == -d || (k != d && v[idx - 1] < v[idx + 1]) { k + 1 } else { k - 1 };
        let prev_x = v[(prev_k + offset) as usize];
        let prev_y = prev_x - prev_k;
        while x > prev_x && y > prev_y {
            x -= 1;
            y -= 1;
            pairs.push((x as usize, y as usize));
        }
        if d > 0 {
            x = prev_x;
            y = prev_y;
        }
    }
    pairs.reverse();
    pairs
}

/// For every piece of `base`, where it is in `other` (if it is kept there).
fn kept_at(base: &[&str], other: &[&str]) -> Vec<Option<usize>> {
    let mut at = vec![None; base.len()];
    for (i, j) in common(base, other) {
        at[i] = Some(j);
    }
    at
}

/// Joins `ours` and `theirs`, both edited from `base`. `None` when both changed the same place
/// differently (then nothing is joined).
pub fn merge(base: &str, ours: &str, theirs: &str) -> Option<String> {
    if ours == theirs {
        return Some(ours.to_string());
    }
    if base == ours {
        return Some(theirs.to_string());
    }
    if base == theirs {
        return Some(ours.to_string());
    }
    if base.len() > MAX_MERGE_BYTES || ours.len() > MAX_MERGE_BYTES || theirs.len() > MAX_MERGE_BYTES {
        return None;
    }
    let (b, o, t) = (pieces(base), pieces(ours), pieces(theirs));
    let (in_o, in_t) = (kept_at(&b, &o), kept_at(&b, &t));
    let mut out = String::with_capacity(ours.len().max(theirs.len()));
    // Walk the "stable" base pieces: kept on both sides. Between two of them is a stretch that
    // one side, the other, or both changed.
    let (mut bi, mut oi, mut ti) = (0usize, 0usize, 0usize);
    loop {
        let mut next = bi;
        while next < b.len() && !(in_o[next].is_some() && in_t[next].is_some()) {
            next += 1;
        }
        let (o_end, t_end) = if next < b.len() { (in_o[next].unwrap_or(o.len()), in_t[next].unwrap_or(t.len())) } else { (o.len(), t.len()) };
        let (base_part, our_part, their_part) = (&b[bi..next], &o[oi..o_end], &t[ti..t_end]);
        if our_part == base_part {
            out.extend(their_part.iter().copied());
        } else if their_part == base_part || our_part == their_part {
            out.extend(our_part.iter().copied());
        } else {
            return None;
        }
        if next >= b.len() {
            return Some(out);
        }
        out.push_str(b[next]);
        bi = next + 1;
        oi = o_end + 1;
        ti = t_end + 1;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn changes_in_different_places_are_both_kept() {
        let base = "Cells have a membrane.\nThe nucleus holds DNA.\n";
        let ours = "Cells have a thin membrane.\nThe nucleus holds DNA.\n";
        let theirs = "Cells have a membrane.\nThe nucleus holds the DNA.\n";
        assert_eq!(merge(base, ours, theirs).as_deref(), Some("Cells have a thin membrane.\nThe nucleus holds the DNA.\n"));
        assert_eq!(merge(base, theirs, ours).as_deref(), Some("Cells have a thin membrane.\nThe nucleus holds the DNA.\n"));
    }

    #[test]
    fn neighbouring_words_on_one_line_are_joined() {
        // One changed a word, the other added one after it: both are kept.
        assert_eq!(merge("the quick fox", "the slow fox", "the quick red fox").as_deref(), Some("the slow red fox"));
        assert_eq!(merge("a b c d", "a B c d", "a b c D").as_deref(), Some("a B c D"));
    }

    #[test]
    fn the_same_change_on_both_sides_and_one_sided_changes_are_not_clashes() {
        assert_eq!(merge("one two", "one 2", "one 2").as_deref(), Some("one 2"));
        assert_eq!(merge("one two", "one two", "x").as_deref(), Some("x"));
        assert_eq!(merge("one two", "y", "one two").as_deref(), Some("y"));
        assert_eq!(merge("", "", "new").as_deref(), Some("new"));
    }

    #[test]
    fn both_changing_the_same_word_differently_is_left_to_the_person() {
        assert_eq!(merge("colour: red", "colour: blue", "colour: green"), None);
        assert_eq!(merge("keep this", "", "keep this and more"), None, "deleted on one side, changed on the other");
    }

    #[test]
    fn additions_at_both_ends_and_markdown_marks_stay_whole() {
        let base = "# Notes\n\n- one\n";
        let ours = "# Notes\n\n- one\n- two\n";
        let theirs = "Intro line\n# Notes\n\n- **one**\n";
        assert_eq!(merge(base, ours, theirs).as_deref(), Some("Intro line\n# Notes\n\n- **one**\n- two\n"));
    }

    #[test]
    fn accented_words_and_long_pages_work() {
        assert_eq!(merge("café olé", "café olé!", "Café olé").as_deref(), Some("Café olé!"));
        let base: String = (0..4000).map(|i| format!("word{i} ")).collect();
        let ours = base.replacen("word10 ", "WORD10 ", 1);
        let theirs = base.replacen("word3990 ", "", 1);
        let merged = merge(&base, &ours, &theirs).expect("far apart");
        assert!(merged.contains("WORD10 ") && !merged.contains("word3990 "));
    }

    #[test]
    fn pieces_split_words_spaces_and_marks() {
        assert_eq!(pieces("**Hi**  there\nyou'd"), ["*", "*", "Hi", "*", "*", "  ", "there", "\n", "you'd"]);
    }
}
