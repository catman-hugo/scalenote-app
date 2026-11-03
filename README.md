# ScaleNote

A note-taking app that keeps your notes as plain markdown files in a normal folder. It has a block editor, drawing with a pen, a calendar, and an optional study assistant. Because the notes are just files, you can open the same folder in Obsidian and nothing is locked inside the app.

**Status: planning is finished and building has just started. There is nothing to download or install yet.**

## About the AI in this project

ScaleNote is a personal side project. I am making it to learn how to build software and because I need an app like this myself. **Most of the code is written by AI tools under human supervision.** Two people review the code, but they cannot review every line, so expect bugs. Please keep backups of your notes. The full explanation is in [AI_DISCLOSURE.md](AI_DISCLOSURE.md), and the app shows a short version the first time it starts.

## What it is going to be

- **Plain files.** Every note is a markdown file with a few lines of settings at the top. Delete the app and your notes are still readable. Point Obsidian at the folder and it just works.
- **Works offline everywhere.** Every version of the app works without internet. A home server is optional and only used to keep your devices in sync.
- **Runs on:** Windows, Linux, Android phones and tablets, and in a web browser. A 3DS drawing app comes later.
- **Drawing.** Pressure-sensitive pen, highlighter, shapes and a free canvas, alongside the text.
- **Sync without a server.** If your home server is down, two devices on the same network or Tailscale can share a notebook directly with a one-time code.
- **Calendar.** Events are notes, and they can link to your pages and notebooks.
- **Study assistant (optional).** Off by default and completely absent until you turn it on. You can connect your own account with a cloud provider, or use a local model.

The plan, in order, is in [PROGRESS.md](PROGRESS.md). The first goal (version 1.0.0) is the notes, drawing and sync working on phone, tablet, laptop and desktop. The public release is version 2.0.0, after a security review.

## Installing

There are no releases yet, so there is nothing to install.

When there are, they will be on the [Releases page](../../releases):

| System | What you will download |
|---|---|
| Windows 10 and 11 | an installer (`.msi` or `.exe`), and a portable zip |
| Linux | `.deb`, `.rpm`, or an AppImage |
| Android | an `.apk` file |

This section will be updated with step-by-step instructions for each system when the first release is ready.

## Building from source

Not available yet. This section will explain how to build the app on your own computer when the first version is ready.

## Reporting problems

Open an [issue](../../issues) and say which system you use, which version of ScaleNote, and what you did before it went wrong. Please do not paste private notes into an issue.

## Licence

No licence has been chosen yet. Until one is added, the code can be read but not reused.
