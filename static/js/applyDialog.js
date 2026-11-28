// Apply to Serato: write the staged plan into Serato's library (Serato must be closed).
// The server rehearses on a copy, backs up Serato's databases, writes in one transaction and
// verifies every crate against `expected` (computed here) before committing.
import { APPLY_SUPPORTED, applyPlan } from './model.js';
import { store } from './store.js';
import { clear, confirmDialog, fmt, h, modal, toast } from './ui.js';
import { _, _n } from './i18n.js';

const KIND = {
  add: _('common.addToCrate'),
  remove: _('common.removeFromCrate'),
  createCrate: _('common.newCrate'),
  renameCrate: _('common.rename'),
  moveCrate: _('common.moveCrate'),
  importTrack: _('common.addToSerato'),
  reorderCrate: _('common.reorderCrate'),
  deleteCrate: _('common.deleteCrate'),
  mergeCrate: _('common.mergeCrate'),
  relocate: _('common.relocate'),
  removeTrack: _('apply.removeSongReject'),
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
  if (eff.issues.length) throw new Error(_('apply.issue', { error: eff.issues[0].message }));
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
      ok ? _n(ok, 'apply.trashedFiles') : '',
      failed.length
        ? [h('br'), _n(failed.length, 'apply.trashFailed'), h('ul', {}, failed.slice(0, 5).map((r) => h('li', {}, fmt.shortPath(r.path), _('sep.colon'), r.error)))]
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
      clear(bodyEl, h('div', { class: 'apply-progress' }, h('div', { class: 'mark-spin' }, '◐'), h('p', {}, _('apply.progress')), h('p', { class: 'muted small' }, _('apply.keepSeratoClosed'))));
      return;
    }
    if (phase === 'done') {
      clear(
        bodyEl,
        h('div', { class: 'fnote fnote-ok' }, h('strong', {}, _n(result.applied, 'apply.written'))),
        h('ul', { class: 'apply-checks' }, result.checks.map((x) => h('li', {}, '✓ ', x))),
        trashNote(result.trashed),
        Object.keys(result.imported || {}).length
          ? h(
              'div',
              { class: 'fnote fnote-warn' },
              h('span', {}, _n(Object.keys(result.imported).length, 'apply.importedNote')),
            )
          : null,
        h('p', { class: 'muted small' }, _('apply.backupLocation'), h('code', {}, fmt.shortPath(result.backup))),
        h('p', {}, _('apply.checkInSerato')),
        h('div', { class: 'modal-actions' }, h('button', { class: 'btn btn-primary', onclick: () => closeFn?.() }, _('common.done'))),
      );
      return;
    }
    const blocked = !status || status.seratoRunning || status.inUse?.length;
    clear(
      bodyEl,
      phase === 'failed' ? h('div', { class: 'fnote fnote-danger' }, h('span', {}, h('strong', {}, _('apply.nothingApplied')), h('br'), result?.error || '')) : null,
      nOps
        ? [
            h('p', {}, _n(nOps, 'apply.changesHeading')),
            h('div', { class: 'chips' }, Object.entries(c).map(([k, n]) => h('span', { class: 'chip' }, `${KIND[k] || k} ${n}`))),
          ]
        : h('p', {}, _('apply.nothingToApply')),
      later.length
        ? h('p', { class: 'muted small' }, _('apply.unsupported', { list: Object.entries(count([{ ops: later }])).map(([k, n]) => `${KIND[k] || k} ${n}`).join(_('sep.comma')) }))
        : null,
      nTrash ? h('p', { class: 'muted small' }, _n(nTrash, 'apply.trashNote')) : null,
      h(
        'div',
        { class: `fnote ${!status ? '' : blocked ? 'fnote-danger' : 'fnote-ok'}` },
        h(
          'span',
          {},
          !status
            ? _('apply.checkingSerato')
            : status.seratoRunning
              ? _('apply.seratoOpen', { list: (status.seratoProcesses || []).join(_('sep.comma')) })
              : status.inUse?.length
                ? _('apply.databaseInUse', { list: status.inUse.map(fmt.shortPath).join(_('sep.comma')) })
                : _('apply.seratoClosed'),
        ),
        h('button', { class: 'btn btn-sm', onclick: refresh }, _('apply.checkAgain')),
      ),
      h(
        'ol',
        { class: 'apply-steps muted small' },
        h('li', {}, _('apply.stepTest')),
        h('li', {}, [_('apply.stepBackup'), h('code', {}, fmt.shortPath(status?.backupsDir || '~/Cratify Backups'))]),
        h('li', {}, _('apply.stepVerify')),
        h('li', {}, _('apply.allOrNothing')),
      ),
      h(
        'div',
        { class: 'modal-actions' },
        h('button', { class: 'btn', onclick: () => closeFn?.() }, _('common.cancel')),
        h('button', { class: 'btn btn-primary', disabled: blocked || !nOps, onclick: run }, _n(nOps, 'apply.applyButton')),
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
    if (!(await store.planIsCurrent())) {
      phase = 'failed';
      result = { error: _('apply.planChangedElsewhere') };
      return render();
    }
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
      // Each op carries its description for the server's error messages (the plan itself stores none).
      const changes = supported.map((ch) => ({ ...ch, ops: ch.ops.map((op) => ({ ...op, text: store.opText(op) })) }));
      result = await api2.apply({ changes, expected, expectedOrder });
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
    title: _('common.applyToSerato'),
    wide: true,
    body: (close) => {
      closeFn = close;
      return bodyEl;
    },
  });
}

export async function restoreLastBackup(backup) {
  const ok = await confirmDialog({
    title: _('apply.restoreConfirm'),
    message: _('apply.restoreWarning', { path: fmt.shortPath(backup) }),
    okText: _('common.restore'),
    danger: true,
  });
  if (!ok) return false;
  const res = await api2.restore(backup);
  if (!res.ok) {
    toast(_('apply.restoreFailed', { error: res.error }), { tone: 'danger', timeout: 10000 });
    return false;
  }
  await store.refreshSnapshot();
  toast(_('apply.restored'));
  return true;
}

export const applyStatus = () => api2.status();
