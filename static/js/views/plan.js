// Plan view: everything staged so far. Nothing here has been written to Serato.
import { applyStatus, openApplyDialog, restoreLastBackup } from '../applyDialog.js';
import { store } from '../store.js';
import { clear, confirmDialog, download, fmt, h } from '../ui.js';
import { _, _n } from '../i18n.js';

const KIND = {
  add: _('Add to crate'),
  remove: _('Remove from crate'),
  createCrate: _('New crate'),
  renameCrate: _('Rename'),
  moveCrate: _('Move crate'),
  deleteCrate: _('Delete crate'),
  mergeCrate: _('Merge crate'),
  removeTrack: _('Remove song'),
  relocate: _('Relocate'),
};

export function createPlanView() {
  const open = new Set();
  const el = h('div', { class: 'view plan' });
  let lastBackup = null;
  const loadStatus = () =>
    applyStatus()
      .then((s) => {
        lastBackup = s.lastBackup;
        render();
      })
      .catch((e) => console.warn('apply status failed', e));

  function counts() {
    const c = {};
    for (const ch of store.plan.changes) for (const op of ch.ops) c[op.type] = (c[op.type] || 0) + 1;
    return c;
  }

  function render() {
    const changes = store.plan.changes;
    const nOps = changes.reduce((n, c) => n + c.ops.length, 0);
    const issuesByChange = new Map();
    for (const i of store.eff.issues) {
      if (!issuesByChange.has(i.changeId)) issuesByChange.set(i.changeId, []);
      issuesByChange.get(i.changeId).push(i);
    }
    const c = counts();

    clear(
      el,
      h(
        'div',
        { class: 'plan-inner' },
        h(
          'div',
          { class: 'notice notice-info' },
          h('strong', {}, _('These changes are not in Serato yet.')),
          _(' When they look right, quit Serato DJ and press "Apply to Serato". It rehearses on a copy first, backs up the Serato database automatically and checks everything after writing. If any step fails, nothing is written.'),
        ),
        h(
          'div',
          { class: 'plan-summary' },
          h('div', { class: 'stat' }, h('div', { class: 'stat-num' }, changes.length), h('div', { class: 'muted small' }, _('changes'))),
          h('div', { class: 'stat' }, h('div', { class: 'stat-num' }, nOps), h('div', { class: 'muted small' }, _('actions'))),
          h('div', { class: 'chips' }, Object.entries(c).map(([k, n]) => h('span', { class: 'chip' }, `${KIND[k] || k} ${n}`))),
          h(
            'div',
            { class: 'toolbar push-right' },
            h('button', { class: 'btn btn-primary', disabled: !changes.length, onclick: () => openApplyDialog().then(loadStatus) }, _('Apply to Serato…')),
            lastBackup ? h('button', { class: 'btn btn-ghost', title: lastBackup, onclick: () => restoreLastBackup(lastBackup).then(loadStatus) }, _('Restore the backup from before the last apply')) : null,
            h('button', { class: 'btn', disabled: !changes.length, onclick: exportJson }, _('Export JSON')),
            h('button', { class: 'btn', disabled: !changes.length, onclick: exportMarkdown }, _('Export checklist (Markdown)')),
            h('button', { class: 'btn btn-danger-ghost', disabled: !changes.length, onclick: clearAll }, _('Clear all')),
          ),
        ),
        store.eff.issues.length
          ? h('div', { class: 'notice notice-danger' }, _n(store.eff.issues.length, '{n} action no longer applies (usually because a crate or song no longer exists in Serato after reloading the snapshot). Changes marked red can be undone directly.', '{n} actions no longer apply (usually because a crate or song no longer exists in Serato after reloading the snapshot). Changes marked red can be undone directly.'))
          : null,
        changes.length
          ? h(
              'div',
              { class: 'changes' },
              [...changes].reverse().map((ch) => {
                const issues = issuesByChange.get(ch.id) || [];
                const isOpen = open.has(ch.id);
                return h(
                  'div',
                  { class: `change ${issues.length ? 'has-issue' : ''}` },
                  h(
                    'div',
                    {
                      class: 'change-head',
                      onclick: () => {
                        if (isOpen) open.delete(ch.id);
                        else open.add(ch.id);
                        render();
                      },
                    },
                    h('span', { class: 'caret' }, h('span', { class: `chev ${isOpen ? 'is-open' : ''}` })),
                    h('span', { class: 'muted num' }, fmt.time(ch.at)),
                    h('span', { class: 'grow' }, ch.label),
                    h('span', { class: 'muted small' }, _n(ch.ops.length, '{n} action', '{n} actions')),
                    h('button', {
                      class: 'btn btn-ghost btn-xs',
                      onclick: (e) => {
                        e.stopPropagation();
                        store.undo(ch.id);
                      },
                    }, _('Undo')),
                  ),
                  isOpen
                    ? h(
                        'ul',
                        { class: 'change-ops' },
                        ch.ops.map((op) => {
                          const issue = issues.find((i) => i.op === op);
                          return h('li', { class: issue ? 'op-issue' : '' }, op.text || op.type, issue ? h('span', { class: 'tag tag-danger' }, issue.message) : null);
                        }),
                      )
                    : null,
                );
              }),
            )
          : h('div', { class: 'empty' }, _('No changes yet. Start organising in Sort, Cleanup or Crates.')),
      ),
    );
  }

  function exportJson() {
    const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
    download(`crate-plan-${stamp}.json`, JSON.stringify({ ...store.plan, snapshotTakenAt: store.base.snapshot?.takenAt }, null, 2));
  }

  function exportMarkdown() {
    const lines = [_('# Serato crate plan'), '', _('Generated: {time}', { time: new Date().toLocaleString() }), _('Snapshot taken: {time}', { time: store.base.snapshot?.takenAt ?? '–' }), ''];
    for (const ch of store.plan.changes) {
      lines.push(`## ${fmt.time(ch.at)} ${ch.label}`, '');
      for (const op of ch.ops) lines.push(`- [ ] ${op.text || op.type}`);
      lines.push('');
    }
    download('crate-plan.md', lines.join('\n'), 'text/markdown');
  }

  async function clearAll() {
    const ok = await confirmDialog({ title: _('Clear the whole plan?'), message: _('All staged actions will be deleted (Serato itself is not affected).'), okText: _('Clear all'), danger: true });
    if (ok) store.clearPlan();
  }

  render();
  loadStatus();
  return { el, title: _('Plan'), update: render, onKey: () => false, destroy() {} };
}
