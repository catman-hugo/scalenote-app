// "Available offline": what this device keeps of one folder or page (0.6.3). The rules are in
// Rust (keep.rs); this box only shows what holds and lets the person change it:
// - follow the folder above (the choice is inherited, and the box says from where), or
// - choose for this folder or page: which kinds to keep here (text, drawings, pictures, other
//   files). Keeping none of them means the folder is only listed here, with a cloud icon.
// Everything not kept stays on the other devices; switching something off only removes copies
// another device has (Rust checks that).

import { strings } from "./strings.js";
import { KINDS, choiceFor, kindLetters, kindSet } from "./offlinerules.js";

function make(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

const fill = (text, values) => text.replace(/\{(\w+)\}/g, (_, key) => (key in values ? String(values[key]) : `{${key}}`));

// "Text, drawings and pictures", "Nothing (only listed)", "Everything".
export function describeKinds(kinds) {
  const t = strings.offline;
  const set = kindSet(kinds);
  if (set.size === KINDS.length) return t.everything;
  if (set.size === 0) return t.nothing;
  const names = KINDS.filter((k) => set.has(k)).map((k) => t.kindNames[k]);
  const joined = names.length === 1 ? names[0] : `${names.slice(0, -1).join(", ")} ${t.and} ${names[names.length - 1]}`;
  return joined.charAt(0).toUpperCase() + joined.slice(1);
}

/**
 * Opens the box for `path` ("" is the whole notes folder). `choices` is the list from the backend.
 * `save(kinds)` is called with letters, or null to follow the folder above; it resolves when the
 * change is made. Resolves to true when something was saved.
 */
export function openOfflineDialog(dialog, { path, name, choices, save }) {
  const t = strings.offline;
  const own = (choices || []).find((c) => c.path === path);
  // What would hold here without a choice of its own: the choice of the nearest folder above.
  const above = choiceFor((choices || []).filter((c) => c.path !== path && c.path.length < path.length), path);
  return new Promise((resolve) => {
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      dialog.removeEventListener("cancel", onCancel);
      dialog.close();
      resolve(value);
    };
    const onCancel = () => finish(false);

    const title = make("h2", "", path ? fill(t.title, { name }) : t.titleWhole);
    const group = `offline-mode-${Math.random().toString(36).slice(2)}`;
    const radio = (value, label, checked) => {
      const row = make("label", "setting-row offline-mode");
      const input = make("input");
      input.type = "radio";
      input.name = group;
      input.value = value;
      input.checked = checked;
      row.append(input, make("span", "", label));
      return { row, input };
    };
    const inheritedText = above.from === null ? t.followDefault : fill(t.followFrom, { folder: above.from || t.wholeFolder, what: describeKinds(above.kinds) });
    const follow = radio("follow", inheritedText, !own);
    const chooseHere = radio("own", path ? t.chooseHere : t.chooseWhole, Boolean(own));

    const picked = kindSet(own ? own.kinds : above.kinds);
    const boxes = KINDS.map((kind) => {
      const row = make("label", "setting-row offline-kind");
      const input = make("input");
      input.type = "checkbox";
      input.dataset.kind = kind;
      input.checked = picked.has(kind);
      row.append(input, make("span", "", t.kinds[kind]));
      return { row, input };
    });
    const kindList = make("div", "offline-kinds");
    kindList.append(...boxes.map((b) => b.row));
    const paint = () => {
      const enabled = chooseHere.input.checked;
      for (const box of boxes) box.input.disabled = !enabled;
      kindList.classList.toggle("is-disabled", !enabled);
    };
    follow.input.addEventListener("change", paint);
    chooseHere.input.addEventListener("change", paint);

    const hint = make("p", "setting-hint", t.hint);
    const problem = make("p", "setting-hint offline-problem");
    problem.hidden = true;
    const cancel = make("button", "", t.cancel);
    cancel.type = "button";
    cancel.addEventListener("click", () => finish(false));
    const ok = make("button", "primary", t.save);
    ok.type = "button";
    ok.id = "offlineSave";
    ok.addEventListener("click", async () => {
      const kinds = chooseHere.input.checked ? kindLetters(new Set(boxes.filter((b) => b.input.checked).map((b) => b.input.dataset.kind))) : null;
      ok.disabled = true;
      try {
        await save(kinds);
        finish(true);
      } catch (error) {
        ok.disabled = false;
        problem.hidden = false;
        problem.textContent = (error && strings.errors[error.code]) || strings.errors.unknown;
      }
    });
    const actions = make("div", "dialog-actions");
    actions.append(cancel, ok);
    // The whole notes folder has nothing above it to follow: its own choice is always used.
    const modes = path ? [follow.row, chooseHere.row] : [];
    if (!path) chooseHere.input.checked = true;
    dialog.replaceChildren(title, ...modes, kindList, hint, problem, actions);
    paint();
    dialog.addEventListener("cancel", onCancel);
    if (!dialog.open) dialog.showModal();
    (path ? (own ? chooseHere.input : follow.input) : boxes[0].input).focus();
  });
}
