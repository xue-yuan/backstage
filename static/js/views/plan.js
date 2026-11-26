// Plan view: everything staged so far. Nothing here has been written to Serato.
import { applyStatus, openApplyDialog, restoreLastBackup } from '../applyDialog.js';
import { store } from '../store.js';
import { clear, confirmDialog, download, fmt, h } from '../ui.js';

const KIND = {
  add: '加入 crate',
  remove: '移出 crate',
  createCrate: '新增 crate',
  renameCrate: '重新命名',
  moveCrate: '移動 crate',
  deleteCrate: '刪除 crate',
  mergeCrate: '合併 crate',
  removeTrack: '移除曲目',
  relocate: '重新指定位置',
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
          h('strong', {}, '這些變更還沒寫進 Serato。'),
          ' 確認沒問題後，關掉 Serato DJ 再按「套用到 Serato」。套用前會先在複本上預演、自動備份 Serato 的資料庫，寫入後逐一檢查；任何一步不對就不會寫入。',
        ),
        h(
          'div',
          { class: 'plan-summary' },
          h('div', { class: 'stat' }, h('div', { class: 'stat-num' }, changes.length), h('div', { class: 'muted small' }, '個變更')),
          h('div', { class: 'stat' }, h('div', { class: 'stat-num' }, nOps), h('div', { class: 'muted small' }, '個動作')),
          h('div', { class: 'chips' }, Object.entries(c).map(([k, n]) => h('span', { class: 'chip' }, `${KIND[k] || k} ${n}`))),
          h(
            'div',
            { class: 'toolbar push-right' },
            h('button', { class: 'btn btn-primary', disabled: !changes.length, onclick: () => openApplyDialog().then(loadStatus) }, '套用到 Serato…'),
            lastBackup ? h('button', { class: 'btn btn-ghost', title: lastBackup, onclick: () => restoreLastBackup(lastBackup).then(loadStatus) }, '還原上次套用前的備份') : null,
            h('button', { class: 'btn', disabled: !changes.length, onclick: exportJson }, '匯出 JSON'),
            h('button', { class: 'btn', disabled: !changes.length, onclick: exportMarkdown }, '匯出清單（Markdown）'),
            h('button', { class: 'btn btn-danger-ghost', disabled: !changes.length, onclick: clearAll }, '全部清除'),
          ),
        ),
        store.eff.issues.length
          ? h('div', { class: 'notice notice-danger' }, `有 ${store.eff.issues.length} 個動作套用不上（通常是重新讀取快照後，crate 或曲目在 Serato 裡已經不存在）。標成紅色的變更可以直接復原。`)
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
                    h('span', { class: 'muted small' }, `${ch.ops.length} 個動作`),
                    h('button', {
                      class: 'btn btn-ghost btn-xs',
                      onclick: (e) => {
                        e.stopPropagation();
                        store.undo(ch.id);
                      },
                    }, '復原'),
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
          : h('div', { class: 'empty' }, '還沒有任何變更。到「分類新歌」、「清理」或「Crate 結構」開始整理吧。'),
      ),
    );
  }

  function exportJson() {
    const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
    download(`crate-plan-${stamp}.json`, JSON.stringify({ ...store.plan, snapshotTakenAt: store.base.snapshot?.takenAt }, null, 2));
  }

  function exportMarkdown() {
    const lines = ['# Serato crate 整理計畫', '', `產生時間：${new Date().toLocaleString()}`, `快照時間：${store.base.snapshot?.takenAt ?? '–'}`, ''];
    for (const ch of store.plan.changes) {
      lines.push(`## ${fmt.time(ch.at)} ${ch.label}`, '');
      for (const op of ch.ops) lines.push(`- [ ] ${op.text || op.type}`);
      lines.push('');
    }
    download('crate-plan.md', lines.join('\n'), 'text/markdown');
  }

  async function clearAll() {
    const ok = await confirmDialog({ title: '清除整份變更計畫？', message: '所有排好的整理動作都會被刪除（Serato 本身不受影響）。', okText: '全部清除', danger: true });
    if (ok) store.clearPlan();
  }

  render();
  loadStatus();
  return { el, title: '變更計畫', update: render, onKey: () => false, destroy() {} };
}
