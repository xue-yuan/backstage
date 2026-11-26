import { mountPlayerBar, player } from './player.js';
import { store } from './store.js';
import { clear, fmt, h, isTyping, modal, prefs, toast } from './ui.js';
import { createCleanupView } from './views/cleanup.js';
import { createFoldersView } from './views/folders.js';
import { createInboxView } from './views/inbox.js';
import { createPlanView } from './views/plan.js';
import { createStructureView } from './views/structure.js';

const VIEWS = {
  folders: { label: '資料夾', create: createFoldersView },
  inbox: { label: '分類新歌', create: createInboxView },
  cleanup: { label: '清理', create: createCleanupView },
  structure: { label: 'Crate 結構', create: createStructureView },
  plan: { label: '變更計畫', create: createPlanView },
};

const app = document.getElementById('app');
const tabsEl = h('nav', { class: 'tabs' });
const snapEl = h('div', { class: 'snapshot' });
const mainEl = h('main', { class: 'main' });
const playerEl = h('footer', { class: 'player' });
let current = null;
let currentName = null;

function navigate(name) {
  if (!VIEWS[name]) name = 'inbox';
  current?.destroy?.();
  currentName = name;
  prefs.set('view', name);
  if (location.hash !== `#${name}`) history.replaceState(null, '', `#${name}`);
  current = VIEWS[name].create({ navigate });
  clear(mainEl, current.el);
  renderHeader();
}

function renderHeader() {
  const n = store.plan.changes.length;
  clear(
    tabsEl,
    Object.entries(VIEWS).map(([key, v]) =>
      h(
        'button',
        { class: `tab ${key === currentName ? 'is-active' : ''}`, onclick: () => navigate(key) },
        v.label,
        key === 'plan' && n ? h('span', { class: 'count count-accent' }, n) : null,
      ),
    ),
  );
  const snap = store.base?.snapshot;
  clear(
    snapEl,
    h('span', { class: 'readonly-pill', title: '平常只讀取 Serato 資料庫的複本；只有在「變更計畫」按「套用到 Serato」（Serato 關閉時）才會寫入，寫入前自動備份' }, '● 只有按「套用」才會寫入 Serato'),
    snap ? h('span', { class: 'muted small', title: `來源：${snap.source}` }, `快照 ${fmt.time(new Date(snap.takenAt).getTime())}`) : null,
    h('button', { class: 'btn btn-ghost btn-sm', onclick: refreshSnapshot, title: '重新複製 Serato 資料庫（Serato 開著也沒關係）' }, '↻ 重新讀取'),
    h('button', { class: 'btn btn-ghost btn-sm', onclick: showHelp, title: '快捷鍵（?）' }, '?'),
  );
}

async function refreshSnapshot() {
  try {
    toast('正在讀取 Serato 資料庫的新快照…');
    await store.refreshSnapshot();
    toast(store.eff.issues.length ? `已更新快照；有 ${store.eff.issues.length} 個計畫動作套用不上，請看「變更計畫」` : '已更新快照', {
      tone: store.eff.issues.length ? 'danger' : 'info',
    });
  } catch (e) {
    toast(`讀取失敗：${e.message}`, { tone: 'danger', timeout: 8000 });
  }
}

function showHelp() {
  const rows = [
    ['分類新歌', [['↑ ↓ / J K', '上一首 / 下一首'], ['空白鍵', '播放 / 暫停'], ['← →', '倒退 / 快轉 10 秒（⇧ 30 秒）'], ['Q W E R', '從 0% / 25% / 50% / 75% 開始播'], ['1–9', '加入 / 移出快捷 crate'], ['⇧ 1–5', '加入建議的 crate'], ['/', '搜尋其他 crate（可直接建立新的）'], ['X', '不要這首']]],
    ['資料夾', [['↑ ↓', '選擇資料夾（點歌曲後改為換歌）'], ['← →', '收合 / 展開'], ['空白鍵', '播放 / 暫停'], ['Q W E R', '從 0% / 25% / 50% / 75% 開始播'], ['X', '不要'], ['V', '留下'], ['Esc', '回到資料夾樹']]],
    ['Crate 結構', [['↑ ↓', '選擇 crate'], ['← →', '收合 / 展開'], ['Enter / F2', '重新命名'], ['N', '新增子 crate'], ['Delete', '刪除 crate（排入計畫）'], ['⌘A', '全選歌曲（點過歌曲列表後）']]],
    ['全域', [['⌘Z', '復原上一個變更'], ['?', '顯示這個說明']]],
  ];
  modal({
    title: '快捷鍵',
    wide: true,
    body: h(
      'div',
      { class: 'help' },
      rows.map(([title, keys]) => h('div', {}, h('div', { class: 'section-label' }, title), h('dl', { class: 'keys' }, keys.map(([k, d]) => [h('dt', {}, h('kbd', {}, k)), h('dd', {}, d)])))),
    ),
  });
}

document.addEventListener('keydown', (e) => {
  if (document.querySelector('.modal-backdrop') || isTyping(e)) return;
  if ((e.metaKey || e.ctrlKey) && e.key === 'z' && !e.shiftKey) {
    const undone = store.undo();
    toast(undone ? `已復原：${undone.label}` : '沒有可以復原的變更');
    e.preventDefault();
    return;
  }
  if (e.key === '?') {
    showHelp();
    e.preventDefault();
    return;
  }
  if (current?.onKey?.(e)) e.preventDefault();
});

window.addEventListener('hashchange', () => {
  const name = location.hash.slice(1);
  if (name !== currentName && VIEWS[name]) navigate(name);
});

async function boot() {
  app.append(
    h('header', { class: 'header' }, h('div', { class: 'brand' }, h('span', { class: 'brand-mark' }, '◐'), 'Backstage'), tabsEl, snapEl),
    mainEl,
    playerEl,
  );
  mountPlayerBar(playerEl);
  clear(mainEl, h('div', { class: 'loading' }, '正在讀取 Serato 資料庫快照…'));
  try {
    await store.load();
  } catch (e) {
    clear(mainEl, h('div', { class: 'loading' }, h('p', {}, '讀取失敗'), h('p', { class: 'muted' }, e.message), h('button', { class: 'btn', onclick: () => location.reload() }, '重試')));
    return;
  }
  store.subscribe(() => {
    renderHeader();
    current?.update?.();
  });
  store.loadAudioInfo(); // background: reads each file's real codec / bit rate
  navigate(location.hash.slice(1) || prefs.get('view', 'inbox'));
}

window.__crateDesk = { store, player, toast }; // toast is also used by the Mac app (download finished)
boot();
