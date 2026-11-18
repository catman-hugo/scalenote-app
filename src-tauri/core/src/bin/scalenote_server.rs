//! `scalenote-server`: the sync part of ScaleNote as a program with no window, for a home
//! server. It is a paired device that is always on. See docs/home-server.md for the install guide.
//!
//! Commands:
//!   scalenote-server run   --config FILE        run until stopped (this is what the system starts)
//!   scalenote-server check --config FILE        read the config and check the folders, change nothing
//!   scalenote-server pair  --config FILE NAME   open pairing for one vault and print the code

use scalenote_core::server::{self, Config, Runner, PAIR_CODE, PAIR_REQUEST};
use scalenote_core::sync::service::local_address_hint;
use std::path::PathBuf;
use std::process::ExitCode;
use std::time::{Duration, Instant};

const USAGE: &str = "Usage:\n  scalenote-server run   --config FILE\n  scalenote-server check --config FILE\n  scalenote-server pair  --config FILE VAULT\n";

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match run_command(&args) {
        Ok(()) => ExitCode::SUCCESS,
        Err(message) => {
            eprintln!("scalenote-server: {message}");
            ExitCode::from(1)
        }
    }
}

fn run_command(args: &[String]) -> Result<(), String> {
    let command = args.first().map(String::as_str).unwrap_or("");
    let rest = args.get(1..).unwrap_or(&[]);
    let (config_path, extra) = take_config(rest)?;
    match command {
        "run" if extra.is_empty() => run(&load(&config_path)?),
        "check" if extra.is_empty() => check(&config_path),
        "pair" if extra.len() == 1 => pair(&load(&config_path)?, &extra[0]),
        _ => Err(format!("unknown or incomplete command.\n{USAGE}")),
    }
}

/// Pulls `--config FILE` out of the arguments; what is left over is returned.
fn take_config(args: &[String]) -> Result<(PathBuf, Vec<String>), String> {
    let mut config = None;
    let mut extra = Vec::new();
    let mut iter = args.iter();
    while let Some(arg) = iter.next() {
        if arg == "--config" {
            config = Some(PathBuf::from(iter.next().ok_or("--config needs a file name")?));
        } else {
            extra.push(arg.clone());
        }
    }
    Ok((config.ok_or_else(|| format!("--config FILE is missing.\n{USAGE}"))?, extra))
}

fn load(path: &PathBuf) -> Result<Config, String> {
    let config = server::read_config(path)?;
    server::check_folders(&config)?;
    Ok(config)
}

fn check(path: &PathBuf) -> Result<(), String> {
    let config = load(path)?;
    println!("The config is fine: {} vault(s).", config.vaults.len());
    for vault in &config.vaults {
        println!("  {}  port {}  folder {}{}", vault.name, vault.port, vault.folder.display(), vault.inbox.as_ref().map(|i| format!("  inbox {}", i.display())).unwrap_or_default());
    }
    Ok(())
}

fn log(line: &str) {
    // The system's journal adds the time, so lines carry none of their own.
    println!("{line}");
}

fn run(config: &Config) -> Result<(), String> {
    server::prepare_data_dir(&config.data_dir)?;
    // Checked before it was made (see run_command) and once more now that it exists.
    server::check_folders(config)?;
    let (runner, problems) = Runner::start(config);
    for problem in &problems {
        eprintln!("{problem}");
    }
    if runner.names().is_empty() {
        return Err("no vault could start".into());
    }
    log(&format!("started: {}", runner.names().join(", ")));
    // The server never starts a sync itself: it only answers. Your devices start every sync (by
    // themselves once they have synced once, or with Sync now), so there is no sync timer here.
    let mut last_inbox = Instant::now();
    loop {
        std::thread::sleep(Duration::from_secs(1));
        for note in runner.poll_pairing() {
            log(&note);
        }
        if last_inbox.elapsed() >= Duration::from_secs(5) {
            last_inbox = Instant::now();
            for line in runner.poll_inboxes() {
                log(&line);
            }
        }
    }
}

fn pair(config: &Config, name: &str) -> Result<(), String> {
    let vault = config.vaults.iter().find(|v| v.name == name).ok_or_else(|| format!("there is no vault called \"{name}\" in the config"))?;
    let dir = config.data_dir.join(&vault.name);
    if !dir.is_dir() {
        return Err("the server has not run yet, so this vault has no data folder. Start it first".into());
    }
    let code_file = dir.join(PAIR_CODE);
    let _ = std::fs::remove_file(&code_file);
    std::fs::write(dir.join(PAIR_REQUEST), b"").map_err(|e| format!("cannot ask the server: {e}"))?;
    let started = Instant::now();
    while started.elapsed() < Duration::from_secs(10) {
        // An empty read is never shown as a code: keep waiting for the real one.
        if let Some(code) = std::fs::read_to_string(&code_file).ok().filter(|c| !c.trim().is_empty()) {
            let address = local_address_hint().unwrap_or_else(|| "the server's address".into());
            println!("Pairing is open for vault \"{}\".", vault.name);
            println!("On your device, choose to pair with a device and type:");
            println!("  address: {address}:{}", vault.port);
            println!("  code:    {}", code.trim());
            println!("The code stops working after a few minutes.");
            return Ok(());
        }
        std::thread::sleep(Duration::from_millis(300));
    }
    Err("the server did not answer. Is it running with this same config?".into())
}
