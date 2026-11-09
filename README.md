# ScaleNote

A note-taking app that keeps your notes as plain markdown files in a normal folder. It has a block editor, a canvas for drawing with a pen next to the text, and search, tags, links between pages and page history. Because the notes are just files, you can open the same folder in Obsidian and nothing is locked inside the app.

**Status: early test versions (0.4.x). The notes and drawing parts work, but sync, the calendar and the study assistant do not exist yet. Keep your own backup of anything you care about.**

## About the AI in this project

ScaleNote is a personal side project. I am making it to learn how to build software and because I need an app like this myself. **Most of the code is written by AI tools under human supervision.** Two people review the code, but they cannot review every line, so expect bugs. Please keep backups of your notes. The full explanation is in [AI_DISCLOSURE.md](AI_DISCLOSURE.md), and the app shows a short version the first time it starts.

## What works now

- **Plain files.** Every page is a markdown file with a few lines of settings at the top. Delete the app and your notes are still readable. Point Obsidian at the folder and it just works. Markdown the app does not know is kept exactly as it was written.
- **Block editor.** Slash menu, headings, lists, to-dos, quotes, code, callouts, toggles, tables, pictures, dividers, inline styles and colours, a handle to move and change blocks, and a markdown source view of the whole page.
- **Pages and folders.** A page list you can rearrange by dragging, folders with icons and colours, favourites, tags, covers (off by default), and a trash.
- **Links.** `[[Wikilinks]]` between pages and a "Linked from" list under each page.
- **Search and commands.** One box to find pages by title and text and to run commands.
- **Page history and export.** Look at earlier versions of a page and restore one. Export a page or print it.
- **Drawing.** A canvas for each page, saved next to it as a small file. Pressure-sensitive pen, highlighter, shapes, sticky notes, eraser, a loop to select, move, recolour and delete, paper (rule lines and grids) and page colour, undo and redo. The highlighter sits behind the ink, and pen and highlighter strokes that go a little over a shape are cut at its edge. The page can be shown as text, as canvas, or both side by side.
- **Works offline.** No account, and nothing is sent anywhere. The one thing that goes online is an update check, which you can turn off in Settings.
- **Looks:** eight themes, five text sizes and a choice of page width.
- **Runs on:** Windows, Linux and Android. A browser version comes later.

## What is planned

The plan, in order, is in [PROGRESS.md](PROGRESS.md), and the reasons behind choices are in [DECISIONS.md](DECISIONS.md). In short:

- **Next (0.4.x):** drawing over text, a `/canvas` block inside a page, importing a PDF as pages to draw on.
- **0.5:** an optional home server to keep devices in sync, and a browser client. Without a server, two devices on the same network will be able to share a notebook directly with a one-time code.
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

## Licence

No licence has been chosen yet. Until one is added, the code can be read but not reused.
