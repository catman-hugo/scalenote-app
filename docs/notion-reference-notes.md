# Reference notes: how Notion does the selection menu and the block handle

Source: eight dark-theme and four light-theme screenshots from the owner (2026-11-04). These are notes about behaviour to learn from, not a request to copy the look. The design rules in CLAUDE.md still win (flat, one icon set, no emoji, no AI element).

## Selection menu (appears when text is selected)

A small floating panel with:
1. A block type row at the top ("Heading 1" with an arrow). It opens the full "Turn into" list: text, four heading levels, lists, to-do, toggle, code, quote, callout, and 2 to 5 columns.
2. A row of text styles: colour, bold, italic, underline, clear formatting.
3. A second row: link, strikethrough, code, equation, and a "more" button.
4. The colour button opens a panel: recently used, ten text colours, ten background colours.
5. The link button opens one input ("Paste link or search pages") with a list of recent pages under it. This is where note-to-note links will fit in 0.3.

Rows that do not apply to ScaleNote: comment, emoji reaction and "Edit with AI". There is no AI element in the interface by default, and there is only one user.

What ScaleNote has today: a bar with bold, italic, strike, code and link, and no block type row.

Proposed use:
- 0.2.1 or 0.2.2: add the block type row to the selection bar by reusing the existing "Turn into" code.
- Underline, colour and background colour wait for the owner's html styles decision, because markdown has no way to store them.
- 0.3: the link input also searches notes by title when wikilinks arrive.
- Clear formatting is a small, safe addition.

## Block handle

1. Hovering a block shows two small buttons left of it: a plus (add a block below) and the drag dots. Both are centred on the first line of the block, also for headings.
2. Hovering the dots gives the dots a soft background and a tooltip: "Drag to move. Click or Ctrl+/ to open menu."
3. Pressing and holding keeps the dots highlighted.
4. While dragging, a half see-through copy of the block follows the cursor, at the same distance from the cursor as when it was grabbed. The original stays where it was until the drop.
5. Drop position is shown by one blue line, and where the cursor is decides what it means:
   - Near the left edge of a block: a vertical line on its left. Dropping makes two columns with the dragged block on the left.
   - Below (or above) a block: a horizontal line the width of the block. Dropping puts the block between blocks.
   - Near the right edge: a vertical line on its right. Dropping makes two columns with the dragged block on the right.
6. After the drop in picture 8 the two blocks sit side by side, and the dragged heading wraps because its column is narrower.

What ScaleNote has today: a horizontal drop line only, no plus button, no preview, no side drop zones, and the grabbed handle stays visible.

Proposed use:
- 0.2.1: handle centred on the first line (matches point 1), grabbed handle hidden during the drag.
- 0.2.2: drag preview that keeps the grab offset (point 4), and a plus button and tooltip if the owner wants them (points 1 and 2).
- Columns slice: left and right drop zones with vertical lines (point 5). Needs the storage format decision first.

## What the columns decision now has to cover

Notion lets you drop on the left or right of any block and keeps adding columns. So the storage format must hold two or more columns, each holding several blocks, and must still be readable as plain markdown in Obsidian. Whether Obsidian shows the columns as columns depends on the format chosen. I have not checked which Obsidian community plugins use which syntax, and I will check their documentation before proposing a final format.
