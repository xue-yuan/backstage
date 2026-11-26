import { mountPlayerBar, player } from './player.js';
import { store } from './store.js';
import { clear, fmt, h, isTyping, modal, prefs, toast } from './ui.js';
import { createCleanupView } from './views/cleanup.js';
import { createFoldersView } from './views/folders.js';
import { createInboxView } from './views/inbox.js';
import { createOverviewView } from './views/overview.js';
import { createPlanView } from './views/plan.js';
import { createStructureView } from './views/structure.js';
import { startWatch } from './watch.js';
import { _, _n, lang, setLang, switchTo, syncServerLang } from './i18n.js';

const VIEWS = {
  home: { label: _('Overview'), create: createOverviewView },
  folders: { label: _('Folders'), create: createFoldersView },
  inbox: { label: _('Sort'), create: createInboxView },
  cleanup: { label: _('Cleanup'), create: createCleanupView },
  structure: { label: _('Crates'), create: createStructureView },
  plan: { label: _('Plan'), create: createPlanView },
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
    h('span', { class: 'readonly-pill', title: _('Normally only a copy of the Serato database is read. Serato is written only when you press "Apply to Serato" in Plan (with Serato closed), after an automatic backup') }, _('● Serato is written only when you press Apply')),
    snap ? h('span', { class: 'muted small', title: _('Source: {path}', { path: snap.source }) }, _('Snapshot {time}', { time: fmt.time(new Date(snap.takenAt).getTime()) })) : null,
    h('button', { class: 'btn btn-ghost btn-sm', onclick: refreshSnapshot, title: _('Copy the Serato database again (fine while Serato is open)') }, _('↻ Reload')),
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
  const rows = [
    [_('Sort'), [['↑ ↓ / J K', _('Previous / next song')], [_('Space'), _('Play / pause')], ['← →', _('Back / forward 10 s (⇧ 30 s)')], ['Q W E R', _('Play from 0% / 25% / 50% / 75%')], ['1–9', _('Add to / remove from a pinned crate')], ['⇧ 1–5', _('Add to a suggested crate')], ['/', _('Search other crates (or create a new one)')], ['X', _('Reject this song')]]],
    [_('Folders'), [['↑ ↓', _('Select a folder (after clicking a song: change song)')], ['← →', _('Collapse / expand')], [_('Space'), _('Play / pause')], ['Q W E R', _('Play from 0% / 25% / 50% / 75%')], ['X', _('Reject')], ['V', _('Keep')], ['Esc', _('Back to the folder tree')]]],
    [_('Crates'), [['↑ ↓', _('Select a crate')], ['← →', _('Collapse / expand')], ['Enter / F2', _('Rename')], ['N', _('New child crate')], ['Delete', _('Delete crate (added to the plan)')], ['⌘A', _('Select all songs (after clicking the song list)')]]],
    [_('Everywhere'), [['⌘Z', _('Undo the last change')], ['?', _('Show this help')]]],
  ];
  modal({
    title: _('Keyboard shortcuts'),
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

window.__crateDesk = { store, player, toast }; // toast is also used by the Mac app (download finished)
boot();
