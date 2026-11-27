import { mountPlayerBar, player } from './player.js';
import { store } from './store.js';
import { clear, fmt, h, isTyping, modal, prefs, toast } from './ui.js';
import { createCleanupView } from './views/cleanup.js';
import { createFoldersView } from './views/folders.js';
import { createInboxView } from './views/inbox.js';
import { createOverviewView } from './views/overview.js';
import { createPlanView } from './views/plan.js';
import { createStructureView } from './views/structure.js';
import { createGuideView } from './views/guide.js';
import { shortcutTable } from './shortcuts.js';
import { startWatch } from './watch.js';
import { _, _n, lang, setLang, switchTo, syncServerLang } from './i18n.js';

// Tab order = ⌘1–7 (the Mac app's View menu lists the same ids in src-tauri/src/main.rs).
const VIEWS = {
  home: { label: _('Overview'), create: createOverviewView },
  folders: { label: _('Folders'), create: createFoldersView },
  inbox: { label: _('Sort'), create: createInboxView },
  cleanup: { label: _('Cleanup'), create: createCleanupView },
  structure: { label: _('Crates'), create: createStructureView },
  plan: { label: _('Plan'), create: createPlanView },
  guide: { label: _('Guide'), create: createGuideView },
};

const app = document.getElementById('app');
const tabsEl = h('nav', { class: 'tabs' });
const snapEl = h('div', { class: 'snapshot' });
const mainEl = h('main', { class: 'main' });
const playerEl = h('footer', { class: 'player' });
let current = null;
let currentName = null;

function navigate(name) {
  if (!VIEWS[name]) name = 'home';
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
    Object.entries(VIEWS).map(([key, v], i) =>
      h(
        'button',
        { class: `tab ${key === currentName ? 'is-active' : ''}`, title: `⌘${i + 1}`, onclick: () => navigate(key) },
        v.label,
        key === 'plan' && n ? h('span', { class: 'count count-accent' }, n) : null,
      ),
    ),
  );
  const snap = store.base?.snapshot;
  clear(
    snapEl,
    // On narrow windows only the dot stays (app.css); the full text is in the tooltip.
    h(
      'span',
      { class: 'readonly-pill', title: _('Normally only a copy of the Serato database is read. Serato is written only when you press "Apply to Serato" in Plan (with Serato closed), after an automatic backup') },
      '●',
      h('span', { class: 'readonly-text' }, ` ${_('● Serato is written only when you press Apply').replace(/^●\s*/, '')}`),
    ),
    snap ? h('span', { class: 'muted small snap-time', title: _('Source: {path}', { path: snap.source }) }, _('Snapshot {time}', { time: fmt.time(new Date(snap.takenAt).getTime()) })) : null,
    h('button', { class: 'btn btn-ghost btn-sm', onclick: refreshSnapshot, title: `${_('Copy the Serato database again (fine while Serato is open)')} ⌘R` }, _('↻ Reload')),
    h('button', { class: 'btn btn-ghost btn-sm', onclick: showHelp, title: _('Keyboard shortcuts (?)') }, '?'),
    h('button', { class: 'btn btn-ghost btn-sm', onclick: () => setLang(switchTo.lang), title: switchTo.title }, switchTo.label),
  );
}

async function refreshSnapshot() {
  try {
    toast(_('Reading a new snapshot of the Serato database…'));
    await store.refreshSnapshot();
    toast(store.eff.issues.length ? _n(store.eff.issues.length, 'Snapshot updated. {n} plan action no longer applies, see Plan', 'Snapshot updated. {n} plan actions no longer apply, see Plan') : _('Snapshot updated'), {
      tone: store.eff.issues.length ? 'danger' : 'info',
    });
  } catch (e) {
    toast(_('Could not read: {error}', { error: e.message }), { tone: 'danger', timeout: 8000 });
  }
}

function showHelp() {
  modal({
    title: _('Keyboard shortcuts'),
    wide: true,
    body: (close) => [
      shortcutTable(),
      h('p', { class: 'muted small' }, h('a', { href: '#guide', onclick: () => close(null) }, _('Open the Guide for how everything works →'))),
    ],
  });
}

// App commands, from the keyboard (⌘R, ⌘1–7) and from the Mac app's menu bar. In the Mac app a key
// can reach both the page and the menu, so the same command twice in a row within a moment runs once.
const VIEW_KEYS = Object.keys(VIEWS);
let lastCommand = { name: null, at: 0 };
function command(name) {
  if (!store.base || document.querySelector('.modal-backdrop')) return false;
  const now = Date.now();
  if (lastCommand.name === name && now - lastCommand.at < 400) return true;
  lastCommand = { name, at: now };
  if (name === 'reload') refreshSnapshot();
  else if (name.startsWith('view:') && VIEWS[name.slice(5)]) navigate(name.slice(5));
  else return false;
  return true;
}

document.addEventListener('keydown', (e) => {
  if (document.querySelector('.modal-backdrop')) return;
  if (e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey) {
    const digit = /^Digit([1-9])$/.exec(e.code);
    const name = e.code === 'KeyR' ? 'reload' : digit && VIEW_KEYS[digit[1] - 1] ? `view:${VIEW_KEYS[digit[1] - 1]}` : null;
    if (name) {
      command(name);
      e.preventDefault();
      return;
    }
  }
  if (isTyping(e)) return;
  if ((e.metaKey || e.ctrlKey) && e.key === 'z' && !e.shiftKey) {
    const undone = store.undo();
    toast(undone ? _('Undone: {label}', { label: undone.label }) : _('Nothing to undo'));
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
  document.documentElement.lang = lang === 'zh' ? 'zh-Hant' : 'en';
  document.documentElement.style.setProperty('--kept-label', JSON.stringify(_('Keep'))); // badge text in app.css
  syncServerLang(); // server messages and the Mac app's startup dialogs follow the page's language
  app.append(
    h('header', { class: 'header' }, h('div', { class: 'brand' }, h('span', { class: 'brand-mark' }, '◐'), 'Backstage'), tabsEl, snapEl),
    mainEl,
    playerEl,
  );
  mountPlayerBar(playerEl);
  clear(mainEl, h('div', { class: 'loading' }, _('Reading the Serato database snapshot…')));
  try {
    await store.load();
  } catch (e) {
    clear(mainEl, h('div', { class: 'loading' }, h('p', {}, _('Could not read')), h('p', { class: 'muted' }, e.message), h('button', { class: 'btn', onclick: () => location.reload() }, _('Retry'))));
    return;
  }
  store.subscribe(() => {
    renderHeader();
    current?.update?.();
  });
  store.loadAudioInfo(); // background: reads each file's real codec / bit rate
  navigate(location.hash.slice(1) || 'home'); // the app opens on the Overview
  startWatch(); // reload after Serato changes its library; offer to apply when Serato closes
}

window.__crateDesk = { store, player, toast, command }; // the Mac app calls toast (download finished) and command (menu bar)
boot();
