// Test helper, not part of the app.
//
// It saves a note over and over with `write_atomic`, alternating between two large
// contents. A test starts it, kills it at a random moment, and checks that the note is
// always exactly one of the two contents and never a mixture.

use scalenote_core::atomic::write_atomic;
use std::path::PathBuf;

fn main() {
    let mut args = std::env::args().skip(1);
    let (Some(path), Some(size)) = (args.next(), args.next()) else {
        eprintln!("usage: sn-crash-writer <file> <size-in-bytes>");
        std::process::exit(2);
    };
    let Ok(size) = size.parse::<usize>() else {
        eprintln!("size must be a number");
        std::process::exit(2);
    };
    let path = PathBuf::from(path);
    let a = vec![b'A'; size];
    let b = vec![b'B'; size];
    let mut flip = false;
    loop {
        let content = if flip { &a } else { &b };
        if write_atomic(&path, content).is_err() {
            std::process::exit(1);
        }
        flip = !flip;
    }
}
