//! A small log file.
//!
//! Logs are for finding out what went wrong, so they must never hold anything private:
//! callers pass short fixed messages and error codes, never note text or titles. As a
//! second line of defence every message is cut to a fixed length and kept on one line.

use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

const MAX_MESSAGE_CHARS: usize = 300;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Level {
    Info,
    Warn,
    Error,
}

impl Level {
    fn label(self) -> &'static str {
        match self {
            Level::Info => "INFO",
            Level::Warn => "WARN",
            Level::Error => "ERROR",
        }
    }

    pub fn from_name(name: &str) -> Level {
        match name {
            "error" => Level::Error,
            "warn" => Level::Warn,
            _ => Level::Info,
        }
    }
}

pub struct Logger {
    file: PathBuf,
    max_bytes: u64,
    keep: usize,
    // One writer at a time, so lines from different threads never interleave.
    lock: Mutex<()>,
}

impl Logger {
    pub fn new(dir: &Path, max_bytes: u64, keep: usize) -> Logger {
        let _ = fs::create_dir_all(dir);
        Logger { file: dir.join("scalenote.log"), max_bytes, keep, lock: Mutex::new(()) }
    }

    pub fn path(&self) -> &Path {
        &self.file
    }

    /// Writes one line. Logging must never crash the app, so every failure is swallowed.
    pub fn log(&self, level: Level, message: &str) {
        let Ok(_guard) = self.lock.lock() else {
            return;
        };
        self.rotate_if_needed();
        let line = format!("{} {} {}\n", utc_timestamp(), level.label(), clean(message));
        if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(&self.file) {
            let _ = file.write_all(line.as_bytes());
        }
    }

    fn rotate_if_needed(&self) {
        let size = fs::metadata(&self.file).map(|m| m.len()).unwrap_or(0);
        if size < self.max_bytes {
            return;
        }
        // scalenote.log.2 is dropped, .1 becomes .2, the current file becomes .1, and so on.
        for index in (1..self.keep).rev() {
            let from = self.numbered(index);
            let to = self.numbered(index + 1);
            if from.exists() {
                let _ = fs::rename(&from, &to);
            }
        }
        if self.keep > 0 {
            let _ = fs::rename(&self.file, self.numbered(1));
        } else {
            let _ = fs::remove_file(&self.file);
        }
    }

    fn numbered(&self, index: usize) -> PathBuf {
        let mut name = self.file.clone().into_os_string();
        name.push(format!(".{index}"));
        PathBuf::from(name)
    }
}

/// One line, limited length, control characters removed.
fn clean(message: &str) -> String {
    message
        .chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .take(MAX_MESSAGE_CHARS)
        .collect()
}

/// `2026-11-03T21:10:05Z`, computed by hand to avoid a date library.
fn utc_timestamp() -> String {
    let seconds = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    format_utc(seconds)
}

pub fn format_utc(seconds: u64) -> String {
    let days = (seconds / 86_400) as i64;
    let rest = seconds % 86_400;
    let (year, month, day) = civil_from_days(days);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}Z",
        rest / 3600,
        (rest % 3600) / 60,
        rest % 60
    )
}

/// Days since 1970-01-01 to a calendar date (Howard Hinnant's public-domain algorithm).
fn civil_from_days(days: i64) -> (i64, i64, i64) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let day_of_era = z.rem_euclid(146_097);
    let year_of_era =
        (day_of_era - day_of_era / 1460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let year = year_of_era + era * 400;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_part = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * month_part + 2) / 5 + 1;
    let month = if month_part < 10 { month_part + 3 } else { month_part - 9 };
    (if month <= 2 { year + 1 } else { year }, month, day)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("sn-log-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        dir
    }

    #[test]
    fn timestamps_are_right_for_known_dates() {
        assert_eq!(format_utc(0), "1970-01-01T00:00:00Z");
        assert_eq!(format_utc(951_782_400), "2000-02-29T00:00:00Z");
        assert_eq!(format_utc(1_793_740_805), "2026-11-03T21:20:05Z");
    }

    #[test]
    fn lines_have_a_level_and_stay_on_one_line() {
        let dir = scratch("lines");
        let logger = Logger::new(&dir, 10_000, 2);
        logger.log(Level::Warn, "first\nsecond\tthird");
        let text = fs::read_to_string(logger.path()).expect("read log");
        assert_eq!(text.lines().count(), 1);
        assert!(text.contains(" WARN first second third"));
    }

    #[test]
    fn long_messages_are_cut() {
        let dir = scratch("long");
        let logger = Logger::new(&dir, 10_000, 2);
        logger.log(Level::Info, &"x".repeat(5000));
        let text = fs::read_to_string(logger.path()).expect("read log");
        assert!(text.len() < 400);
    }

    #[test]
    fn old_logs_rotate_and_only_a_few_are_kept() {
        let dir = scratch("rotate");
        let logger = Logger::new(&dir, 200, 2);
        for i in 0..100 {
            logger.log(Level::Info, &format!("line number {i} with some padding to fill space"));
        }
        assert!(logger.path().exists());
        assert!(dir.join("scalenote.log.1").exists());
        assert!(dir.join("scalenote.log.2").exists());
        assert!(!dir.join("scalenote.log.3").exists());
    }

    #[test]
    fn unknown_level_names_fall_back_to_info() {
        assert_eq!(Level::from_name("error"), Level::Error);
        assert_eq!(Level::from_name("bogus"), Level::Info);
    }
}
