//! Tests for the home server's logic with real folders, real services and real connections
//! on loopback. Nothing is faked: the same code path a phone uses to pair and sync.

use super::*;
use crate::sync::engine::Outcome;
use crate::sync::identity::Identity;
use crate::sync::service::{ping, Service};
use std::net::TcpListener;

struct Dir(PathBuf);

impl Dir {
    fn new(label: &str) -> Dir {
        let path = std::env::temp_dir().join(format!("sn-server-{label}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&path);
        fs::create_dir_all(&path).expect("make test dir");
        Dir(path)
    }
    fn sub(&self, name: &str) -> PathBuf {
        let path = self.0.join(name);
        fs::create_dir_all(&path).expect("sub dir");
        path
    }
}

impl Drop for Dir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn free_port() -> u16 {
    TcpListener::bind("127.0.0.1:0").expect("bind").local_addr().expect("addr").port()
}

const GOOD: &str = "# a comment\ndata_dir = /var/lib/sn\nname = Home server\n\n[vault alice]\nfolder = /srv/a\nport = 47821\n\n[vault bob]\nfolder = /srv/b\nport = 47822\n";

#[test]
fn a_good_config_is_read() {
    let config = parse(GOOD).expect("parse");
    assert_eq!(config.data_dir, PathBuf::from("/var/lib/sn"));
    // Device names are kept to plain characters (spaces become hyphens), like on every device.
    assert_eq!(config.device_name, "Home-server");
    assert_eq!(config.vaults.len(), 2);
    assert_eq!(config.vaults[1], VaultConfig { name: "bob".into(), folder: PathBuf::from("/srv/b"), port: 47822 });
}

#[test]
fn a_bad_config_says_which_line_is_wrong() {
    let cases = [
        ("name = x\n[vault a]\nfolder = /a\nport = 5000\n", "no data_dir"),
        ("data_dir = /d\n", "no vault"),
        ("data_dir = /d\n[vault Alice]\nfolder = /a\nport = 5000\n", "line 2"),
        ("data_dir = /d\n[vault a]\nfolder = relative\nport = 5000\n", "line 3"),
        ("data_dir = /d\n[vault a]\nfolder = /a\nport = 80\n", "line 4"),
        ("data_dir = /d\n[vault a]\nfolder = /a\nport = abc\n", "line 4"),
        ("data_dir = /d\n[vault a]\nfolder = /a\n", "no port"),
        ("data_dir = /d\n[vault a]\nport = 5000\n", "no folder"),
        ("data_dir = /d\n[vault a]\nfolder = /a\nport = 5000\ncolour = red\n", "line 5"),
        ("data_dir = /d\n[vault a\nfolder = /a\nport = 5000\n", "line 2"),
        ("data_dir = /d\n[vault a]\nfolder = /a\nport = 5000\n[vault a]\nfolder = /b\nport = 5001\n", "used twice"),
        ("data_dir = /d\n[vault a]\nfolder = /a\nport = 5000\n[vault b]\nfolder = /b\nport = 5000\n", "used by two"),
        ("data_dir = /d\n[other x]\n", "line 2"),
        ("just words\n", "line 1"),
    ];
    for (text, expect) in cases {
        let error = parse(text).expect_err(text);
        assert!(error.contains(expect), "{text:?} gave {error:?}");
    }
}

#[test]
fn too_many_vaults_and_odd_input_are_refused_calmly() {
    let mut text = String::from("data_dir = /d\n");
    for i in 0..=MAX_VAULTS {
        text.push_str(&format!("[vault v{i}]\nfolder = /f{i}\nport = {}\n", 2000 + i));
    }
    assert!(parse(&text).expect_err("too many").contains("at most"));
    for odd in ["", "\0\0", "[", "=", "= =", &"x".repeat(100_000), "data_dir =\n"] {
        assert!(parse(odd).is_err());
    }
}

#[test]
fn a_huge_config_file_is_not_read() {
    let dir = Dir::new("big");
    let path = dir.0.join("big.conf");
    fs::write(&path, vec![b'#'; 100_000]).expect("write");
    assert!(read_config(&path).is_err());
    assert!(read_config(&dir.0.join("missing.conf")).is_err());
}

#[test]
fn folders_that_overlap_or_hold_the_keys_are_refused() {
    let dir = Dir::new("overlap");
    let (a, b, data) = (dir.sub("a"), dir.sub("b"), dir.sub("data"));
    let inside = dir.sub("a/inner");
    let make = |folders: &[&PathBuf], data_dir: &PathBuf| Config {
        data_dir: data_dir.clone(),
        device_name: "S".into(),
        vaults: folders.iter().enumerate().map(|(i, f)| VaultConfig { name: format!("v{i}"), folder: (*f).clone(), port: 5000 + i as u16 }).collect(),
    };
    assert!(check_folders(&make(&[&a, &b], &data)).is_ok());
    assert!(check_folders(&make(&[&a, &a], &data)).expect_err("same").contains("overlap"));
    assert!(check_folders(&make(&[&a, &inside], &data)).expect_err("nested").contains("overlap"));
    assert!(check_folders(&make(&[&a], &inside)).expect_err("keys in vault").contains("keys"));
    assert!(check_folders(&make(&[&a, &dir.0.join("nope")], &data)).expect_err("missing").contains("does not exist"));
}

#[cfg(unix)]
#[test]
fn the_data_folder_must_be_private_to_the_server() {
    use std::os::unix::fs::PermissionsExt;
    let dir = Dir::new("private");
    let fresh = dir.0.join("fresh");
    prepare_data_dir(&fresh).expect("made private");
    assert_eq!(fs::metadata(&fresh).expect("meta").permissions().mode() & 0o777, 0o700);
    fs::set_permissions(&fresh, fs::Permissions::from_mode(0o755)).expect("chmod");
    assert!(prepare_data_dir(&fresh).expect_err("open").contains("chmod 700"));
    fs::set_permissions(&fresh, fs::Permissions::from_mode(0o770)).expect("chmod");
    assert!(prepare_data_dir(&fresh).is_err());
    // A link to a folder does not count as a folder of the server's own.
    let link = dir.0.join("link");
    std::os::unix::fs::symlink(&fresh, &link).expect("link");
    assert!(prepare_data_dir(&link).is_err());
}

fn config_for(dir: &Dir, names: &[&str]) -> Config {
    let data = dir.0.join("data");
    prepare_data_dir(&data).expect("data");
    Config {
        data_dir: data,
        device_name: "Home server".into(),
        vaults: names.iter().map(|n| VaultConfig { name: n.to_string(), folder: dir.sub(&format!("vault-{n}")), port: free_port() }).collect(),
    }
}

/// A pretend phone: a normal service with its own vault folder, on loopback.
fn phone(dir: &Dir, label: &str) -> (Service, PathBuf) {
    let own = dir.sub(&format!("phone-{label}"));
    let vault = dir.sub(&format!("phone-{label}-vault"));
    let service = Service::with_bind(&own, Identity::generate().expect("identity"), label, true, "127.0.0.1", 0).expect("service");
    service.set_vault(Some(vault.clone()));
    (service, vault)
}

fn pair_with(runner: &Runner, name: &str, port: u16, phone: &Service) {
    let service = runner.service(name).expect("vault");
    let code = service.start_pairing().expect("code");
    phone.join(&format!("127.0.0.1:{port}"), &code).expect("pair");
}

#[test]
fn each_vault_has_its_own_key_port_and_folder_and_a_broken_one_does_not_stop_the_rest() {
    let dir = Dir::new("own");
    let mut config = config_for(&dir, &["alice", "bob"]);
    let (runner, problems) = Runner::start(&config);
    assert!(problems.is_empty(), "{problems:?}");
    assert_eq!(runner.names(), vec!["alice", "bob"]);
    let fa = runner.service("alice").expect("a").status().fingerprint;
    let fb = runner.service("bob").expect("b").status().fingerprint;
    assert_ne!(fa, fb, "two vaults never share a device key");
    assert!(config.data_dir.join("alice/device.key").is_file() && config.data_dir.join("bob/device.key").is_file());
    assert_ne!(runner.folder_of("alice"), runner.folder_of("bob"));
    runner.shutdown();
    // Restarting keeps the same keys: a paired phone would still trust it.
    let (again, _) = Runner::start(&config);
    assert_eq!(again.service("alice").expect("a").status().fingerprint, fa);
    again.shutdown();
    // A vault whose port is taken is left out and reported; the other still runs.
    let held = TcpListener::bind("0.0.0.0:0").expect("hold");
    config.vaults[0].port = held.local_addr().expect("addr").port();
    let (partly, problems) = Runner::start(&config);
    let blocked = partly.service("alice").expect("a").start_pairing();
    assert!(blocked.is_err(), "a taken port is reported, never replaced by another one");
    assert!(problems.is_empty(), "{problems:?}");
    assert!(partly.service("bob").is_some());
    partly.shutdown();
}

#[test]
fn a_phone_paired_with_one_vault_cannot_reach_the_other_and_sync_goes_to_its_own_vault_only() {
    let dir = Dir::new("apart");
    let config = config_for(&dir, &["alice", "bob"]);
    let (runner, problems) = Runner::start(&config);
    assert!(problems.is_empty(), "{problems:?}");
    let (a_port, b_port) = (config.vaults[0].port, config.vaults[1].port);
    let (phone, phone_vault) = phone(&dir, "p1");
    pair_with(&runner, "alice", a_port, &phone);
    // The phone knows the server's alice vault and nothing else.
    assert_eq!(phone.status().peers.len(), 1);
    assert!(ping(&phone, &format!("127.0.0.1:{a_port}")).is_ok());
    // Bob's vault listens only once pairing is open; open it so the refusal comes from trust, not from silence.
    runner.service("bob").expect("bob").start_pairing().expect("open");
    assert!(ping(&phone, &format!("127.0.0.1:{b_port}")).is_err(), "not paired with bob's vault");
    // A note goes into alice's folder and nowhere else.
    fs::write(phone_vault.join("Hello.md"), "hi from the phone\n").expect("write");
    let id = phone.status().peers[0].id.clone();
    match phone.sync_peer(&id, true, &mut |_| {}).expect("sync") {
        Outcome::Done(report) => assert_eq!(report.changed(), 1),
        Outcome::NeedsApproval(_) => panic!("approved"),
    }
    assert_eq!(fs::read_to_string(runner.folder_of("alice").expect("folder").join("Hello.md")).expect("arrived"), "hi from the phone\n");
    assert!(!runner.folder_of("bob").expect("folder").join("Hello.md").exists());
    // The server's own files (keys, trust list) never travel and never sit in the vault.
    assert!(fs::read_dir(runner.folder_of("alice").expect("folder")).expect("dir").all(|e| e.expect("entry").file_name() != "device.key"));
    runner.shutdown();
}

#[test]
fn pairing_by_request_file_writes_the_code_privately_and_removes_it_when_pairing_closes() {
    let dir = Dir::new("pairfile");
    let config = config_for(&dir, &["alice"]);
    let (runner, _) = Runner::start(&config);
    let vault_dir = config.data_dir.join("alice");
    assert!(runner.poll_pairing().is_empty(), "nothing asked, nothing happens");
    fs::write(vault_dir.join(PAIR_REQUEST), b"").expect("request");
    let notes = runner.poll_pairing();
    assert_eq!(notes.len(), 1, "{notes:?}");
    assert!(!vault_dir.join(PAIR_REQUEST).exists(), "the request is used up");
    let code = fs::read_to_string(vault_dir.join(PAIR_CODE)).expect("code file");
    assert!(code.trim().len() >= 6);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(fs::metadata(vault_dir.join(PAIR_CODE)).expect("meta").permissions().mode() & 0o777, 0o600);
    }
    // The code really works for a phone.
    let (phone, _) = phone(&dir, "p2");
    phone.join(&format!("127.0.0.1:{}", config.vaults[0].port), code.trim()).expect("paired with the code from the file");
    // Once pairing is closed the code file is cleaned up.
    runner.service("alice").expect("a").stop_pairing().expect("close");
    runner.poll_pairing();
    assert!(!vault_dir.join(PAIR_CODE).exists());
    runner.shutdown();
}

#[test]
fn a_restart_keeps_the_paired_phone_trusted() {
    let dir = Dir::new("restart");
    let config = config_for(&dir, &["alice"]);
    let (runner, _) = Runner::start(&config);
    let (phone, _) = phone(&dir, "p3");
    pair_with(&runner, "alice", config.vaults[0].port, &phone);
    runner.shutdown();
    drop(runner);
    let (again, problems) = Runner::start(&config);
    assert!(problems.is_empty(), "{problems:?}");
    assert_eq!(again.service("alice").expect("a").status().peers.len(), 1, "the trust list was kept on disk");
    assert!(ping(&phone, &format!("127.0.0.1:{}", config.vaults[0].port)).is_ok());
    again.shutdown();
}
