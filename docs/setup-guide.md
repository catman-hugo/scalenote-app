# Setting up ScaleNote

A guide from nothing to your pages on all your devices. Every part after the first two is optional.

ScaleNote keeps your pages as ordinary Markdown files in a folder on your device. There is no ScaleNote account and no ScaleNote server: devices sync directly with each other, or with a computer of your own at home.

## 1. Install it

Download the file for your system from the newest release on the [Releases page](../../../releases), under Assets.

| System | File | How to install |
|---|---|---|
| Windows 10 and 11 | `.exe` or `.msi` | Open the file and follow the installer. Windows may say the publisher is unknown, because test builds are not signed yet: choose "More info", then "Run anyway". |
| Windows, no install | `-portable.zip` | Unzip it and run `scalenote.exe`. |
| Linux Mint, Ubuntu, Debian | `.deb` | Open it with the software installer, or run `sudo apt install ./file.deb` in the download folder. |
| Fedora | `.rpm` | Open it with the software installer, or run `sudo dnf install ./file.rpm`. |
| Any Linux | `.AppImage` | Right-click the file, open Properties, allow running it as a program, then open it. On some systems it first needs FUSE 2 (on Fedora: `sudo dnf install fuse-libs`). |
| Android | `.apk` | Copy it to the phone or tablet and open it. Android asks you to allow installing from this source. A newer version installs over an older one. |

Test builds of the Android app are signed with a test key. Keep using files from this project's Releases page, so each update fits the one before.

## 2. Choose a notes folder

The first time ScaleNote starts it asks where to keep your pages:

- **Use the default folder**, or
- **Choose a folder** you already have, for example one you use with Obsidian. ScaleNote reads and writes the same Markdown files, and keeps any Markdown it does not know byte for byte.

You can have several notes folders and switch between them with the folder name at the top of the page list (or Ctrl Shift O). Each folder can have its own colour.

On Android the notes folder is inside the app. Keep it synced with another device, or make backups (see 6), so your pages are never only on the phone.

## 3. Sync two devices on your home network

Both devices need ScaleNote and must be on the same network (the same Wi-Fi at home, for example).

1. On both devices, open the notes folder you want to sync, then Settings, Sync, and make sure **Sync is on**.
2. On the first device choose **Pair a device**. It shows an 8-digit code.
3. On the second device choose **Find devices**, choose **Use** next to the first device, type the code and choose **Pair**. If the device is not found, type the address the first device shows instead.
4. Choose **Sync now**. The first sync between two devices changes nothing until you have seen what it would do and chosen **Start the sync**.

After that, the devices sync by themselves while both are on and can see each other. Some things worth knowing:

- **A pairing belongs to one notes folder:** the folder that was open when you paired. Settings, Sync shows which. With another folder open, that device does not sync, so folders never mix. To use a pairing with a different folder, open that folder and choose **Sync it with this folder instead**.
- **Editing the same page on both devices:** both versions are kept. The older one is saved next to it as a copy.
- **Deleting a page:** a page deleted on one device goes to the trash on the other, never straight away.
- **Wi-Fi only:** a phone can be set to sync with a device only on Wi-Fi (**Sync with this device only on Wi-Fi**). A hotspot or a cable counts as Wi-Fi here: it never uses mobile data.
- **Android in the background:** on Android, syncing happens while ScaleNote is open, so open the app to catch up.
- **Pausing:** **Pause sync** stops all syncing until you resume it or close the app.
- **Privacy:** the connection between two devices is encrypted. Other devices on the network can see that they talk, but not what they send.

### Without Wi-Fi or internet: a hotspot or a cable

Sync never needs the internet. The devices only have to be on one network together, and you can make that network yourself, for example on a school network that keeps devices apart, on a train, or with no connection at all.

- **Hotspot from the phone.** Turn on the phone's hotspot (mobile data can be off) and join it on the laptop. Then open ScaleNote on both. They find each other as at home.
- **Hotspot from the laptop.** On Linux, turn on the Wi-Fi hotspot in the network settings; on Windows, Settings, Network, Mobile hotspot (Windows may only offer it while it is connected itself). Join it on the phone or tablet.
- **USB cable.** Connect the phone to the computer and turn on **USB tethering** in the phone's hotspot settings. This is usually faster and steadier than Wi-Fi.
- **Cable between two computers.** An Ethernet cable directly between them works too.

Devices that are already paired need nothing else. To pair over a hotspot or cable, do it as above; the pairing screen shows every address this device has (for example its home address and its hotspot address), so if the device is not found you can type the one on the shared network.

## 4. Optional: a home server

A home server is a computer you run yourself, for example a small Linux machine, that keeps a copy of your notes and is always on. Your other devices can then sync with it even when they are not on at the same time. Setting it up takes a Linux command line; the steps are in [home-server.md](home-server.md).

To use two server vaults on one phone, pair with each one while the matching notes folder is open on the phone.

To reach your server from outside your home, use a private network you set up yourself, such as Tailscale. Do not open the server's ports to the internet.

## 5. Optional: lock ScaleNote

Settings, This device, **Turn on the lock**: choose a PIN (numbers) or a passcode, and type it twice. ScaleNote then asks for it when it starts and again after the time away you choose. On an Android phone you can also unlock with a fingerprint or face.

What it does and does not do:

- **What it does:** it keeps someone who picks up your device out of ScaleNote.
- **What it does not do:** it does not encrypt your pages. They stay ordinary files on the device.
- **If you forget the PIN:** ScaleNote cannot be opened on that device, and there is no way back. Your synced and backed-up copies are your safety net.

## 6. Optional: backups

On a computer, Settings, Files, **Make a backup** copies all your pages into a folder next to your notes folder, named after the time. A backup is an ordinary folder, and it is never changed afterwards.

**Restore** puts back what is missing and what you changed since, and deletes nothing. A page that is replaced is first saved in a hidden folder inside your notes folder.

Old backups are not removed by themselves, so delete the ones you no longer need.

## 7. When something is odd

| What you see | What to do |
|---|---|
| The other device is not found | Check that both are on the same network and that sync is on (and not paused) on both. Some guest networks keep devices apart; type the other device's address instead. |
| "That device belongs to another notes folder" | Open the folder shown next to the device in Settings, Sync, or move the pairing to the open folder there. |
| "Last sync did not finish" | Choose **Sync now** again when both devices are on. A sync that was cut off is simply redone; nothing is half written. |
| A copy of a page with a device name in it | Both devices changed that page. Compare the two, keep what you want, and delete the other. |
| The app is too big or too small | Ctrl + and Ctrl − zoom (Ctrl 0 goes back), or change Text size and Zoom under Settings, Look. |

To report a problem, open an [issue](../../../issues). Say which system and which ScaleNote version you use (Settings, About), and what you did before it went wrong. Do not paste private notes into an issue.
