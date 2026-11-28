// Apply to Serato: write the staged plan into Serato's library (Serato must be closed).
// The server rehearses on a copy, backs up Serato's databases, writes in one transaction and
// verifies every crate against `expected` (computed here) before committing.
import { APPLY_SUPPORTED, applyPlan } from './model.js';
import { store } from './store.js';
import { clear, confirmDialog, fmt, h, modal, toast } from './ui.js';
import { _, _n } from './i18n.js';

const KIND = {
  add: _('Add to crate'),
  remove: _('Remove from crate'),
  createCrate: _('New crate'),
  renameCrate: _('Rename'),
  moveCrate: _('Move crate'),
  importTrack: _('Add to Serato'),
  reorderCrate: _('Reorder crate'),
  deleteCrate: _('Delete crate'),
  mergeCrate: _('Merge crate'),
  relocate: _('Relocate'),
  removeTrack: _('Remove song / reject'),
};

function split() {
  const supported = [];
  const later = [];
  for (const ch of store.plan.changes) {
    const ok = ch.ops.filter((o) => APPLY_SUPPORTED.has(o.type));
    if (ok.length) supported.push({ ...ch, ops: ok });
    later.push(...ch.ops.filter((o) => !APPLY_SUPPORTED.has(o.type)));
  }
  return { supported, later };
}

function expectedTree(changes) {
  const eff = applyPlan(store.base, changes);
  if (eff.issues.length) throw new Error(_('The plan has an action that no longer applies: {error}', { error: eff.issues[0].message }));
  // Key crates by their path joined with U+0000 (cannot appear in a name), same as apply.py.
  const key = (id) => {
    const c = eff.crates.get(id);
    return eff.crates.has(c.parent) ? `${key(c.parent)}\u0000${c.name}` : c.name;
  };
  const out = {};
  for (const id of eff.crates.keys()) out[key(id)] = [...new Set(eff.members.get(id) || [])].sort((a, b) => a - b);
  // Songs the plan adds have no Serato id yet: their plan id stands in (apply.py swaps in the new id).
  for (const imp of eff.imports.values()) if (imp.crate != null && eff.crates.has(imp.crate)) out[key(imp.crate)].push(imp.id);
  // Levels the plan put in a new order: the crate names there, in that order (apply.py checks both files).
  const order = {};
  for (const ch of changes) {
    for (const op of ch.ops) {
      if (op.type !== 'moveCrate' || !('before' in op) || (op.parent !== eff.rootId && !eff.crates.has(op.parent))) continue;
      order[op.parent === eff.rootId ? '' : key(op.parent)] = (eff.children.get(op.parent) || []).map((id) => eff.crates.get(id).name);
    }
  }
  return { expected: out, expectedOrder: order };
}

function trashNote(trashed) {
  if (!trashed?.length) return null;
  const failed = trashed.filter((r) => !r.ok);
  const ok = trashed.length - failed.length;
  return h(
    'div',
    { class: `fnote ${failed.length ? 'fnote-danger' : 'fnote-ok'}` },
    h(
      'span',
      {},
      ok ? _n(ok, '✓ {n} rejected file was moved to the Trash.', '✓ {n} rejected files were moved to the Trash.') : '',
      failed.length
        ? [h('br'), _n(failed.length, '{n} file was not moved (it is already removed from Serato and still in place):', '{n} files were not moved (they are already removed from Serato and still in place):'), h('ul', {}, failed.slice(0, 5).map((r) => h('li', {}, fmt.shortPath(r.path), _(': '), r.error)))]
        : null,
    ),
  );
}

const count = (changes) => {
  const c = {};
  for (const ch of changes) for (const op of ch.ops) {
      const k = op.type === 'moveCrate' && op.reorder ? 'reorderCrate' : op.type;
      c[k] = (c[k] || 0) + 1;
    }
  return c;
};

const api2 = {
  status: () => fetch('/api/apply/status', { cache: 'no-store' }).then((r) => r.json()),
  apply: (body) => fetch('/api/apply', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json()),
  restore: (backup) => fetch('/api/apply/restore', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ backup }) }).then((r) => r.json()),
};

export async function openApplyDialog() {
  const bodyEl = h('div', { class: 'apply' });
  let status = null;
  let phase = 'ready'; // ready | running | done | failed
  let result = null;
  let closeFn = null;

  const render = () => {
    const { supported, later } = split();
    const c = count(supported);
    const nOps = supported.reduce((n, ch) => n + ch.ops.length, 0);
    const nTrash = supported.reduce((n, ch) => n + ch.ops.filter((o) => o.type === 'removeTrack' && o.deleteFile).length, 0);
    if (phase === 'running') {
      clear(bodyEl, h('div', { class: 'apply-progress' }, h('div', { class: 'mark-spin' }, '◐'), h('p', {}, _('Applying: rehearse → back up → write → check…')), h('p', { class: 'muted small' }, _('Do not open Serato DJ'))));
      return;
    }
    if (phase === 'done') {
      clear(
        bodyEl,
        h('div', { class: 'fnote fnote-ok' }, h('strong', {}, _n(result.applied, '✓ Written to Serato: {n} action', '✓ Written to Serato: {n} actions'))),
        h('ul', { class: 'apply-checks' }, result.checks.map((x) => h('li', {}, '✓ ', x))),
        trashNote(result.trashed),
        Object.keys(result.imported || {}).length
          ? h(
              'div',
              { class: 'fnote fnote-warn' },
              h('span', {}, _n(Object.keys(result.imported).length, '{n} song was added to Serato, not analysed yet. In Serato DJ, select it (for example its crate) and choose "Analyze Files": Serato then reads its tags and works out BPM, key, beatgrid and waveform.', '{n} songs were added to Serato, not analysed yet. In Serato DJ, select them (for example their crate) and choose "Analyze Files": Serato then reads their tags and works out BPM, key, beatgrid and waveform.')),
            )
          : null,
        h('p', { class: 'muted small' }, _('Database backup from before applying: '), h('code', {}, fmt.shortPath(result.backup))),
        h('p', {}, _('Open Serato DJ and check that the crates look right. If something is wrong, quit Serato, then press "Restore the backup from before the last apply" in Plan.')),
        h('div', { class: 'modal-actions' }, h('button', { class: 'btn btn-primary', onclick: () => closeFn?.() }, _('Done'))),
      );
      return;
    }
    const blocked = !status || status.seratoRunning || status.inUse?.length;
    clear(
      bodyEl,
      phase === 'failed' ? h('div', { class: 'fnote fnote-danger' }, h('span', {}, h('strong', {}, _('Nothing was applied. Serato was not changed.')), h('br'), result?.error || '')) : null,
      nOps
        ? [
            h('p', {}, _n(nOps, 'Changes to write to Serato ({n} action):', 'Changes to write to Serato ({n} actions):')),
            h('div', { class: 'chips' }, Object.entries(c).map(([k, n]) => h('span', { class: 'chip' }, `${KIND[k] || k} ${n}`))),
          ]
        : h('p', {}, _('The plan has nothing that can be applied.')),
      later.length
        ? h('p', { class: 'muted small' }, _('Not supported yet, stays in the plan: {list}', { list: Object.entries(count([{ ops: later }])).map(([k, n]) => `${KIND[k] || k} ${n}`).join(_(', ')) }))
        : null,
      nTrash ? h('p', { class: 'muted small' }, _n(nTrash, '{n} of them (a reject, or a duplicate merged with "Merge and Trash") also has its file moved to the Trash after the write succeeds (restore it from the Trash or the Folders view). Other removed songs are only removed from Serato; their files stay.', '{n} of them (rejects, or duplicates merged with "Merge and Trash") also have their files moved to the Trash after the write succeeds (restore them from the Trash or the Folders view). Other removed songs are only removed from Serato; their files stay.')) : null,
      h(
        'div',
        { class: `fnote ${!status ? '' : blocked ? 'fnote-danger' : 'fnote-ok'}` },
        h(
          'span',
          {},
          !status
            ? _('Checking whether Serato DJ is running…')
            : status.seratoRunning
              ? _('Serato DJ is still open. Quit it first. ({list})', { list: (status.seratoProcesses || []).join(_(', ')) })
              : status.inUse?.length
                ? _('Another program is using the Serato database: {list}', { list: status.inUse.map(fmt.shortPath).join(_(', ')) })
                : _('✓ Serato DJ is closed'),
        ),
        h('button', { class: 'btn btn-sm', onclick: refresh }, _('Check again')),
      ),
      h(
        'ol',
        { class: 'apply-steps muted small' },
        h('li', {}, _('Rehearse on a copy of the Serato database first, and stop at any problem')),
        h('li', {}, [_('Back up the Serato database to '), h('code', {}, fmt.shortPath(status?.backupsDir || '~/Cratify Backups'))]),
        h('li', {}, _('Write, then check again: database integrity, master and root match, and every crate holds exactly the expected songs')),
        h('li', {}, _('The write only counts if everything passes; otherwise nothing is written')),
      ),
      h(
        'div',
        { class: 'modal-actions' },
        h('button', { class: 'btn', onclick: () => closeFn?.() }, _('Cancel')),
        h('button', { class: 'btn btn-primary', disabled: blocked || !nOps, onclick: run }, _n(nOps, 'Apply to Serato ({n} action)', 'Apply to Serato ({n} actions)')),
      ),
    );
  };

  async function refresh() {
    status = null;
    render();
    try {
      status = await api2.status();
    } catch (e) {
      status = { seratoRunning: true, inUse: [], error: e.message };
    }
    render();
  }

  async function run() {
    const { supported } = split();
    let expected;
    let expectedOrder;
    try {
      ({ expected, expectedOrder } = expectedTree(supported));
    } catch (e) {
      phase = 'failed';
      result = { error: e.message };
      return render();
    }
    phase = 'running';
    render();
    try {
      result = await api2.apply({ changes: supported, expected, expectedOrder });
    } catch (e) {
      result = { ok: false, error: e.message };
    }
    if (!result.ok) {
      phase = 'failed';
      await refresh();
      return;
    }
    phase = 'done';
    await store.afterApply(result.newIds || {});
    render();
  }

  render();
  refresh();
  return modal({
    title: _('Apply to Serato'),
    wide: true,
    body: (close) => {
      closeFn = close;
      return bodyEl;
    },
  });
}

export async function restoreLastBackup(backup) {
  const ok = await confirmDialog({
    title: _('Restore the backup from before the last apply?'),
    message: _('This replaces Serato\'s current database with {path}. Changes made in Serato after the apply (crates, analysis, play history) go back to how they were too. Quit Serato DJ first.', { path: fmt.shortPath(backup) }),
    okText: _('Restore'),
    danger: true,
  });
  if (!ok) return false;
  const res = await api2.restore(backup);
  if (!res.ok) {
    toast(_('Not restored: {error}', { error: res.error }), { tone: 'danger', timeout: 10000 });
    return false;
  }
  await store.refreshSnapshot();
  toast(_('Serato database restored. Open Serato DJ to check'));
  return true;
}

export const applyStatus = () => api2.status();
