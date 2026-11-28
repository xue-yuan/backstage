// Adding files on disk to Serato from Cratify (plan op importTrack). Applying the plan writes what
// Serato's own import writes (file details and title); Serato reads the other tags and analyses the
// songs afterwards ("Analyze Files"). Used by the Folders view.
import { createCratePicker } from './cratePicker.js';
import { norm, pathKey } from './model.js';
import { store } from './store.js';
import { h, modal, toast } from './ui.js';
import { _, _n } from './i18n.js';

/** A folder-scan file that can be added: on disk, not in Serato, not marked reject. */
export const importable = (f) => f.status === 'notImported';

/** The top-level "Inbox" crate (new music goes under it), if there is one. */
function inboxId() {
  const eff = store.eff;
  return (eff.children.get(eff.rootId) || []).find((id) => norm(eff.crates.get(id).name) === 'inbox') ?? null;
}

/**
 * Ask where the files go and put them in the plan. files: folder-scan files ({ path, inSerato? }).
 * folderName: offered as a new crate under Inbox, like dragging the folder into Serato.
 */
export async function addToSerato(files, { folderName } = {}) {
  const todo = files.filter((f) => !store.planned(f.path));
  if (!todo.length) {
    toast(_('import.alreadyPlanned'));
    return;
  }
  const lookalikes = todo.filter((f) => f.inSerato);
  let skipLookalikes = lookalikes.length > 0;
  const inbox = inboxId();
  const eff = store.eff;
  const existing = inbox != null && folderName ? (eff.children.get(inbox) || []).find((id) => norm(eff.crates.get(id).name) === norm(folderName)) : null;

  const choice = await modal({
    title: _n(todo.length, 'import.title'),
    wide: true,
    className: 'modal-import',
    body: (close) => [
      h('p', {}, _('import.explanation')),
      lookalikes.length
        ? h(
            'label',
            { class: 'check import-skip' },
            h('input', { type: 'checkbox', checked: true, onchange: (e) => (skipLookalikes = e.target.checked) }),
            _n(lookalikes.length, 'import.skipLookalikes'),
          )
        : null,
      h('div', { class: 'section-label' }, _('import.destination')),
      folderName && inbox != null
        ? h(
            'button',
            { class: 'btn btn-primary btn-block import-folder', onclick: () => close({ crate: existing ?? 'new-under-inbox' }) },
            existing != null ? _('import.intoInbox', { name: folderName }) : _('import.newInboxCrate', { name: folderName }),
          )
        : null,
      createCratePicker({ inline: true, autofocus: !folderName, allowCreate: true, placeholder: _('import.otherCrate'), onPick: (id) => close({ crate: id }) }).el,
      h('button', { class: 'btn btn-block', onclick: () => close({ crate: null }) }, _('import.libraryOnly')),
    ],
    actions: (close) => [h('button', { class: 'btn', onclick: () => close(undefined) }, _('common.cancel'))],
  });
  if (choice === undefined || choice === null) return; // cancelled (Esc gives null; "no crate" gives { crate: null })

  const add = skipLookalikes ? todo.filter((f) => !f.inSerato) : todo;
  if (!add.length) {
    toast(_('import.allSkipped'));
    return;
  }
  const ops = [];
  let crate = choice.crate;
  let where = crate != null ? store.crateLabel(crate) : null;
  if (crate === 'new-under-inbox') {
    const create = store.opCreate(folderName, inbox);
    ops.push(create);
    crate = create.id;
    where = `${store.crateLabel(inbox)} / ${folderName}`;
  }
  ops.push(...add.map((f) => store.opImport(f.path, crate, where)));
  const label = where
    ? _n(add.length, 'import.buttonInto', { crate: where })
    : _n(add.length, 'import.title');
  store.commit(label, ops);
}

/** Take files out of the plan's "add to Serato". */
export function dontAdd(paths) {
  const keys = new Set(paths.map(pathKey));
  const n = store.revertOps((op) => op.type === 'importTrack' && keys.has(pathKey(op.path)));
  if (n) toast(_n(n, 'import.cancelled'));
}
