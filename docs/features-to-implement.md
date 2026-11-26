# Features to implement

Written 2026-11-17 from the owner's decisions. These are features the owner wants in ScaleNote that are **not yet given a version number**.

## How to read this file

- **Priority.** The current work is sync between the owner's own devices (`docs/v0.5-plan.md`). Everything here comes **after** that, unless it is marked as close to the sync work. Nothing here changes the version that is being built now.
- **Before building one of these**, read `PROGRESS.md` first. Some items extend something that already exists (tags, export, themes, the quick switcher, toggles and callouts). Build the part that is missing, not a second copy.
- **Opt-in rule.** Anything that suggests, shows or collects something on its own is **off until the user switches it on**. This covers suggested connections between pages, home widgets, the calendar, app lock, and statistics. It follows the same rule as the AI assistant: when a feature is off, no part of it is loaded and nothing for it appears in the interface.
- **Each feature gets its own slice**, its own branch and pull request, and the usual checks from `CLAUDE.md`.

## Decide early (hard to change later)

- **Settings are described as data once**, and each screen is built from that description. A computer shows a sidebar, a phone shows a full-screen list. Platform-only settings (for example tray or open at login) are simply not listed on platforms that cannot use them.
- **The layout follows the window width, not the kind of device.** A narrow window, a zoomed-in computer and a tablet in portrait all use the compact layout. Test every screen at the smallest and largest zoom early.
- **Per-folder settings** change the data model (see "Project folders" below). Decide where they are stored before building them.
- **How a toggle heading is saved in the markdown file** (decided below).
- **How a drawing is named and embedded in a page** (see "Drawings").

## Close to the sync work

These overlap with what is being built now and are the cheapest to pull forward if the owner wants:

- The list of paired devices, with rename and remove.
- A sync status page.
- The plain explanation of security choices.

## Editor

- **Math.** See "Editor: richer writing" below.
- **Toggle headings.** Any heading can be a toggle heading, and can be turned back into a normal one, one heading at a time (not only as a global setting).
  - Made from the slash menu with `/toggle_heading` or `/heading`, or by typing `#>` for a toggle heading and `#` for a normal one.
  - In the file it is a normal heading followed by an invisible marker, for example `## Title <!-- toggle -->`. Other programs, Obsidian included, show a normal heading. `#>` is only a typing shortcut and is never written to the file.
  - Folded or open state is a view setting, not saved in the file. Pages with toggles still open with toggles folded the first time (see `PROGRESS.md`).
- **Smart typing.** For example `->` becomes an arrow, and a checked to-do item moves down the list. Each one can be switched off.
- **Customisable toolbar and sidebar.** Choose the toolbar position (top or bottom), and move buttons between the bar, a hidden list and the plus menu. Hidden buttons still work by shortcut and by typing. The sidebar content can be arranged the same way.
- **Suggested connections between pages.** Opt-in only. It may use a small model that runs on the device, so nothing leaves it. It must follow the AI rules in `CLAUDE.md` (off means no code and no interface element).

## Editor: richer writing (requested 2026-11-18)

Asked for after looking at another note app's feature list. Each is its own slice. Build order is the owner's to pick. The ones that need a file format chosen first are marked **decide**.

- **Footnotes.** Standard markdown `[^1]` in the text and `[^1]: note` at the end, so other programs read them. A small number in the text jumps to the note and back. Slash item and typing `[^1]`.
- **Code in many languages.** Fenced code already exists. Add a language name on the block (click it to pick another), colouring by language, a long block that opens folded with "Show all lines", and an optional title. The language is the normal fence label, so other programs read it. **Decide** how a title is written (for example after the language on the fence line).
- **Copy box.** A block that holds one thing to copy, with a copy button. **Decide** how it is saved so other programs show something sensible (for example a fenced block with its own label).
- **Math.** Formatted maths in a line (`$a^2$`) and on its own line (`$$ ... $$`), the standard markdown way. Needs a maths renderer that works offline; check its licence and size first. This replaces the older "math blocks" line above.
- **Table formulas.** Simple sums in a cell: SUM, AVERAGE, and likely MIN, MAX, COUNT. The cell shows the answer and the page keeps the formula. **Decide** the file format: other programs have no formulas, so the formula text and its answer both have to be stored in a way that stays readable in a plain table.
- **Better table controls.** A bar for the selected cell (add or remove row and column, move them, colour a cell or row, sort by a column, resize a column, align a column left, centre or right). Check first what the table already does.
- **Different sizes and fonts inside one sentence.** Small, normal and large, and a few fonts (plain, serif, monospace), applied to the selected words. **Decide** the format: it has to be an inline marker that other programs ignore or show as plain text, like the colour markers.
- **Paragraph alignment.** Centre and right for a whole paragraph, never a single word. **Decide** the format, same reason.

Every one of these keeps the rule that a page opened and not changed is written back byte for byte, and that unknown syntax is kept as written.

## Organising

- **Tag colours.** Tags exist; colours for them do not. A coloured tag can tint the whole page entry, only its icon, or nothing (a setting).
- **Archive and bookmarks.** Archived pages stay out of "All" by default.
- **Tabs with back and forward.** Open pages in tabs and step back and forward through the pages seen.
- **Sidebar by content type, with counts.** Pages, tasks, drawings, files and so on, each with a count, and a way to hide types that are not used.
- **List settings.** Grid or list view, which types appear in "All", and reopening the last page.
- **Project folders.**
  - A colour for each project folder. (Icons per page and per folder already exist.)
  - A keyboard shortcut to switch project folders, and the last folder is remembered on each device.
  - Per-folder settings: a lock, which items are kept offline, and AI on or off.
  - Search stays inside the current folder by default.

## Time and tasks

- **Home screen with widgets.** Opt-in. For example a week strip and today's items.
- **Calendar.** Opt-in. One calendar showing events from other calendars, with `.ics` and web calendar import.
- **Reminders** with notification modes.
- **Date and time settings.** First day of the week, week numbers, and the date format (including ISO).
- **Custom trackers.** For example "how confident am I with this topic", from 0 to 10.

## Drawings

- **Drawings as files in the vault**, with a Drawings view in the sidebar and a way to embed a drawing inline in a page.
- Keep drawing shortcuts to one letter per tool (select, hand, rectangle, diamond, ellipse, arrow, line, pen, text, eraser, frame, laser pointer, keep tool).
- Test pen behaviour on the Android tablet and on Linux before calling any of this done.
- **Animations in pages** (asked for on 2026-11-26): `/animation` makes a block of steps drawn on the canvas, shown as steps, a video that plays once, or a loop. Given a version: 0.7.0, see `docs/v0.7.0-animation.md`.

## Import, export and integrations

- A wide list of importers, with a short guide for each. (The importers are already planned for 1.5.)
- Export in several formats, and a backup screen with a clear status and a restore button.
- **Default app for `.md` files.** An option in the settings of each device, not synced.
- **Add-only inbox for scripts**, a command-line tool, and an optional MCP server. All add-only: they can create pages but not open, change or delete them. The MCP server has its own switch, separate from the AI switch, and is off by default.

## Sync, devices and security

- **Device list** with rename and remove.
- **Sync status page.** Sync now, Pause, Compare, a recent activity log, and "Synced" always visible in the bottom bar. The status line may show where the sync happened (home network or home server). Word count may be an option there.
- **Security explanation.** Side-by-side cards that say plainly what each choice costs. Only for the modes ScaleNote has: local only, the owner's own server, and device to device. **There is no central server and there never will be.**
- **App lock.** Opt-in. A PIN or longer passcode, asked again after a set time, and biometrics where the device has them. Most people will not want the extra step at start-up.
- **Locked items never show their title in a notification.**

## App shell and settings

- **Settings structure.** Groups: your data, preferences, account or sync, this device, and about. A search box at the top, and a "Reset to defaults" button. A separate "This device" group makes clear which settings are not synced.
- **Themes.** Keep the existing themes. Add separate light and dark selection, favourites, a theme made of a few colours, a shareable theme code, and a contrast check.
- **Shortcuts page** with a printable cheat sheet, and single-key shortcuts behind one switch.
- **True-black theme** for OLED screens.
- **System options** per device: keep running in the tray, open at login, a global shortcut, and the app size.
- **About page** with the version, the release date, "What's new" and a link to the changelog.
- **Honest statements** about every outside request the app makes, off by default.
- **Zoom.** Ctrl + / Ctrl − / Ctrl 0, in steps from 80% to 200%, remembered per device. The compact layout switches on by width.
- **Statistics page.** Opt-in. Today's summary, this week against last week, a heatmap, and an hours chart. A writing streak is a separate, optional setting.

## Decided not to build

- A separate command palette. Ctrl+K stays search only.
- A second insert menu. The slash menu is the one place.
- A formatted / markdown view switch and an editor width setting (they already exist).
- Copy and paste options, an outline panel, find and replace as a separate feature, and a toggle for invisible characters.
- A web clipper browser extension.
- A language page. Only English and Dutch are planned.
- Extra security documents in the app's help. They are on GitHub.

## Not decided yet

- A bottom status strip in the editor. Proposal: fold it into the sync status line above.
