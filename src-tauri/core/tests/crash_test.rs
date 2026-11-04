// Kills a program that is saving a note in a loop and checks the note is never damaged.

use std::fs;
use std::process::Command;
use std::time::Duration;

#[test]
fn killing_the_writer_at_random_moments_never_leaves_a_mixed_file() {
    let dir = std::env::temp_dir().join(format!("sn-crash-{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).expect("dir");
    let note = dir.join("note.md");
    let size = 3 * 1024 * 1024;
    fs::write(&note, vec![b'A'; size]).expect("seed");

    let exe = env!("CARGO_BIN_EXE_sn-crash-writer");
    for round in 0..40u64 {
        let mut child = Command::new(exe).arg(&note).arg(size.to_string()).spawn().expect("start writer");
        // Spread kills over many different moments inside the write cycle.
        std::thread::sleep(Duration::from_micros(3_000 + round * 1_700));
        child.kill().expect("kill");
        child.wait().expect("wait");

        let bytes = fs::read(&note).expect("note must still exist");
        assert_eq!(bytes.len(), size, "round {round}: wrong length");
        let first = bytes[0];
        assert!(first == b'A' || first == b'B', "round {round}: unexpected content");
        assert!(bytes.iter().all(|b| *b == first), "round {round}: file is a mixture");
    }
    // Killed writers may leave a temp file behind, and the vault cleans those up. The note
    // itself is the only thing that matters here.
    let leftovers = fs::read_dir(&dir).expect("list").count();
    assert!(leftovers >= 1);
}
