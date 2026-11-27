# ScaleNote

A note-taking app that keeps your notes as plain markdown files in a normal folder. It has a block editor, a canvas for drawing with a pen next to the text, and search, tags, links between pages and page history. Because the notes are just files, you can open the same folder in Obsidian and nothing is locked inside the app.

**Status: early test versions (0.5.x). Notes and drawing work. Sync between your own devices works on the same network and over Tailscale. The calendar and the study assistant do not exist yet. Keep your own backup of anything you care about.**

## Current progress

*Last updated: 2026-11-27 (0.7.0 in progress, animations in pages: the file format is done, nothing shows in the app yet. latest version 0.6.9, built and waiting to be released: fixes after testing 0.6.8 on a laptop and a phone: both devices keep the sync list, so a renamed page no longer comes back under its old name, an edit no longer makes a conflict copy and the phone no longer shows "First sync"; Find in page takes all its marks away when closed and no longer jumps; writing on a PDF slide stays on the slide on every screen size, with a setting to keep its light-page colours in a dark theme; a page opens at the height it was left at; "Apply to all slides" sizes every page of a PDF at once; the inbox and Shared with me are at the top of the page list, pages have icons like folders, and a button next to the sync status shows the conflict copies; not tried on a real device yet; still open: a folder colour that did not reach a phone. Before that 0.6.8, released: the last version of the 0.6 line. Sync now waits for a sync that is running, tablet pen buttons that send a key can switch to the eraser, dark pen colours stay readable in a dark theme, "Available offline" is now "Keep on this device", and the whole 0.6 line had a security check. Not tried on a real device yet; next is the owner's test of several days with a laptop and a phone that each keep part of the folder. 0.6.7 released: folders sync, and pen writing over the text shows on the other device right after a sync. Then 0.7.0, animations in pages).*

- **0.6.6** (released, waiting for a test on real devices): share text, links, pictures and PDFs into ScaleNote from other apps (Android share menu, Send to and Open with on computers, files dropped on the page list), New page from the clipboard, the tray or Ctrl+Alt+N, and one box that asks whether it goes to a new page in the inbox or the open page. Before that 0.6.5: Settings has a Storage tab (how much room each folder and kind takes here, and Free up space), and search finds pages that are on your other devices by title and can search their text there. Before that 0.6.4: share a page or folder with someone nearby (right-click, Share…; they accept first and it goes in Shared with me on all their devices), both can edit, also offline, and while it is open changes arrive within seconds. Edits made on two devices, also your own, are now joined word by word instead of kept twice. Before that 0.6.3: choose per folder or page what each device keeps (right-click, Available offline); pages that are not here stay listed with a cloud icon and are brought from another device when opened. Before that 0.6.2: PDFs as pictures have no page limit (asks first when long) and PDFs may be up to 64 MB; folder colours survive a sync; two fingers move and zoom while Finger draws is on; devices check for changes every 30 seconds; less memory when closed to the tray; sync times in local time. Before that 0.6.1 (sync without Wi-Fi or internet, over a hotspot, USB tethering or a cable), 0.6.0 (groundwork for choosing what each device keeps offline; the settings come in 0.6.3), 0.5.9 (the canvas can start at the top left, like a page), 0.5.8 (Tailscale sync, a cleaner Settings and per-page options) and 0.5.7, fixes from the first test of sync between a computer and a tablet. Before that 0.5.6 (app lock, zoom, updates from inside the computer app) and 0.5.5 (the home server program). Sync between a computer and a tablet was tried by the owner and works.
- **Done in 0.5 (sync between your own devices):**
  - 0.5.0: the groundwork. The app can work out what two copies of your notes would need to become the same. Nothing is sent. Adding a PDF as pictures runs in the background.
  - 0.5.1: pairing. Two devices trust each other after a one-time code. Paired devices can be listed and removed.
  - 0.5.2: "Find devices", so the address does not have to be typed. A device only announces itself while its pairing code is showing.
  - 0.5.3: the sync. Only changed files are sent, the first sync asks first, a page changed on both devices is kept in both versions, deleted pages go to the other device's trash. Also a status line, Pause and Compare, renaming a device, noticing changes made by other programs, and a conflict copies screen.
  - 0.5.4: Android: the phone can find other devices while the app is open, the back gesture goes to the previous page, and sync can be limited to Wi-Fi per device. Also Back and Forward buttons, a Find button, a true black theme, Settings search and Reset to defaults, and the app starts on the page you had open last. Themes are cards under an Auto/Light/Dark switch, and Settings is a full-screen list on a phone.
  - 0.5.5: the home server program for Linux, backups, a colour per folder, security cards, tray and open at login, and the device list with last sync time and app version.
  - 0.5.9: a setting for the canvas to start at the top left, like a page in OneNote, instead of being open on every side.
  - 0.5.8: sync over Tailscale for school and public networks that keep devices apart (the address is found and shared by itself), much faster PDF import on phones, a cleaner Settings (devices first on Sync, a Privacy tab, bigger tick boxes), a cover and "Linked from" per page, pages that reopen in the view they were left in, canvas regions that can be moved and resized by a grip, a /canvas block that follows the pen in the split view, and Ctrl P to print.
  - 0.5.7: sync looks for changes every 5 seconds (an edit arrives in about 10 to 15 seconds), pen writing over text keeps its shape on a wider or narrower screen, and the app's log can be copied from About.
  - 0.5.6: an optional app lock (PIN or passcode, fingerprint on Android), each paired device tied to one notes folder, Find in PDF pages added as pictures, narrower PDFs, zoom, Shortcuts and About pages, smaller text on phones, updates from inside the computer app (signed), the phone back button closing Settings and other windows instead of the app, fingers on drawings fixed on Linux, a [setup guide](docs/setup-guide.md) and a [security checklist for all of 0.5](docs/security-checklist-0.5.md).
- **Next: 0.6**: choose per folder or page what each device keeps offline (also on computers), a storage page with "Free up space", sharing into ScaleNote from other apps, and quick capture, on Windows, Linux and Android. The plan is in [docs/v0.6-plan.md](docs/v0.6-plan.md). 0.6.0 (partial sync, no screens), 0.6.1 (hotspot and cable sync) 0.6.2 (fixes after testing) and 0.6.3 (offline choices in the app) are built; 0.6.4 (sharing pages and folders with other people, [plan](docs/v0.6.4-sharing.md)) and 0.6.5 (Storage page and search across devices) are built. Not yet tried on a real device: 0.6.4 (sharing between two devices on one network, joining edits between your own devices), 0.6.5 (Storage, Free up space, searching on another device) and 0.6.6 (share menu, Send to, Open with, shortcuts). 0.6.6 (sharing into ScaleNote and quick capture) is released, not yet tried on a real device. 0.6.7 (folders sync, pen writing over the text shows on the other device right after a sync) is released and was tried on a computer, a tablet and a phone. 0.6.8 (hardening and the release of 0.6) is built, not yet tried on a real device; still to do is the owner's test of several days with a laptop and a phone that keep only part of the folder. After 0.6, 0.7.0 adds animations in pages ([plan](docs/v0.7.0-animation.md)).
- **The 0.5 plan** is in [docs/v0.5-plan.md](docs/v0.5-plan.md). The browser client moved to a later release, the Fedora install check to v0.8.
- **Not tried on real devices yet:** everything in 0.6.9 (the sync list on both devices, Find in page, ink on slides, the page place, Apply to all slides, the page list and Settings changes), pen writing over the text showing on the other device right after a sync, and folders syncing (0.6.7), offline choices (0.6.3), sync over USB cable or a laptop's hotspot (the phone's hotspot works), two-finger moves with Finger draws, the window coming back from the tray, syncing between devices on 0.6.0, updating from inside the computer app (first try: 0.5.6 to 0.5.7), automatic sync without pressing Sync now, sync over Tailscale, pen writing on a tablet seen on a computer, the phone back button in Settings, the app lock and fingerprint unlock, the tray and open at login, the home server on a real server, the Android phone syncing, printing and export from the packaged app, selecting PDF text by touch.
- **Wanted, but after sync:** a list of further features is in [docs/features-to-implement.md](docs/features-to-implement.md).

## About the AI in this project

ScaleNote is a personal side project. I am making it to learn how to build software and because I need an app like this myself. **Most of the code is written by AI tools under human supervision.** Two people review the code, but they cannot review every line, so expect bugs. Please keep backups of your notes. The full explanation is in [AI_DISCLOSURE.md](AI_DISCLOSURE.md), and the app shows a short version the first time it starts.

## What works now

- **Plain files.** Every page is a markdown file with a few lines of settings at the top. Delete the app and your notes are still readable. Point Obsidian at the folder and it just works. Markdown the app does not know is kept exactly as it was written.
- **Block editor.** Slash menu, headings, lists, to-dos, quotes, code, callouts, toggles, tables, pictures, dividers, inline styles and colours, a handle to move and change blocks, and a markdown source view of the whole page.
- **Pages and folders.** A page list you can rearrange by dragging, folders and pages with icons and colours, favourites, tags, covers (off by default), and a trash.
- **Links.** `[[Wikilinks]]` between pages and a "Linked from" list under each page.
- **Search and commands.** One box to find pages by title and text and to run commands.
- **Page history and export.** Look at earlier versions of a page and restore one. Export a page or print it. Drawings are included when you print, and the page's drawing is added to a markdown export.
- **Drawing.** A canvas for each page, saved next to it as a small file. Pressure-sensitive pen, highlighter, shapes, sticky notes, eraser, a loop to select, move, recolour and delete, paper (rule lines and grids) and page colour, undo and redo. The highlighter sits behind the ink, and pen and highlighter strokes that go a little over a shape are cut at its edge. The page can be shown as text, as canvas, or both side by side.
- **Draw on the text.** Ink drawn over a paragraph, heading or list stays on it when the page changes shape.
- **Canvas regions.** `/canvas` shows a named region of the page's canvas inside the text, also inside callouts, toggles and columns.
- **Columns.** `/2 columns` or `/3 columns`, or drag a block to the side of another block.
- **PDF.** `/pdf` or drop a PDF on a page: scroll through it, or add every page as a picture to draw on. Text in a PDF can be selected and found.
- **Pictures.** Click a picture to resize it with handles.
- **Find in page.** Ctrl+F finds a word in all the text of a page and in the PDFs on it.
- **Pair your devices.** Two of your devices can trust each other with a one-time code and find each other on the same network. Notes are not exchanged yet; that is the next step.
- **Works offline.** No account, and nothing is sent anywhere. The one thing that goes online is an update check, which you can turn off in Settings.
- **Looks:** eight themes, five text sizes and a choice of page width.
- **Runs on:** Windows, Linux and Android. A browser version comes later.

## What is planned

The plan, in order, is in [PROGRESS.md](PROGRESS.md), and the reasons behind choices are in [DECISIONS.md](DECISIONS.md). In short:

- **Next (0.5):** sync between your own devices. Two devices on the same network share a notebook directly after pairing, with no server. An optional home server keeps a copy when your other devices are off. Android comes after the desktop apps. A browser client comes later.
- **Later:** calendar, templates, an optional study assistant (off by default and completely absent until you turn it on), flashcards, importers for other note apps, and a 3DS drawing app.

Version 1.0.0 is the notes, drawing and sync working on phone, tablet, laptop and desktop. The public release is 2.0.0, after a security review.

## Installing

These are test builds, published as pre-releases. Download the file for your system from the newest release on the [Releases page](../../releases), under Assets:

| System | File | How to install |
|---|---|---|
| Windows 10 and 11 | `.exe` or `.msi` | Open the file and follow the installer. Windows may warn about an unknown publisher, because test builds are not signed yet. |
| Windows, no install | `-portable.zip` | Unzip it and run `scalenote.exe`. |
| Linux Mint, Ubuntu, Debian | `.deb` | Open it with the software installer, or run `sudo apt install ./file.deb` in the download folder. |
| Fedora | `.rpm` | Open it with the software installer, or run `sudo dnf install ./file.rpm`. |
| Any Linux | `.AppImage` | Right-click the file, open Properties, allow running it as a program, then open it. |
| Android | `.apk` | Copy it to the device and open it. Android will ask you to allow installing from this source. Newer builds update over older ones. |

The [setup guide](docs/setup-guide.md) goes from installing to syncing your devices, a home server, the app lock and backups.

The first time the app starts it asks for a folder to keep your pages in. You can use the default folder, or pick one you already use with Obsidian. Under Settings you can check for updates, and the app tells you when a newer version is out.

## Building from source

You need Node.js (the current LTS version) and Rust (stable). On Linux you also need the packages Tauri uses; the list is in [`.github/workflows/build.yml`](.github/workflows/build.yml). Library versions are pinned, so use `npm ci` and not `npm install`.

```
npm ci
npm run build            # builds the interface into dist/
npx tauri build          # builds the packaged app for your system
```

Tests:

```
npm test                                      # rules and file handling (JavaScript)
cd src-tauri/core && cargo test               # the Rust core
npx playwright install chromium               # once
node tests/editor.spec.mjs                    # the interface in a browser, against the built dist/
```

Run `npm run build` before the browser tests, because they test the built interface. Pushing a pull request runs all of this on Windows and Linux and builds the Android file. How the work is organised, and the rules for code and design, are in [CLAUDE.md](CLAUDE.md).

## Reporting problems

Open an [issue](../../issues) and say which system you use, which version of ScaleNote, and what you did before it went wrong. Please do not paste private notes into an issue.

## Star History

<a href="https://www.star-history.com/">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=catman-hugo/scalenote-app&type=date&theme=dark&legend=top-left" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=catman-hugo/scalenote-app&type=date&legend=top-left" />
   <img alt="Star History Chart" src="https://api.star-history.com/chart?repos=catman-hugo/scalenote-app&type=date&legend=top-left" />
 </picture>
</a>

The chart is drawn by an outside service (star-history.com) when this page is opened, so your browser loads an image from it. Nothing in the app itself uses it.

## Licence

No licence has been chosen yet. Until one is added, the code can be read but not reused.
