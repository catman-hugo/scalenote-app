# Decisions

An append-only log of choices that are hard to undo. Add an entry when a choice is not obvious, when a new dependency is added (with its licence), or when a feature is built in a narrower form than planned.

Entry format:

```
## YYYY-MM-DD: one-line decision
Context. What forced a choice.
Decision. What was done.
Alternatives. What was not done, and why.
Cost. What this gives up, and what it would take to undo it.
```

## 2026-11-03: Start a new repository instead of continuing the two earlier attempts
Context. Two earlier attempts (a web client-server app and a local-first desktop app) stalled. One kept notes in a database with images inside, the other had a very large plan and little finished.
Decision. Start fresh. Use the earlier attempts only as reference for ideas and for what went wrong.
Alternatives. Continue the local-first attempt. Its plan was much larger than what was built, so the cost of understanding and trimming it was about the same as starting again.
Cost. Some solved problems have to be solved again.

## 2026-11-03: Notes are markdown files in a normal folder
Context. Users must be able to switch to or from other apps such as Obsidian by pointing at a folder.
Decision. The vault is a folder of markdown files. A search index is allowed only as a cache that can be rebuilt from the files.
Alternatives. A database as the main store. Rejected because notes could not leave the app.
Cost. Sync and merging need extra care, because files have no built-in history.

## 2026-11-03: Peer-to-peer is direct only, over the local network and Tailscale
Context. Peer-to-peer is the backup when the home server is down, so it must not need another server.
Decision. Direct connections only, no relay and no hole punching. One-time share codes. The network library is chosen in a short spike at the start of version 1.6.
Alternatives. A relay service. Rejected because it adds a server that can fail and see connection details.
Cost. Two devices on different networks without Tailscale need port forwarding.

## 2026-11-03: Google Calendar two-way sync is not built
Context. An app that has not passed Google's verification has login that expires every 7 days.
Decision. Two-way sync uses CalDAV (iCloud, Nextcloud). Google Calendar is read-only through its secret link.
Alternatives. Pass Google's verification. Rejected by the owner.
Cost. Google calendars cannot be edited from ScaleNote.
