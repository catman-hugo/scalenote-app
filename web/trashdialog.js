// The trash: what was deleted, with Restore, Delete forever and Empty trash.
//
// Nothing here removes a file without asking again. The question is shown inside the box
// (not as a browser pop-up, which some systems block and which cannot be styled or read
// reliably on a phone), and Cancel is the focused button, so pressing Enter by accident
// keeps everything.

import { strings } from "./strings.js";

function make(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function button(text, onClick, className) {
  const node = make("button", className || "", text);
  node.type = "button";
  node.addEventListener("click", onClick);
  return node;
}

function fill(text, values) {
  return text.replace(/\{(\w+)\}/g, (_, key) => String(values[key] ?? ""));
}

function displayName(item) {
  return item.name.replace(/\.md$/i, "");
}

// Seconds since 1970 as a date in the person's own format. A missing time (0) shows nothing.
function dateText(seconds) {
  if (!seconds) return "";
  return new Date(seconds * 1000).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

/**
 * Opens the trash in `dialog`. `api` has { list, restore, deleteForever, empty } (the backend),
 * `onRestored(path, name)` and `onChanged()` let the page list update, and `onError(error)`
 * logs a problem and returns the sentence to show in the box.
 */
export async function openTrash(dialog, { api, onRestored, onChanged, onError }) {
  const t = strings.trash;
  let items = [];
  // Which question is showing: an item id, "all", or nothing.
  let asking = null;
  // A problem is shown inside the box: the banner of the page is behind the dark backdrop.
  let message = "";

  async function reload() {
    try {
      items = await api.list();
    } catch (error) {
      items = [];
      message = onError(error);
    }
    draw();
  }

  async function run(work) {
    message = "";
    try {
      await work();
    } catch (error) {
      message = onError(error);
    }
    asking = null;
    onChanged();
    await reload();
  }

  function itemRow(item) {
    const row = make("li", "trash-row");
    const text = make("div", "trash-text");
    const name = make("span", "trash-name", displayName(item));
    if (item.is_folder) name.append(make("span", "trash-kind", t.folderKind));
    const where = item.from ? fill(t.from, { folder: item.from }) : t.fromTop;
    const when = dateText(item.deleted_at);
    text.append(name, make("span", "trash-meta", when ? `${where} · ${fill(t.deletedOn, { date: when })}` : where));
    row.append(text);

    const actions = make("div", "trash-actions");
    if (asking === item.id) {
      actions.append(make("span", "trash-question", t.confirmOne));
      const cancel = button(t.cancel, () => { asking = null; draw(); });
      actions.append(cancel, button(t.confirmYes, () => run(() => api.deleteForever(item.id)), "danger"));
      queueMicrotask(() => cancel.focus());
    } else {
      actions.append(
        button(t.restore, () => run(async () => {
          const path = await api.restore(item.id);
          onRestored(path, displayName(item));
        })),
        button(t.deleteForever, () => { asking = item.id; draw(); }),
      );
    }
    row.append(actions);
    return row;
  }

  function draw() {
    dialog.replaceChildren(make("h2", "", t.title), make("p", "setting-hint", t.hint));
    if (message) {
      const problem = make("p", "trash-error", message);
      problem.setAttribute("role", "alert");
      dialog.append(problem);
    }
    if (!items.length) {
      dialog.append(make("p", "trash-empty", t.empty));
    } else {
      const list = make("ul", "trash-list");
      list.setAttribute("aria-label", t.listLabel);
      for (const item of items) list.append(itemRow(item));
      dialog.append(list);
    }
    const foot = make("div", "dialog-actions");
    if (items.length && asking === "all") {
      foot.append(make("span", "trash-question", t.confirmAll));
      const cancel = button(t.cancel, () => { asking = null; draw(); });
      foot.append(cancel, button(t.confirmYes, () => run(() => api.empty()), "danger"));
      queueMicrotask(() => cancel.focus());
    } else {
      if (items.length) foot.append(button(t.emptyTrash, () => { asking = "all"; draw(); }));
      foot.append(button(t.close, () => dialog.close(), "primary"));
    }
    dialog.append(foot);
  }

  dialog.classList.add("trash-dialog");
  await reload();
  if (!dialog.open) dialog.showModal();
}
