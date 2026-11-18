# ScaleNote home server: install guide

The home server is the sync part of ScaleNote as a program with no window. It is a paired device that is always on, so your phone and computer can sync with it even when the other one is off. It runs on Linux. It works on your home network, and over a private network such as Tailscale by typing the server's address. It is not meant to be opened to the internet.

**Status: built and tested on one computer only. It has not run for days on a real home server yet.** Keep your own backup of your notes.

## What you need

- A Linux computer that stays on, with the `scalenote-server_<version>_linux-x86_64.tar.gz` file from the release.
- A folder for each vault (one folder of notes). A second person gets a second vault.

## Install

Run these as an administrator (root). Change the folder names to your own.

1. Unpack the archive and put the program in place:
   `tar -xzf scalenote-server_*.tar.gz` then `install -m 755 scalenote-server_*/scalenote-server /usr/local/bin/`
2. Make a user for it that cannot log in: `useradd --system --home /var/lib/scalenote-server --shell /usr/sbin/nologin scalenote`
3. Make the data folder (keys and lists of paired devices) private: `install -d -m 700 -o scalenote /var/lib/scalenote-server`
4. Make a folder for each vault: `install -d -o scalenote /srv/scalenote/alice`
5. Copy `scalenote-server.conf.example` to `/etc/scalenote-server.conf` and edit it: one `[vault name]` section for each vault, each with its own folder and its own port.
6. Check the config without starting anything: `sudo -u scalenote scalenote-server check --config /etc/scalenote-server.conf`
7. Copy `scalenote-server.service` to `/etc/systemd/system/`. If your vault folders are not under `/srv/scalenote`, change the `ReadWritePaths` line. Then `systemctl daemon-reload` and `systemctl enable --now scalenote-server`.

The server refuses to start if its data folder can be read by other users, if a vault folder is missing, or if two vaults share a folder or a port. It tells you which.

## Pair a phone or computer with a vault

1. On the server: `sudo -u scalenote scalenote-server pair --config /etc/scalenote-server.conf alice`
2. It prints an address with a port and an 8-digit code. The code works for a few minutes.
3. In ScaleNote on your device: Settings, Sync, pair with a device by address. Type the address and the code.
4. The first sync shows what it would do and waits for your yes, like between two devices.

A device paired with one vault cannot reach another vault on the same server. To use two vaults on one phone, pair it with each one separately.

## The add-only inbox (optional)

A script on the server (a backup job, a monitoring check) can leave a note in your vault without any access to your other notes.

1. Make a folder for it outside every vault, for example `/srv/scalenote/inbox-alice`. Let the script's user write to it, and the `scalenote` user read and delete in it (a shared group works).
2. Add `inbox = /srv/scalenote/inbox-alice` to the vault's section and restart the server.
3. The script writes a file ending in `.md`. To be safe while it is being written, write it as `.name.tmp` (a name starting with a dot) and rename it when finished.

The server moves each finished note into the vault's `Inbox` folder every few seconds. A name that is taken gets a number (`Report 2.md`); nothing is ever replaced. Only plain, text `.md` files up to 1 MB are taken. Anything else is moved to `.rejected` inside the inbox and a line is written to the log, so nothing is lost and nothing repeats. Links are never followed. The script never touches the vault itself, which is what makes it add-only.

## Facts to know

- **Backups.** The server is a sync partner, not a backup. If a note is deleted on one device, it goes to the other devices' trash, not to a backup. Copy the vault folders somewhere else too.
- **Stopping.** Stopping the server at any moment is safe: notes are written to a temporary file and renamed, so a half-written note cannot appear.
- **Where things are.** Notes are plain markdown in the vault folder, so you can open that folder with any markdown app. Keys and paired devices are in the data folder, never in a vault.
- **Network.** Only paired devices can sync. Anything else is refused. A vault listens only after a device is paired or while a pairing code is open.
- **Logs.** `journalctl -u scalenote-server`.

## Not in this version yet

The backup screen, the security explanation cards, the colour per project folder, and the tray and open at login (those are in the desktop app, not the server) come in the next slices of 0.5.5.
