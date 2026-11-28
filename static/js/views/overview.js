// Overview: what is left to do and how healthy the library is. Every card opens the view that handles it.
// Numbers come from the same functions the other views use, so they always agree.
import { openApplyDialog } from '../applyDialog.js';
import { buildReport } from '../folderReport.js';
import { _, _n } from '../i18n.js';
import { findDuplicates, findEmptyCrates, findUncategorized, isClassified, liveTracks } from '../model.js';
import { qualityScore } from '../quality.js';
import { store } from '../store.js';
import { clear, fmt, h, prefs } from '../ui.js';
import { pendingApplyOps, watch } from '../watch.js';

// Same duplicate scoring as the Cleanup view, so the group count matches.
const scoreOf = (t) => {
  const q = store.trackQuality(t);
  return q.known ? qualityScore(q) : undefined;
};

/** Pending screening in a folder: files not in Serato that are neither kept nor rejected yet. */
function screening(node) {
  const t = node.total;
  const pool = t.notImported + t.copy + t.rejected;
  const done = t.kept + t.rejected;
  return { pool, done, left: Math.max(0, pool - done) };
}

export function createOverviewView({ navigate }) {
  const el = h('div', { class: 'view overview' });
  let scanError = null;
  let report = null;
  let builtFor = '';

  if (!store.folderScan) {
    store
      .loadFolders()
      .then(render)
      .catch((e) => {
        scanError = e.message;
        render();
      });
  }
  const offWatch = watch.onChange(render);

  function ensureReport() {
    const scan = store.folderScan;
    if (!scan) return null;
    const stamp = `${store.version}|${scan.scannedAt}`;
    if (builtFor !== stamp) {
      report = buildReport(scan, store.eff, store.rules, (path, t) => store.qualityOf(path, t), store.screen);
      builtFor = stamp;
    }
    return report;
  }

  const openFolder = (key, { lowOnly = false, suspectOnly = false } = {}) => {
    prefs.set('folders.link', { key, lowOnly, suspectOnly });
    navigate('folders');
  };
  const openCleanup = (tab) => {
    prefs.set('cleanup.tab', tab);
    navigate('cleanup');
  };

  /** A clickable card: big number, label, optional detail line. */
  function card({ num, label, sub, tone = '', onClick, title }) {
    return h(
      'button',
      { class: `ov-card ${tone ? `is-${tone}` : ''} ${num === 0 ? 'is-zero' : ''}`, onclick: onClick, title },
      h('div', { class: 'ov-num num' }, typeof num === 'number' ? num.toLocaleString() : num),
      h('div', { class: 'ov-label' }, label),
      sub ? h('div', { class: 'ov-sub muted small' }, sub) : null,
    );
  }

  function render() {
    const eff = store.eff;
    const r = ensureReport();
    const waiting = r ? null : scanError ? _('common.scanFailed', { error: scanError }) : _('common.scanning');
    const songs = liveTracks(eff).length;
    const crates = eff.crates.size;
    const snap = store.base?.snapshot;

    // ---- to do ----
    // Counted from Serato like the Sort view (the folder report only sees files in the music folders).
    const unsorted = liveTracks(eff).filter((t) => !isClassified(eff, store.rules, t.id)).length;
    const loose = findUncategorized(eff).length;
    const folders = r ? r.roots.flatMap((root) => (root.children.length ? root.children : [root])) : [];
    const toScreen = folders.map((node) => ({ node, ...screening(node) })).filter((x) => x.left > 0);
    const nOps = pendingApplyOps();
    const nChanges = store.plan.changes.length;

    // ---- health ----
    const missing = [...eff.base.tracks.values()].filter((t) => !t.exists && !eff.relocated.has(t.id) && !eff.removedTracks.has(t.id)).length;
    const dismissed = new Set(prefs.get('dupes.dismissed', []));
    const dupes = findDuplicates(eff, scoreOf).filter((g) => !dismissed.has(g.key)).length;
    const empty = findEmptyCrates(eff).length;
    const low = r ? r.sum.low : waiting;
    const unreadable = r ? r.sum.unreadable : 0;
    const spec = store.spectrumProgress;
    const rootKey = r?.roots[0]?.key;

    const serato =
      watch.seratoRunning == null
        ? null
        : h('span', { class: `ov-serato ${watch.seratoRunning ? 'is-open' : 'is-closed'}` }, watch.seratoRunning ? _('overview.seratoOpen') : _('overview.seratoClosed'));

    clear(
      el,
      h(
        'div',
        { class: 'ov-head' },
        h('h2', {}, _('tab.overview')),
        h(
          'div',
          { class: 'muted small' },
          [_n(songs, 'overview.songCount'), _n(crates, 'overview.crateCount'), snap ? _('common.snapshot', { time: fmt.time(new Date(snap.takenAt).getTime()) }) : null]
            .filter(Boolean)
            .join(' · '),
        ),
        serato,
      ),

      h('div', { class: 'section-label' }, _('overview.toDo')),
      h(
        'div',
        { class: 'ov-grid' },
        card({
          num: unsorted,
          label: _('overview.toSort'),
          sub: loose ? _n(loose, 'overview.inNoCrate') : null,
          tone: 'unsorted',
          onClick: () => navigate('inbox'),
        }),
        ...(r
          ? toScreen.length
            ? toScreen.map(({ node, left, done, pool }) =>
                card({
                  num: left,
                  label: _('overview.toScreenIn', { folder: node.name }),
                  sub: done ? _('overview.screened', { done: done.toLocaleString(), total: pool.toLocaleString() }) : _('overview.notImported'),
                  tone: 'notImported',
                  onClick: () => openFolder(node.key),
                }),
              )
            : [card({ num: 0, label: _('overview.toScreen'), sub: _('overview.allScreened'), onClick: () => navigate('folders') })]
          : [card({ num: '…', label: _('overview.toScreen'), sub: waiting, onClick: () => navigate('folders') })]),
        h(
          'div',
          { class: `ov-card ov-plan ${nOps ? 'is-accent' : 'is-zero'}` },
          h('div', { class: 'ov-num num' }, nOps.toLocaleString()),
          h('div', { class: 'ov-label' }, _n(nOps, 'overview.pendingActions')),
          h('div', { class: 'ov-sub muted small' }, nChanges ? _n(nChanges, 'overview.fromChanges') : _('overview.planEmpty')),
          h(
            'div',
            { class: 'ov-actions' },
            h('button', { class: 'btn btn-sm', onclick: () => navigate('plan') }, _('overview.openPlan')),
            nOps
              ? watch.seratoRunning
                ? h('span', { class: 'muted small' }, _('overview.quitToApply'))
                : h('button', { class: 'btn btn-sm btn-primary', onclick: () => openApplyDialog() }, _('common.applyToSeratoMenu'))
              : null,
          ),
        ),
      ),

      h('div', { class: 'section-label' }, _('overview.libraryHealth')),
      h(
        'div',
        { class: 'ov-grid' },
        card({ num: missing, label: _('overview.missingFiles'), tone: 'missing', onClick: () => openCleanup('missing') }),
        card({ num: dupes, label: _('overview.duplicateGroups'), tone: 'warn', onClick: () => openCleanup('dupes') }),
        card({ num: empty, label: _('overview.emptyCrates'), onClick: () => openCleanup('empty') }),
        card({
          num: low,
          label: _('overview.lowQualityFiles'),
          sub: unreadable ? _n(unreadable, 'overview.unreadable') : null,
          tone: 'missing',
          title: store.audioProgress?.running ? _('overview.readingFormats') : undefined,
          onClick: () => (rootKey ? openFolder(rootKey, { lowOnly: true }) : navigate('folders')),
        }),
        spec?.available === false
          ? null
          : card({
              num: store.suspects().filter((x) => !x.genuine).length,
              label: _('overview.suspects'),
              sub: spec?.running
                ? _('common.checkingForTranscodes', { done: spec.done.toLocaleString(), total: spec.total.toLocaleString() })
                : spec?.pending
                  ? _n(spec.pending, 'overview.unchecked')
                  : _('overview.suspectsHint'),
              tone: 'warn',
              onClick: () => navigate('quality'),
            }),
      ),
    );
  }

  render();
  return { el, title: _('tab.overview'), update: render, onKey: () => false, destroy: offWatch };
}
