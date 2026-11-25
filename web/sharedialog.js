// Sharing a page or folder with other people (0.6.4). Two boxes:
// - Share: who it is shared with, the people nearby to share it with, and Stop sharing (for the
//   person who shared it) or Leave (for the others). Sharing happens in Rust (sync/shares.rs,
//   sync/service/sharing.rs); this box only shows it and passes the choice on.
// - An invitation: "Alice wants to share Biology with you", Accept or No.
// Names come from other people's devices, so they are only ever put in as text.

import { strings } from "./strings.js";

function make(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

const fill = (text, values) => text.replace(/\{(\w+)\}/g, (_, key) => (key in values ? String(values[key]) : `{${key}}`));

const messageFor = (error) => (error && strings.errors[error.code]) || strings.errors.unknown;

function button(label, className, id) {
  const element = make("button", className, label);
  element.type = "button";
  if (id) element.id = id;
  return element;
}

// Runs a modal box until `finish` is called; Escape closes it.
function runDialog(dialog, build) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      dialog.removeEventListener("cancel", onCancel);
      dialog.close();
      resolve(value);
    };
    const onCancel = (event) => {
      event.preventDefault();
      finish(false);
    };
    dialog.addEventListener("cancel", onCancel);
    build(finish);
    if (!dialog.open) dialog.showModal();
  });
}

/**
 * The Share box for `path` (a page `….md` or a folder). `share` is the share it is in already,
 * or null. `account` is this person's account ({ name }). `backend` gives peopleNearby,
 * shareWith and shareEnd. Resolves to true when something changed.
 */
export function openShareDialog(dialog, { path, name, folder, share, account, backend }) {
  const t = strings.sharing;
  return runDialog(dialog, (finish) => {
    let changed = false;
    const title = make("h2", "", fill(t.title, { name }));
    const status = make("p", "setting-hint share-status");
    status.id = "shareStatus";
    const close = button(t.close, "primary", "shareClose");
    close.addEventListener("click", () => finish(changed));
    const actions = make("div", "dialog-actions");
    const parts = [title];

    if (share && share.people.length) {
      parts.push(make("h3", "setting-subheading", t.sharedWith));
      const list = make("ul", "share-people");
      list.id = "sharePeople";
      for (const person of share.people) {
        const waiting = share.mine && share.state === "offered";
        list.append(make("li", "", waiting ? fill(t.waiting, { person }) : person));
      }
      parts.push(list);
    }

    if (share && !share.mine) {
      // Only the person who shared it adds people or stops it; the others may leave.
      parts.push(make("p", "setting-hint", fill(t.sharedBy, { person: share.ownerName })));
      const leave = button(t.leave, "", "shareLeave");
      leave.addEventListener("click", async () => {
        leave.disabled = true;
        try {
          await backend.shareEnd(share.id);
          finish(true);
        } catch (error) {
          leave.disabled = false;
          status.textContent = messageFor(error);
        }
      });
      actions.append(leave);
    } else if (!account || !account.name) {
      parts.push(make("p", "setting-hint", t.needName));
    } else {
      parts.push(make("h3", "setting-subheading", t.nearbyHeading));
      const nearby = make("ul", "share-nearby");
      nearby.id = "shareNearby";
      const look = button(t.lookAgain, "", "shareLook");
      const already = new Set(share ? share.people : []);
      const lookAround = async () => {
        look.disabled = true;
        status.textContent = t.looking;
        nearby.replaceChildren();
        try {
          const people = (await backend.peopleNearby()) || [];
          const others = people.filter((p) => !already.has(p.name));
          status.textContent = others.length ? "" : t.nobody;
          for (const person of others) {
            const item = make("li");
            const pick = button(fill(t.shareWith, { person: person.name }), "share-person");
            pick.dataset.account = person.account;
            pick.addEventListener("click", async () => {
              for (const b of nearby.querySelectorAll("button")) b.disabled = true;
              status.textContent = fill(t.sending, { person: person.name });
              try {
                await backend.shareWith(path, folder, person.account);
                changed = true;
                already.add(person.name);
                item.remove();
                status.textContent = fill(t.sent, { person: person.name });
              } catch (error) {
                status.textContent = messageFor(error);
              }
              for (const b of nearby.querySelectorAll("button")) b.disabled = false;
            });
            item.append(pick);
            nearby.append(item);
          }
        } catch (error) {
          status.textContent = messageFor(error);
        }
        look.disabled = false;
      };
      look.addEventListener("click", lookAround);
      parts.push(nearby, look);
      lookAround();
      if (share && share.mine) {
        const stop = button(t.stop, "", "shareStop");
        stop.addEventListener("click", async () => {
          stop.disabled = true;
          try {
            await backend.shareEnd(share.id);
            finish(true);
          } catch (error) {
            stop.disabled = false;
            status.textContent = messageFor(error);
          }
        });
        actions.append(stop);
      }
    }
    parts.push(make("p", "setting-hint", folder ? t.hintFolder : t.hintPage), status);
    actions.append(close);
    parts.push(actions);
    dialog.replaceChildren(...parts);
    close.focus();
  });
}

/**
 * The box for one invitation. `answer(accept)` resolves when it is saved. Resolves to "accepted",
 * "declined" or "later" (closed without an answer; it is asked again next time).
 */
export function openInvitationDialog(dialog, { share, answer }) {
  const t = strings.sharing;
  return runDialog(dialog, (finish) => {
    const what = share.folder ? t.aFolder : t.aPage;
    const title = make("h2", "", fill(t.invitedTitle, { person: share.ownerName, name: share.item.replace(/\.md$/i, ""), what }));
    const where = make("p", "setting-hint", fill(t.invitedWhere, { path: share.path.replace(/\.md$/i, "") }));
    const status = make("p", "setting-hint share-status");
    const no = button(t.decline, "", "inviteNo");
    const yes = button(t.accept, "primary", "inviteYes");
    const choose = (accept) => async () => {
      no.disabled = yes.disabled = true;
      try {
        await answer(accept);
        finish(accept ? "accepted" : "declined");
      } catch (error) {
        no.disabled = yes.disabled = false;
        status.textContent = messageFor(error);
      }
    };
    no.addEventListener("click", choose(false));
    yes.addEventListener("click", choose(true));
    const actions = make("div", "dialog-actions");
    actions.append(no, yes);
    dialog.replaceChildren(title, where, make("p", "setting-hint", t.invitedHint), status, actions);
    yes.focus();
  }).then((result) => (result === false ? "later" : result));
}
