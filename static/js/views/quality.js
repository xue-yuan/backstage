// Quality check: run the transcode check by hand (it never runs on its own, to save power) and work
// through the suspect files: listen, look at the spectrum, mark the ones that are fine, reject the rest.
import { trackMatches } from '../model.js';
import { player } from '../player.js';
import { qualityBadge } from '../quality.js';
import { noteMark, noteMenuItem } from '../notes.js';
import { showSpectrum } from '../spectrogram.js';
import { store } from '../store.js';
import { clear, contextMenu, fmt, h, prefs, revealInFinder, toast, VirtualList } from '../ui.js';
import { _, _n } from '../i18n.js';

const SPEEDS = [
  ['saver', () => _('Power saving (1 file at a time)')],
  ['normal', () => _('Normal (3 at a time)')],
  ['fast', () => _('Fast (6 at a time)')],
];

export function createQualityView({ navigate } = {}) {
  let speed = prefs.get('quality.speed', 'saver');
  let kind = 'all'; // 'all' | '128' | 'mid' | 'lossless'
  let folder = '';
  let filter = '';
  let inSeratoOnly = false;
  let showGenuine = false;
  let selectedKey = null;
  let items = [];

  // ---------- layout ----------
  const statusEl = h('section', { class: 'panel qc-status' });
  const filterInput = h('input', {
    class: 'input input-sm',
    placeholder: _('Filter by title, artist, folder…'),
    oninput: (e) => {
      filter = e.target.value;
      renderList();
    },
    onkeydown: (e) => {
      if (e.key === 'Escape') e.target.blur();
      e.stopPropagation();
    },
  });
  const kindSelect = h(
    'select',
    {
      class: 'input input-sm',
      onchange: (e) => {
        kind = e.target.value;
        e.target.blur();
        renderList();
      },
    },
    h('option', { value: 'all' }, _('All suspects')),
    h('option', { value: '128' }, _('Looks like 128k')),
    h('option', { value: 'mid' }, _('Looks like 160–256k')),
    h('option', { value: 'lossless' }, _('Fake lossless')),
  );
  const folderSelect = h('select', {
    class: 'input input-sm qc-folder',
    onchange: (e) => {
      folder = e.target.value;
      e.target.blur();
      renderList();
    },
  });
  const check = (label, get, set) =>
    h(
      'label',
      { class: 'check' },
      h('input', {
        type: 'checkbox',
        checked: get(),
        onchange: (e) => {
          set(e.target.checked);
          renderList();
        },
      }),
      label,
    );
  const countEl = h('div', { class: 'muted small qc-count' });
  const vlist = new VirtualList({ rowHeight: 44, renderRow, className: 'track-list' });
  const listEl = h(
    'section',
    { class: 'panel qc-list' },
    h(
      'div',
      { class: 'toolbar qc-toolbar' },
      filterInput,
      kindSelect,
      folderSelect,
      check(_('Only songs in Serato'), () => inSeratoOnly, (v) => (inSeratoOnly = v)),
      check(_('Show files marked genuine'), () => showGenuine, (v) => (showGenuine = v)),
    ),
    countEl,
    h(
      'div',
      { class: 'trow trow-quality trow-head' },
      h('span'),
      h('span', {}, _('Title / artist')),
      h('span', {}, _('Format')),
      h('span', { class: 'num', title: _('Where the sound stops') }, _('Cut-off')),
      h('span', {}, _('Looks like')),
      h('span', {}, 'Serato'),
      h('span'),
    ),
    vlist.el,
  );
  const el = h('div', { class: 'view quality' }, statusEl, listEl);
  const offPlayer = player.onChange(() => vlist.render());

  // ---------- status / run ----------
  function renderStatus(suspects) {
    const s = store.spectrumProgress;
    if (s && s.available === false) {
      clear(
        statusEl,
        h('h2', {}, _('Quality check')),
        h('div', { class: 'notice notice-warn' }, _('This check requires ffmpeg. Run "brew install ffmpeg" in Terminal, then reopen Cratify.')),
      );
      return;
    }
    const running = !!s?.running;
    const pending = s?.pending ?? null;
    const checked = s?.checked ?? 0;
    let eta = '';
    const doneHere = s?.done - (s?.startDone ?? 0); // files finished since this page started watching
    if (running && doneHere > 3 && s.startedAt) {
      const left = ((Date.now() - s.startedAt) / doneHere) * (s.total - s.done);
      eta = left > 90000 ? _('about {n} min left', { n: Math.round(left / 60000) }) : _('less than 2 min left');
    }
    const speedSelect = h(
      'select',
      {
        class: 'input input-sm',
        disabled: running,
        title: _('Number of files analysed at the same time. All speeds run at background priority and do not affect Serato.'),
        onchange: (e) => {
          prefs.set('quality.speed', (speed = e.target.value));
          e.target.blur();
        },
      },
      SPEEDS.map(([v, label]) => h('option', { value: v }, label())),
    );
    speedSelect.value = speed;
    clear(
      statusEl,
      h(
        'div',
        { class: 'qc-head' },
        h(
          'div',
          {},
          h('h2', {}, _('Quality check')),
          h('p', { class: 'muted small' }, _('Finds transcodes such as fake 320k and fake lossless. To save power, it runs only when started. Checked files are remembered, so each run checks only new or changed files.')),
        ),
        h(
          'div',
          { class: 'qc-stats' },
          stat(checked.toLocaleString(), _('checked')),
          stat(pending == null ? '…' : pending.toLocaleString(), _('new, not checked yet'), pending ? 'is-todo' : ''),
          stat(suspects.toLocaleString(), _('suspect'), suspects ? 'is-warn' : ''),
        ),
      ),
      running
        ? h(
            'div',
            { class: 'qc-run' },
            h('div', { class: 'progress' }, h('div', { class: 'progress-fill', style: { width: `${s.total ? (s.done / s.total) * 100 : 0}%` } })),
            h('span', { class: 'muted small' }, _('Checking {done} / {total}', { done: s.done.toLocaleString(), total: s.total.toLocaleString() }), eta ? ` · ${eta}` : ''),
            h('button', { class: 'btn btn-sm', disabled: !!s.stopping, onclick: () => store.stopSpectrum() }, s.stopping ? _('Stopping…') : _('Stop')),
          )
        : h(
            'div',
            { class: 'qc-run' },
            speedSelect,
            pending
              ? h(
                  'button',
                  { class: 'btn btn-primary', onclick: () => store.runSpectrum(speed).catch((e) => toast(e.message, { tone: 'danger' })) },
                  _n(pending, 'Check {n} new file', 'Check {n} new files'),
                )
              : h('span', { class: 'qc-done' }, _('Everything is checked ✓')),
            s?.lastRun ? h('span', { class: 'muted small' }, _('Last check: {time}', { time: `${fmt.date(s.lastRun)} ${fmt.time(s.lastRun * 1000)}` })) : null,
          ),
      h('div', { class: 'muted small qc-note' }, _('"Suspect" is an automatic estimate. Check the spectrum and listen before deleting anything; mark files that are fine as genuine (F).')),
    );
  }

  const stat = (num, label, cls = '') => h('div', { class: `qc-stat ${cls}` }, h('div', { class: 'stat-num' }, num), h('div', { class: 'muted small' }, label));

  // ---------- data ----------
  function renderList() {
    const all = store.suspects();
    const visible = all.filter((r) => showGenuine || !r.genuine);
    // Folder choices: the folders that hold suspects, most first.
    const perDir = new Map();
    for (const r of visible) perDir.set(r.dir, (perDir.get(r.dir) || 0) + 1);
    const dirs = [...perDir].sort((a, b) => b[1] - a[1]);
    if (folder && !perDir.has(folder)) folder = '';
    clear(folderSelect, h('option', { value: '' }, _('All folders')), dirs.map(([d, n]) => h('option', { value: d }, `${fmt.shortPath(d)} (${n})`)));
    folderSelect.value = folder;

    items = visible
      .filter((r) => {
        if (kind === '128' && (r.s.lossless || r.s.source !== 128)) return false;
        if (kind === 'mid' && (r.s.lossless || r.s.source === 128)) return false;
        if (kind === 'lossless' && !r.s.lossless) return false;
        if (folder && r.dir !== folder) return false;
        if (inSeratoOnly && !r.track) return false;
        if (filter && !(r.track ? trackMatches(r.track, filter) : r.path.toLowerCase().includes(filter.toLowerCase()))) return false;
        return true;
      })
      .sort((a, b) => a.dir.localeCompare(b.dir) || a.path.localeCompare(b.path));
    if (!items.some((r) => r.key === selectedKey)) selectedKey = items[0]?.key ?? null;

    countEl.textContent = all.length ? _('{shown} of {total} suspect files', { shown: items.length.toLocaleString(), total: visible.length.toLocaleString() }) : '';
    const empty = !store.spectrum.size
      ? _('No files checked yet. Press the button above to start.')
      : visible.length
        ? _('No files match the filters')
        : _('No suspect files');
    vlist.setItems(items, h('div', { class: 'empty' }, empty));
    renderStatus(all.filter((r) => !r.genuine).length);
  }

  function renderRow(r) {
    const t = r.track;
    const play = playable(r);
    const crates = t ? (store.eff.cratesOf.get(t.id) || []).length : 0;
    const removed = t && store.eff.removedTracks.has(t.id);
    const rejected = t ? store.eff.rejectedTracks.has(t.id) : store.screen.reject.has(r.path);
    return h(
      'div',
      {
        class: `trow trow-quality ${r.key === selectedKey ? 'is-selected' : ''} ${r.genuine || rejected || removed ? 'is-done' : ''}`,
        onclick: () => select(r.key),
        ondblclick: () => player.play(play),
        oncontextmenu: (e) => rowMenu(e, r),
      },
      h('span', { class: 'trow-status' }, player.isCurrent(player.playId(play)) ? (player.playing ? '♪' : '❚❚') : r.genuine ? '✓' : ''),
      h(
        'div',
        { class: 'trow-main' },
        h(
          'div',
          { class: 'trow-title', title: r.path },
          noteMark(t ? { track: t } : { path: r.path }),
          t ? t.title || t.fileName : r.path.slice(r.path.lastIndexOf('/') + 1),
          r.genuine ? h('span', { class: 'tag tag-ok' }, _('Marked genuine')) : null,
          rejected ? h('span', { class: 'tag tag-danger' }, _('Rejected')) : removed ? h('span', { class: 'tag tag-danger' }, _('Removed (in the plan)')) : null,
        ),
        h('div', { class: 'trow-sub' }, [t?.artist, fmt.shortPath(r.dir)].filter(Boolean).join(' · ')),
      ),
      h('span', {}, qualityBadge(r.genuine ? { ...r.q, suspect: null } : r.q, { compact: true })),
      h('span', { class: 'num' }, `${r.s.cutoff.toFixed(1)} kHz`),
      h('span', { class: 'muted' }, r.s.lossless ? _('MP3 / AAC') : `${r.s.source}k`),
      h('span', { class: 'muted small' }, t ? _n(crates, 'In {n} crate', 'In {n} crates') : _('Not imported')),
      h(
        'button',
        {
          class: 'btn btn-ghost btn-xs',
          onclick: (e) => {
            e.stopPropagation();
            openSpectrum(r);
          },
        },
        _('Spectrum'),
      ),
    );
  }

  const playable = (r) =>
    r.track ?? { playKey: `f${r.path}`, src: `/api/audio-file?path=${encodeURIComponent(r.path)}`, title: r.path.slice(r.path.lastIndexOf('/') + 1), artist: _('File not in Serato') };
  const titleOf = (r) => (r.track ? store.trackLabel(r.track.id) : r.path.slice(r.path.lastIndexOf('/') + 1));
  const openSpectrum = (r) => showSpectrum({ path: r.path, title: titleOf(r), quality: r.q });

  function select(key, { scroll = false } = {}) {
    selectedKey = key;
    vlist.render();
    if (scroll) vlist.scrollToIndex(items.findIndex((r) => r.key === key));
  }

  // ---------- actions ----------
  function setFine(r, on) {
    // Marking a file fine moves on to the next one (and keeps playing), like working down a list in Sort.
    // With "Show the ones marked fine" off the row leaves the list, so the next row is picked before that.
    const i = items.findIndex((x) => x.key === r.key);
    const next = on && r.key === selectedKey ? (items[i + 1] ?? (showGenuine ? null : items[i - 1])) : null;
    const wasPlaying = next && player.playing && player.isCurrent(player.playId(playable(r)));
    if (next) selectedKey = next.key;
    store.setGenuine(r.path, on);
    if (next) {
      select(next.key, { scroll: true });
      if (wasPlaying) player.play(playable(next));
    }
    toast(on ? _('Marked genuine: {track}', { track: titleOf(r) }) : _('Marked suspect again: {track}', { track: titleOf(r) }));
  }

  function reject(r) {
    if (r.track) {
      if (store.eff.removedTracks.has(r.track.id)) return;
      store.commit(_('Reject: {track}', { track: titleOf(r) }), [store.opReject(r.track.id)]);
    } else {
      store.setScreenMark([r.path], 'reject');
      toast(_('Marked reject. Move it to the Trash from Folders ("Review and move to Trash…").'), { timeout: 6000 });
    }
  }

  function rowMenu(e, r) {
    select(r.key);
    contextMenu(e, [
      { label: player.isCurrent(player.playId(playable(r))) && player.playing ? _('Pause') : _('Play'), hint: _('Space'), action: () => player.toggle(playable(r)) },
      { label: _('Spectrum'), hint: 'Enter', action: () => openSpectrum(r) },
      { label: _('Show in Finder'), action: () => revealInFinder(r.path) },
      r.track ? noteMenuItem({ track: r.track }) : noteMenuItem({ path: r.path }),
      'sep',
      r.genuine ? { label: _('Mark as suspect again'), action: () => setFine(r, false) } : { label: _('Mark as genuine (not a transcode)'), hint: 'F', action: () => setFine(r, true) },
      'sep',
      { label: _('Reject'), hint: 'X', danger: true, action: () => reject(r) },
    ]);
  }

  function move(delta) {
    const i = items.findIndex((r) => r.key === selectedKey);
    const next = items[Math.min(items.length - 1, Math.max(0, i + delta))];
    if (!next) return;
    const wasPlaying = player.playing && items[i] && player.isCurrent(player.playId(playable(items[i])));
    select(next.key, { scroll: true });
    if (wasPlaying) player.play(playable(next));
  }

  renderList();
  if (!store.spectrumProgress) store.refreshSpectrum();

  return {
    el,
    title: _('Quality'),
    update: renderList,
    onKey(e) {
      const r = items.find((x) => x.key === selectedKey);
      switch (e.key) {
        case 'ArrowDown':
        case 'j':
          move(1);
          return true;
        case 'ArrowUp':
        case 'k':
          move(-1);
          return true;
        case ' ':
          if (r) player.toggle(playable(r));
          return true;
        case 'Enter':
          if (r) openSpectrum(r);
          return true;
        case 'f':
          if (r) setFine(r, !r.genuine);
          return true;
        case 'x':
          if (r) reject(r);
          return true;
        case 'q':
          if (r) player.play(playable(r), { at: 0 });
          return true;
        default:
          return false;
      }
    },
    destroy() {
      offPlayer();
      vlist.destroy();
    },
  };
}
