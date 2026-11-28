// Unsorted crates: which crates hold songs that still need sorting, and tidying them all under "Inbox".
// A song counts as sorted once it sits in any crate that is not unsorted (see classificationRules in model.js).
import { pickCrateDialog } from './cratePicker.js';
import { effectivePath, liveTracks, norm, pathKey } from './model.js';
import { store } from './store.js';
import { clear, confirmDialog, h, modal, promptDialog, toast } from './ui.js';
import { _, _n } from './i18n.js';

export const INBOX = 'Inbox';
// The crate under Inbox for songs in no crate. Its name follows the interface language; an existing one
// in either language is reused.
export const LOOSE = _('unsorted.looseCrateName');
const LOOSE_NAMES = ['Unsorted songs', '未分類單曲'];

export function inboxCrateId(eff = store.eff) {
  return (eff.children.get(eff.rootId) || []).find((id) => norm(eff.crates.get(id).name) === norm(INBOX)) ?? null;
}

function isUnder(eff, id, ancestor) {
  for (let cur = id; cur != null && eff.crates.has(cur); cur = eff.crates.get(cur).parent) if (cur === ancestor) return true;
  return false;
}

/** Top-most unsorted crates (their sub-crates are unsorted too), Inbox first. */
export function unsortedRoots(eff = store.eff, rules = store.rules) {
  const inbox = inboxCrateId(eff);
  return [...rules.skip]
    .filter((id) => eff.crates.has(id) && !rules.skip.has(eff.crates.get(id).parent))
    .sort((a, b) => (a === inbox ? -1 : b === inbox ? 1 : eff.pathOf(a).localeCompare(eff.pathOf(b))));
}

/** Why a crate counts as unsorted: 'inbox' | 'folder' | 'manual' | 'inherited' | null. */
export function unsortedReason(id, eff = store.eff, rules = store.rules) {
  if (!rules.skip.has(id)) return null;
  if (rules.overrides[String(id)] === 'skip') return 'manual';
  const auto = rules.auto.get(id);
  if (auto) return auto.kind;
  return 'inherited';
}

const subtreeSongs = (eff, id) => {
  const seen = new Set();
  const walk = (c) => {
    (eff.members.get(c) || []).forEach((a) => seen.add(a));
    (eff.children.get(c) || []).forEach(walk);
  };
  walk(id);
  return seen.size;
};

/**
 * Ops that put every unsorted crate under Inbox (TBD / Temp style containers are emptied into it
 * and removed) and collect songs that are in no crate into the loose-songs crate under Inbox (LOOSE).
 */
export function consolidateOps() {
  const eff = store.eff;
  const rules = store.rules;
  const ops = [];
  let inbox = inboxCrateId(eff);
  if (inbox == null) {
    const op = store.opCreate(INBOX, eff.rootId);
    ops.push(op);
    inbox = op.id;
  }
  const taken = new Map((eff.children.get(inbox) || []).map((id) => [norm(eff.crates.get(id).name), id]));
  const moveIn = (id) => {
    const key = norm(eff.crates.get(id).name);
    if (taken.has(key)) ops.push(store.opMerge(id, taken.get(key)));
    else {
      ops.push(store.opMove(id, inbox));
      taken.set(key, id);
    }
  };
  const roots = unsortedRoots(eff, rules).filter((id) => id !== inbox && !isUnder(eff, id, inbox));
  const emptied = [];
  let moved = 0;
  for (const id of roots) {
    const kids = eff.children.get(id) || [];
    if (rules.auto.get(id)?.kind === 'inbox' && !(eff.members.get(id) || []).length && kids.length) {
      kids.forEach(moveIn); // TBD / Temp: lift their crates into Inbox, then drop the empty container
      moved += kids.length;
      emptied.push(id);
    } else {
      moveIn(id);
      moved++;
    }
  }
  for (const id of emptied) ops.push(store.opDelete(id));

  // Only songs in the music folders (the Folders view): not rekordbox samples, demo tracks or Desktop files.
  const libRoots = (store.folderScan?.roots || []).map((r) => `${pathKey(r)}/`);
  const inLibrary = (t) => {
    const p = pathKey(effectivePath(eff, t));
    return libRoots.some((r) => p.startsWith(r));
  };
  const loose = liveTracks(eff).filter((t) => !(eff.cratesOf.get(t.id) || []).length && (t.exists || eff.relocated.has(t.id)) && inLibrary(t));
  if (loose.length) {
    let target = LOOSE_NAMES.map((n) => taken.get(norm(n))).find((id) => id != null);
    if (target == null) {
      const op = store.opCreate(LOOSE, inbox);
      ops.push(op);
      target = op.id;
    }
    for (const t of loose) ops.push(store.opAdd(target, t.id));
  }
  return { ops, moved, removed: emptied.map((id) => eff.pathOf(id)), loose: loose.length };
}

export async function consolidate() {
  if (!store.folderScan) await store.loadFolders().catch(() => {}); // songs in no crate are counted only inside the music folders
  const { ops, moved, removed, loose } = consolidateOps();
  if (!moved && !loose) {
    toast(_('unsorted.allUnderInbox'));
    return false;
  }
  const ok = await confirmDialog({
    title: _('unsorted.consolidateConfirm'),
    message: [
      moved ? _n(moved, 'unsorted.cratesWillMove', { inbox: INBOX }) : null,
      removed.length ? _('unsorted.deleteOnceEmpty', { names: removed.map((name) => _('sep.quoted', { name })).join(_('sep.comma')) }) : null,
      loose ? _n(loose, 'unsorted.looseSongsWillMove', { crate: `${INBOX} / ${LOOSE}` }) : null,
    ]
      .filter(Boolean)
      .join(_('sep.semicolon')) + _('unsorted.planNote'),
    okText: _('common.addToPlan'),
  });
  if (!ok) return false;
  return !!store.commit({ key: 'unsorted.consolidateChange', params: { inbox: INBOX } }, ops);
}

async function createUnder() {
  const eff = store.eff;
  const inbox = inboxCrateId(eff);
  const siblings = inbox == null ? [] : (eff.children.get(inbox) || []).map((id) => norm(eff.crates.get(id).name));
  const name = await promptDialog({
    title: _('unsorted.newCrateTitle', { inbox: INBOX }),
    placeholder: _('unsorted.newCratePlaceholder'),
    okText: _('unsorted.create'),
    validate: (v) => (siblings.includes(norm(v)) ? _('unsorted.nameTaken', { inbox: INBOX }) : null),
  });
  if (!name) return;
  const ops = [];
  let parent = inbox;
  if (parent == null) {
    const op = store.opCreate(INBOX, eff.rootId);
    ops.push(op);
    parent = op.id;
  }
  ops.push(store.opCreate(name, parent));
  store.commit({ key: 'unsorted.newCrateChange', params: { crate: `${INBOX} / ${name}` } }, ops);
}

const REASON = { inbox: _('unsorted.reasonInbox'), folder: _('unsorted.reasonFolder'), manual: _('unsorted.reasonManual') };

/** The editor: list / add / remove unsorted crates, create new ones under Inbox, tidy into Inbox. */
export function openUnsortedEditor() {
  const bodyEl = h('div', { class: 'rules' });
  const render = () => {
    const eff = store.eff;
    const rules = store.rules;
    const inbox = inboxCrateId(eff);
    const roots = unsortedRoots(eff, rules);
    const { moved, loose } = consolidateOps();
    const row = (id) => {
      const reason = unsortedReason(id, eff, rules);
      const auto = rules.auto.get(id);
      const kids = (eff.children.get(id) || []).length;
      return h(
        'div',
        { class: 'list-row' },
        h(
          'span',
          { class: 'grow' },
          eff.pathOf(id),
          h('span', { class: 'tag tag-unsorted' }, REASON[reason] || _('common.unsortedCrate')),
          h(
            'div',
            { class: 'muted small' },
            _n(subtreeSongs(eff, id), 'common.songs'),
            kids ? `${_('sep.dot')}${_n(kids, 'common.childCrates')}` : '',
            auto?.kind === 'folder' ? `${_('sep.dot')}${_('unsorted.folderMatch', { n: auto.n, total: auto.total, dir: auto.dir.replace(/^\/Users\/[^/]+/, '~') })}` : '',
          ),
        ),
        h(
          'button',
          {
            class: 'btn btn-sm btn-ghost',
            title: _('unsorted.unmarkHint'),
            onclick: () => {
              store.setClassifyOverride(id, auto ? 'count' : null);
              render();
            },
          },
          _('common.remove'),
        ),
      );
    };
    clear(
      bodyEl,
      h('p', { class: 'muted' }, _('unsorted.explanation', { inbox: INBOX })),
      moved || loose
        ? h(
            'div',
            { class: 'fnote fnote-warn' },
            h('span', {}, [moved ? _n(moved, 'unsorted.cratesOutsideInbox', { inbox: INBOX }) : null, loose ? _n(loose, 'unsorted.looseSongs') : null].filter(Boolean).join(_('sep.comma')) + _('sep.period')),
            h(
              'button',
              {
                class: 'btn btn-sm btn-primary',
                onclick: async () => {
                  if (await consolidate()) render();
                },
              },
              _('unsorted.consolidateMenu', { inbox: INBOX }),
            ),
          )
        : null,
      h('div', { class: 'section-label' }, _('unsorted.listTitle', { n: roots.length })),
      h('div', { class: 'list rules-scroll' }, roots.length ? roots.map(row) : h('div', { class: 'empty' }, _('unsorted.empty'))),
      h(
        'div',
        { class: 'toolbar rules-actions' },
        h(
          'button',
          {
            class: 'btn btn-sm',
            onclick: async () => {
              await createUnder();
              render();
            },
          },
          _('unsorted.addNewCrate', { inbox: INBOX }),
        ),
        h(
          'button',
          {
            class: 'btn btn-sm',
            onclick: async () => {
              const id = await pickCrateDialog({ title: _('unsorted.markPickerTitle'), allowCreate: false, exclude: store.rules.skip });
              if (id != null) store.setClassifyOverride(id, rules.auto.has(id) ? null : 'skip');
              render();
            },
          },
          _('unsorted.markExisting'),
        ),
        Object.keys(rules.overrides).length
          ? h(
              'button',
              {
                class: 'btn btn-sm btn-ghost',
                onclick: () => {
                  store.saveClassifyOverrides({});
                  render();
                },
              },
              _('unsorted.restoreDefaults'),
            )
          : null,
      ),
      inbox == null ? h('p', { class: 'muted small' }, _('unsorted.noInbox', { inbox: INBOX })) : null,
    );
  };
  render();
  // The count of songs in no crate needs the music folders' scan (opened from Crates it may not be loaded yet).
  if (!store.folderScan) store.loadFolders().then(() => bodyEl.isConnected && render(), () => {});
  return modal({
    title: _('unsorted.title'),
    wide: true,
    body: bodyEl,
    actions: (close) => [h('button', { class: 'btn btn-primary', onclick: () => close() }, _('common.done'))],
  });
}
