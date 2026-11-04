// Every sentence the user sees lives here, not in the screen code, so the app can be
// translated later without touching the screens. English only for now.
export const strings = {
  appName: "ScaleNote",

  welcome: {
    title: "Welcome to ScaleNote",
    body: "Your notes are plain markdown files in a normal folder. Choose where that folder is.",
    chooseFolder: "Choose a folder",
    useDefault: "Use the default folder",
    defaultHint: "The default folder is created for you if it does not exist yet.",
  },

  disclosure: {
    title: "About this app",
    points: [
      "ScaleNote is a personal side project. Most of the code is written by AI tools. A person decides what is built and tests it on real devices.",
      "Nothing has been reviewed by an independent security expert yet. Expect bugs. Some may damage or lose notes.",
      "Keep your own backups. Your notes are plain files in a folder, so any backup tool works.",
    ],
    accept: "I understand",
  },

  sidebar: {
    notes: "Notes",
    newNote: "New note",
    newFolder: "New folder",
    openFolder: "Open another folder",
    empty: "No notes yet. Use New note to write the first one.",
    truncated: "This folder is very large. Only part of it is listed.",
    toggle: "Show or hide the note list",
    penTest: "Pen test",
    collapse: "Collapse folder",
    expand: "Expand folder",
  },

  editor: {
    titleLabel: "Note title",
    placeholder: "Type / for blocks",
    noNoteOpen: "Open a note from the list, or create a new one.",
    rawLabel: "Kept exactly as written",
    saved: "Saved",
    saving: "Saving",
    unsaved: "Not saved yet",
  },

  slash: {
    text: "Text",
    heading1: "Heading 1",
    heading2: "Heading 2",
    heading3: "Heading 3",
    heading4: "Heading 4",
    bulletList: "Bulleted list",
    orderedList: "Numbered list",
    taskList: "To-do list",
    quote: "Quote",
    codeBlock: "Code block",
    divider: "Divider",
    callout: "Callout",
    toggle: "Toggle",
    table: "Table",
    image: "Image",
    noResults: "No matching block",
  },

  format: {
    barLabel: "Text formatting",
    bold: "Bold",
    italic: "Italic",
    strike: "Strikethrough",
    code: "Code",
    link: "Link",
    boldMark: "B",
    italicMark: "I",
    strikeMark: "S",
    codeMark: "</>",
    linkMark: "Link",
    linkLabel: "Link address",
    linkPlaceholder: "Paste or type an address",
    linkApply: "Apply",
    linkRemove: "Remove link",
    linkCancel: "Cancel",
    linkRefused: "Only web and mail addresses can be used as a link.",
  },

  callout: {
    kindLabel: "Callout type",
    titleLabel: "Callout title",
    titlePlaceholder: "Title",
    kinds: {
      note: "Note",
      info: "Info",
      tip: "Tip",
      success: "Success",
      question: "Question",
      warning: "Warning",
      danger: "Danger",
      example: "Example",
      quote: "Quote",
    },
  },

  toggle: {
    fold: "Show or hide the toggle content",
    foldMark: "▾",
    summaryLabel: "Toggle title",
    summaryPlaceholder: "Toggle title",
  },

  table: {
    barLabel: "Table",
    addRow: "Add row",
    addColumn: "Add column",
    deleteRow: "Delete row",
    deleteColumn: "Delete column",
    deleteTable: "Delete table",
  },

  image: {
    missing: "This picture could not be shown. The file is missing or not a supported picture.",
    altLabel: "Picture description",
    altPlaceholder: "Describe the picture",
  },

  newNoteTitle: "Untitled",
  newFolderName: "New folder",
  conflictCopySuffix: "conflict copy",

  messages: {
    conflict:
      "This note was changed by another program while you were editing. The version on disk was loaded, and your edits were saved as a separate note.",
    conflictCopyFailed:
      "This note was changed by another program. The version on disk was loaded. Your edits could not be saved as a copy.",
    saveFailed: "The note could not be saved. Your text is still on screen. Trying again.",
    dismiss: "Dismiss",
  },

  // Shown for each error code the app can return. Unknown codes use "unknown".
  errors: {
    not_found: "That file or folder was not found.",
    not_a_directory: "That is not a folder.",
    invalid_path: "That name or location is not allowed.",
    not_a_note: "That is not a markdown note.",
    too_large: "That file is too large to open safely.",
    not_utf8: "That file is not plain text, so it was not opened.",
    conflict: "The file was changed by another program.",
    already_exists: "Something with that name already exists.",
    io: "The computer could not read or write that file.",
    no_vault: "No folder is open.",
    unknown: "Something went wrong.",
  },
};
