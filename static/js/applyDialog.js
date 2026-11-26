// Apply to Serato: write the staged plan into Serato's library (Serato must be closed).
// The server rehearses on a copy, backs up Serato's databases, writes in one transaction and
// verifies every crate against `expected` (computed here) before committing.
import { APPLY_SUPPORTED, applyPlan } from './model.js';
import { store } from './store.js';
import { clear, confirmDialog, fmt, h, modal, toast } from './ui.js';

const KIND = {
  add: '加入 crate',
  remove: '移出 crate',
  createCrate: '新增 crate',
  renameCrate: '重新命名',
  moveCrate: '移動 crate',
  deleteCrate: '刪除 crate',
  mergeCrate: '合併 crate',
  relocate: '重新指定位置',
  removeTrack: '移除曲目 / 不要',
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
  if (eff.issues.length) throw new Error(`計畫裡有套用不上的動作：${eff.issues[0].message}`);
  // Key crates by their path joined with U+0000 (cannot appear in a name), same as apply.py.
  const key = (id) => {
    const c = eff.crates.get(id);
    return eff.crates.has(c.parent) ? `${key(c.parent)}\u0000${c.name}` : c.name;
  };
  const out = {};
  for (const id of eff.crates.keys()) out[key(id)] = [...new Set(eff.members.get(id) || [])].sort((a, b) => a - b);
  return out;
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
      ok ? `✓ ${ok} 個「不要」的檔案已丟到垃圾桶。` : '',
      failed.length
        ? [h('br'), `${failed.length} 個檔案沒有丟掉（Serato 裡已經移除了，檔案還在原處）：`, h('ul', {}, failed.slice(0, 5).map((r) => h('li', {}, fmt.shortPath(r.path), '：', r.error)))]
        : null,
    ),
  );
}

const count = (changes) => {
  const c = {};
  for (const ch of changes) for (const op of ch.ops) c[op.type] = (c[op.type] || 0) + 1;
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
      clear(bodyEl, h('div', { class: 'apply-progress' }, h('div', { class: 'mark-spin' }, '◐'), h('p', {}, '套用中：預演 → 備份 → 寫入 → 檢查…'), h('p', { class: 'muted small' }, '請不要打開 Serato DJ')));
      return;
    }
    if (phase === 'done') {
      clear(
        bodyEl,
        h('div', { class: 'fnote fnote-ok' }, h('strong', {}, `✓ 已經寫入 Serato：${result.applied} 個動作`)),
        h('ul', { class: 'apply-checks' }, result.checks.map((x) => h('li', {}, '✓ ', x))),
        trashNote(result.trashed),
        h('p', { class: 'muted small' }, '套用前的資料庫備份在：', h('code', {}, fmt.shortPath(result.backup))),
        h('p', {}, '請打開 Serato DJ 確認 crate 看起來正確。如果有問題，先關掉 Serato，再到「變更計畫」按「還原上次套用前的備份」。'),
        h('div', { class: 'modal-actions' }, h('button', { class: 'btn btn-primary', onclick: () => closeFn?.() }, '完成')),
      );
      return;
    }
    const blocked = !status || status.seratoRunning || status.inUse?.length;
    clear(
      bodyEl,
      phase === 'failed' ? h('div', { class: 'fnote fnote-danger' }, h('span', {}, h('strong', {}, '沒有套用，Serato 沒有被修改。'), h('br'), result?.error || '')) : null,
      nOps
        ? [
            h('p', {}, `會寫入 Serato 的變更（${nOps} 個動作）：`),
            h('div', { class: 'chips' }, Object.entries(c).map(([k, n]) => h('span', { class: 'chip' }, `${KIND[k] || k} ${n}`))),
          ]
        : h('p', {}, '變更計畫裡沒有可以套用的動作。'),
      later.length
        ? h('p', { class: 'muted small' }, `還不能套用、會留在計畫裡：${Object.entries(count([{ ops: later }])).map(([k, n]) => `${KIND[k] || k} ${n}`).join('、')}`)
        : null,
      nTrash ? h('p', { class: 'muted small' }, `其中 ${nTrash} 首標記「不要」的歌，會在寫入成功之後把檔案丟到垃圾桶（可以從垃圾桶或「資料夾」頁還原）。其他移除的歌只從 Serato 移除，檔案不動。`) : null,
      h(
        'div',
        { class: `fnote ${!status ? '' : blocked ? 'fnote-danger' : 'fnote-ok'}` },
        h(
          'span',
          {},
          !status
            ? '檢查 Serato DJ 狀態中…'
            : status.seratoRunning
              ? `Serato DJ 還開著，請先關掉它。（${(status.seratoProcesses || []).join('、')}）`
              : status.inUse?.length
                ? `有程式正在使用 Serato 的資料庫：${status.inUse.map(fmt.shortPath).join('、')}`
                : '✓ Serato DJ 已關閉',
        ),
        h('button', { class: 'btn btn-sm', onclick: refresh }, '重新檢查'),
      ),
      h(
        'ol',
        { class: 'apply-steps muted small' },
        h('li', {}, '先在 Serato 資料庫的複本上預演，有任何問題就停下來'),
        h('li', {}, ['把 Serato 的資料庫備份到 ', h('code', {}, fmt.shortPath(status?.backupsDir || '~/Backstage Backups/Serato 資料庫'))]),
        h('li', {}, '寫入，寫入後再檢查一次：資料庫完整性、master 和 root 一致、每個 crate 的歌和預期相同'),
        h('li', {}, '全部通過才算數，否則什麼都不會寫入'),
      ),
      h(
        'div',
        { class: 'modal-actions' },
        h('button', { class: 'btn', onclick: () => closeFn?.() }, '取消'),
        h('button', { class: 'btn btn-primary', disabled: blocked || !nOps, onclick: run }, `套用到 Serato（${nOps} 個動作）`),
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
    try {
      expected = expectedTree(supported);
    } catch (e) {
      phase = 'failed';
      result = { error: e.message };
      return render();
    }
    phase = 'running';
    render();
    try {
      result = await api2.apply({ changes: supported, expected });
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
    title: '套用到 Serato',
    wide: true,
    body: (close) => {
      closeFn = close;
      return bodyEl;
    },
  });
}

export async function restoreLastBackup(backup) {
  const ok = await confirmDialog({
    title: '還原上次套用前的備份？',
    message: `會用 ${fmt.shortPath(backup)} 取代 Serato 現在的資料庫。套用之後在 Serato 裡做的變更（crate、分析、播放紀錄）也會一起回到套用前。請先關掉 Serato DJ。`,
    okText: '還原',
    danger: true,
  });
  if (!ok) return false;
  const res = await api2.restore(backup);
  if (!res.ok) {
    toast(`沒有還原：${res.error}`, { tone: 'danger', timeout: 10000 });
    return false;
  }
  await store.refreshSnapshot();
  toast('已還原 Serato 資料庫，請打開 Serato DJ 確認');
  return true;
}

export const applyStatus = () => api2.status();
