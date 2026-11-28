// Folders view: which folders on disk are already sorted into crates, which still need work.
// Disk files are matched to Serato tracks by path; "classified" follows store.rules.
// Screening: mark files reject (X) / keep (V) while listening. Files Serato does not use can then be
// moved to the macOS Trash (with one-click restore); tracks in Serato are staged in the plan instead.
import { BAR, buildReport, fileMatches as fileMatchesQuery, folderChildren, folderFiles, HINT, LABEL, STATUSES } from '../folderReport.js';
import { dirOf, effectivePath, isClassified } from '../model.js';
import { player } from '../player.js';
import { LOW_QUALITY_TEXT, qualityBadge } from '../quality.js';
import { addToSerato, dontAdd, importable } from '../importSongs.js';
import { noteMark, noteMenuItem } from '../notes.js';
import { showSpectrum, spectrumAvailable } from '../spectrogram.js';
import { api, store } from '../store.js';
import { editMusicFolders } from '../musicFolders.js';
import { openUnsortedEditor, unsortedRoots } from '../unsorted.js';
import { clear, confirmDialog, contextMenu, fmt, h, modal, prefs, toast, VirtualList } from '../ui.js';
import { _, _n } from '../i18n.js';

const stripExt = (n) => n.replace(/\.[^.]+$/, '');

// ---------- view ----------
export function createFoldersView({ navigate }) {
  let report = null;
  let loading = false;
  let loadError = null;
  let builtFor = null;
  let selectedKey = prefs.get('folders.selected', null);
  const expanded = new Set(prefs.get('folders.expanded', []));
  let hideDone = prefs.get('folders.hideDone', false);
  let sortBy = prefs.get('folders.sort', 'name');
  let statusFilter = 'all';
  let lowOnly = false;
  let suspectOnly = false; // suspected transcodes (fake 320k / lossless)
  // One-shot link from the Overview: open this folder, optionally showing only low-quality files.
  const link = prefs.get('folders.link', null);
  if (link) {
    prefs.set('folders.link', null);
    if (link.key) {
      selectedKey = link.key;
      for (let k = link.key; k.includes('/'); k = k.slice(0, k.lastIndexOf('/'))) expanded.add(k); // reveal it in the tree
    }
    lowOnly = !!link.lowOnly;
    suspectOnly = !!link.suspectOnly;
  }
  let includeSub = prefs.get('folders.includeSub', true);
  let filter = '';
  let visibleRows = [];
  let fileItems = [];
  let selectedFile = null; // path of the highlighted file row
  let focusFiles = false; // arrow keys move in the file list (true) or the folder tree (false)

  const summaryEl = h('section', { class: 'panel folders-summary' });
  const treeEl = h('div', { class: 'ftree' });
  const treeToolbar = h('div', { class: 'toolbar' });
  const treePanel = h('aside', { class: 'panel ftree-panel' }, h('div', { class: 'panel-head' }, h('h2', {}, _('tab.folders'))), treeToolbar, treeEl);
  const detailHead = h('div', { class: 'fdetail-head' });
  const detailToolbar = h('div', { class: 'toolbar' });
  const fileHead = h(
    'div',
    { class: 'fileRow fileRow-head' },
    h('span'),
    h('span'),
    h('span', {}, _('folders.songs')),
    h('span', {}, _('folders.inCrates')),
    h('span', { class: 'num' }, _('common.format')),
    h('span', { class: 'num', title: _('folders.screenKeys') }, _('folders.screen')),
  );
  const vlist = new VirtualList({ rowHeight: 44, renderRow: renderFile, className: 'file-list' });
  const detailPanel = h('section', { class: 'panel fdetail' }, detailHead, detailToolbar, fileHead, vlist.el);
  const el = h('div', { class: 'view folders' }, summaryEl, treePanel, detailPanel);

  const offPlayer = player.onChange(() => vlist.render());

  async function load(refresh = false) {
    loading = true;
    loadError = null;
    render();
    try {
      await store.loadFolders(refresh);
      if (refresh) toast(_('folders.foldersRescanned'));
    } catch (e) {
      loadError = e.message;
    }
    loading = false;
    render();
  }

  function ensureReport() {
    const scan = store.folderScan;
    if (!scan) return null;
    const stamp = `${store.version}|${scan.scannedAt}`;
    if (builtFor !== stamp) {
      report = buildReport(scan, store.eff, store.rules, (path, t) => store.qualityOf(path, t), store.screen);
      builtFor = stamp;
      if (!report.nodes.has(selectedKey)) selectedKey = report.roots[0]?.key ?? null;
      if (!expanded.size) report.roots.forEach((r) => expanded.add(r.key));
    }
    return report;
  }

  const selected = () => report?.nodes.get(selectedKey) ?? null;

  // ---------- summary ----------
  function stackedBar(counts, cls = '') {
    const n = BAR.reduce((s, k) => s + counts[k], 0);
    return h(
      'div',
      { class: `sbar ${cls}` },
      n ? BAR.filter((k) => counts[k]).map((k) => h('span', { class: `sbar-seg st-${k}`, style: { flexGrow: counts[k] }, title: `${LABEL[k]} ${counts[k]}` })) : null,
    );
  }

  function renderSummary() {
    const r = report;
    const unsortedCount = unsortedRoots().length;
    clear(
      summaryEl,
      h(
        'div',
        { class: 'fsum-top' },
        h(
          'div',
          { class: 'fsum-title' },
          h('h2', {}, r ? _n(r.sum.files, 'folders.fileCount', { roots: r.roots.map((x) => x.name).join(_('sep.comma')) }) : _('folders.folderStatus')),
          h(
            'span',
            { class: 'muted small' },
            store.folderScan ? _('folders.scannedAt', { time: fmt.time(store.folderScan.scannedAt * 1000), s: store.folderScan.seconds }) : '',
          ),
        ),
        h(
          'div',
          { class: 'toolbar' },
          h('button', { class: 'btn btn-sm', onclick: () => editMusicFolders(), title: _('folders.musicFoldersTitle') }, _('folders.musicFoldersButton', { n: store.folderScan?.roots.length ?? 0 })),
          h('button', { class: 'btn btn-sm', onclick: openUnsortedEditor, title: _('folders.unsortedButtonTitle') }, _('folders.unsortedButton', { n: unsortedCount })),
          h('button', { class: 'btn btn-sm', disabled: loading, onclick: () => load(true) }, loading ? _('common.scanning') : _('folders.rescan')),
        ),
      ),
      r ? stackedBar(r.sum, 'sbar-lg') : null,
      r ? trashBar() : null,
      r
        ? h(
            'div',
            { class: 'legend' },
            STATUSES.map((k) =>
              h('span', { class: 'legend-item', title: HINT[k] }, h('span', { class: `swatch st-${k}` }), LABEL[k], h('strong', { class: 'num' }, r.sum[k].toLocaleString())),
            ),
            h('span', { class: 'legend-sep' }),
            store.audioProgress?.running
              ? h('span', { class: 'muted small' }, _('folders.readingFileFormats', { done: store.audioProgress.done.toLocaleString(), total: store.audioProgress.total.toLocaleString() }))
              : store.audioProgress?.error
                ? h('span', { class: 'muted small' }, _('folders.readFormatsFailed', { error: store.audioProgress.error }))
                : h('span', { class: 'legend-item', title: _('common.lowQualityReasons', { reasons: LOW_QUALITY_TEXT }) }, h('span', { class: 'qbadge is-low' }, _('common.lowQuality')), h('strong', { class: 'num' }, r.sum.low.toLocaleString())),
            r.sum.suspect ? h('span', { class: 'legend-item', title: _('folders.suspectHint') }, h('span', { class: 'qbadge-suspect' }, _('common.suspect')), h('strong', { class: 'num' }, r.sum.suspect.toLocaleString())) : null,
            store.spectrumProgress?.running ? h('span', { class: 'muted small' }, _('common.checkingForTranscodes', { done: store.spectrumProgress.done.toLocaleString(), total: store.spectrumProgress.total.toLocaleString() })) : null,
            r.outsideCount ? h('span', { class: 'muted small', title: _('folders.outsideHint') }, _n(r.outsideCount, 'folders.outsideCount')) : null,
            r.outsideMissing ? h('span', { class: 'muted small' }, _n(r.outsideMissing, 'folders.outsideMissing')) : null,
          )
        : null,
    );
  }

  /** Files marked reject that are not in Serato: these can go to the Trash right away. */
  function trashable() {
    const out = [];
    for (const node of report?.nodes.values() || []) for (const f of node.files) if (f.status === 'rejected' && !f.viaPlan) out.push(f);
    return out;
  }

  function trashBar() {
    const files = trashable();
    const viaPlan = store.eff.rejectedTracks?.size || 0;
    if (!files.length && !viaPlan && !store.lastTrashed.length) return null;
    const bytes = files.reduce((n, f) => n + (f.size || 0), 0);
    return h(
      'div',
      { class: 'trash-bar' },
      files.length
        ? [
            h('span', {}, _n(files.length, 'folders.rejectedPending', { size: fmt.size(bytes) })),
            h('button', { class: 'btn btn-sm btn-danger', onclick: () => openTrash(files) }, _('common.reviewTrash')),
          ]
        : null,
      viaPlan ? h('span', { class: 'muted small', title: _('folders.rejectedInSeratoHint') }, _n(viaPlan, 'folders.rejectedInSerato')) : null,
      store.lastTrashed.length
        ? h('button', { class: 'btn btn-sm btn-ghost push-right', onclick: () => restore(store.lastTrashed) }, _n(store.lastTrashed.length, 'folders.restoreTrashed'))
        : null,
    );
  }

  // ---------- tree ----------
  const sortedChildren = (node) => folderChildren(node, { sortBy, hideDone, keepKey: selectedKey });

  function renderTreeToolbar() {
    const sortSelect = h(
      'select',
      {
        class: 'input input-sm',
        onchange: (e) => {
          sortBy = e.target.value;
          prefs.set('folders.sort', sortBy);
          renderTree();
        },
      },
      h('option', { value: 'name' }, _('folders.byName')),
      h('option', { value: 'todo' }, _('folders.mostRemainingFirst')),
    );
    sortSelect.value = sortBy;
    clear(
      treeToolbar,
      sortSelect,
      h(
        'label',
        { class: 'check' },
        h('input', {
          type: 'checkbox',
          checked: hideDone,
          onchange: (e) => {
            hideDone = e.target.checked;
            prefs.set('folders.hideDone', hideDone);
            renderTree();
          },
        }),
        _('folders.hideFinished'),
      ),
    );
  }

  function renderTree() {
    if (!report) {
      clear(treeEl, h('div', { class: 'empty' }, loading ? _('common.scanning') : loadError ? _('common.scanFailed', { error: loadError }) : ''));
      return;
    }
    visibleRows = [];
    const walk = (node) => {
      visibleRows.push(node);
      if (expanded.has(node.key)) sortedChildren(node).forEach(walk);
    };
    report.roots.forEach(walk);
    clear(treeEl, visibleRows.map(treeRow));
  }

  function treeRow(node) {
    const hasKids = node.children.length > 0;
    const open = expanded.has(node.key);
    const t = node.total;
    return h(
      'div',
      {
        class: `frow ${node.key === selectedKey ? 'is-selected' : ''} ${node.ghost ? 'is-ghost' : ''}`,
        style: { paddingLeft: `${4 + node.depth * 14}px` },
        dataset: { key: node.key },
        onclick: () => {
          focusFiles = false;
          select(node.key);
        },
        oncontextmenu: (e) => folderMenu(e, node),
        ondblclick: () => hasKids && toggle(node.key),
      },
      h(
        'button',
        {
          class: `caret ${hasKids ? '' : 'is-leaf'}`,
          tabindex: -1,
          onclick: (e) => {
            e.stopPropagation();
            if (hasKids) toggle(node.key);
          },
        },
        hasKids ? h('span', { class: `chev ${open ? 'is-open' : ''}` }) : null,
      ),
      h('span', { class: 'frow-name', title: node.path }, node.name),
      stackedBar(t),
      h(
        'span',
        { class: 'frow-count' },
        t.missing ? h('span', { class: 'tag tag-danger', title: _n(t.missing, 'folders.missingCount') }, `✕${t.missing}`) : null,
        node.todo ? h('span', { class: 'todo', title: _('folders.folderCounts', { unsorted: t.unsorted, notImported: t.notImported }) }, node.todo.toLocaleString()) : node.done ? h('span', { class: 'done', title: _('folders.finished') }, '✓') : null,
      ),
    );
  }

  function toggle(key) {
    if (expanded.has(key)) expanded.delete(key);
    else expanded.add(key);
    prefs.set('folders.expanded', [...expanded]);
    renderTree();
  }

  function select(key, { scroll = false } = {}) {
    if (key === selectedKey) return;
    selectedKey = key;
    prefs.set('folders.selected', key);
    statusFilter = 'all';
    lowOnly = false;
    suspectOnly = false;
    selectedFile = null;
    renderTree();
    renderDetail();
    vlist.el.scrollTop = 0;
    if (scroll) treeEl.querySelector('.frow.is-selected')?.scrollIntoView({ block: 'nearest' });
  }

  // ---------- detail ----------
  const subtreeFiles = (node) => folderFiles(node, includeSub);
  const fileMatches = (f, q) => fileMatchesQuery(f, f.assetId != null ? store.base.tracks.get(f.assetId) : null, q);

  function renderDetail() {
    const node = selected();
    if (!node) {
      clear(detailHead, h('div', { class: 'empty' }, report ? _('folders.pickFolder') : loading ? _('common.scanning') : loadError ? _('common.scanFailed', { error: loadError }) : ''));
      clear(detailToolbar);
      vlist.setItems([]);
      return;
    }
    const t = includeSub ? node.total : { ...node.direct, files: node.files.length - node.direct.missing };
    const todo = t.unsorted + t.notImported;
    const crates = (report.folderCrates.get(node.key) || []).map((id) => store.eff.pathOf(id));

    const stat = (k) =>
      h(
        'button',
        {
          class: `fstat ${statusFilter === k ? 'is-active' : ''} ${t[k] ? '' : 'is-zero'}`,
          title: HINT[k],
          onclick: () => {
            statusFilter = statusFilter === k ? 'all' : k;
            renderDetail();
          },
        },
        h('span', { class: `swatch st-${k}` }),
        h('span', { class: 'fstat-num num' }, t[k].toLocaleString()),
        h('span', { class: 'muted small' }, LABEL[k]),
      );

    const notes = [];
    if (node.ghost) notes.push(h('div', { class: 'fnote fnote-danger' }, _('folders.folderGone')));
    if (t.files && !todo && !t.missing)
      notes.push(h('div', { class: 'fnote fnote-ok' }, _('folders.finishedNote'), t.copy ? _n(t.copy, 'folders.moreCopies') : '', _('sep.period')));
    if (t.unsorted)
      notes.push(
        h(
          'div',
          { class: 'fnote fnote-warn' },
          h('span', {}, _n(t.unsorted, 'folders.unsortedNote')),
          h('button', { class: 'btn btn-sm btn-primary', onclick: () => sortHere(node) }, _('folders.goSort')),
        ),
      );
    if (t.notImported || t.rejected) {
      const screened = t.kept + t.rejected;
      const pool = t.notImported + t.copy + t.rejected;
      notes.push(
        h(
          'div',
          { class: 'fnote fnote-new' },
          h(
            'div',
            { class: 'fnote-text' },
            h('strong', {}, _('folders.screenProgress', { done: screened.toLocaleString(), total: pool.toLocaleString() })),
            _('folders.screenCounts', { kept: t.kept.toLocaleString(), rejected: t.rejected.toLocaleString() }),
            h('br'),
            h('span', { class: 'muted' }, _('folders.screenHint')),
          ),
          addButton(node),
        ),
      );
    }
    if (crates.length)
      notes.push(
        h('div', { class: 'fnote' }, _('folders.folderCrateNote', { crates: crates.map((name) => _('sep.quoted', { name })).join(_('sep.comma')) })),
      );
    if (t.unreadable)
      notes.push(h('div', { class: 'fnote fnote-danger' }, _n(t.unreadable, 'folders.unreadableNote')));
    if (t.low || t.unreadable)
      notes.push(
        h(
          'div',
          { class: 'fnote fnote-danger' },
          h('span', { title: LOW_QUALITY_TEXT }, t.low ? _n(t.low, 'folders.lowQualityNote', { rule: LOW_QUALITY_TEXT }) : _('folders.qualityFine')),
          h(
            'button',
            {
              class: `btn btn-sm ${lowOnly ? 'btn-primary' : ''}`,
              onclick: () => {
                lowOnly = !lowOnly;
                renderDetail();
              },
            },
            lowOnly ? _('folders.showAll') : _('folders.lowQualityOnly'),
          ),
        ),
      );
    if (t.suspect)
      notes.push(
        h(
          'div',
          { class: 'fnote fnote-warn' },
          h('span', {}, _n(t.suspect, 'folders.suspectNote')),
          h(
            'button',
            {
              class: `btn btn-sm ${suspectOnly ? 'btn-primary' : ''}`,
              onclick: () => {
                suspectOnly = !suspectOnly;
                renderDetail();
              },
            },
            suspectOnly ? _('folders.showAll') : _('folders.suspectOnly'),
          ),
        ),
      );
    if (t.missing)
      notes.push(
        h(
          'div',
          { class: 'fnote fnote-danger' },
          h('span', {}, _n(t.missing, 'folders.missingNote')),
          h('button', { class: 'btn btn-sm', onclick: () => navigate('cleanup') }, _('folders.fixInCleanup')),
        ),
      );

    clear(
      detailHead,
      h(
        'div',
        { class: 'fdetail-title' },
        h('div', { class: 'grow' }, h('h2', {}, node.name), h('div', { class: 'path', title: node.path }, fmt.shortPath(node.path))),
        !node.ghost ? h('button', { class: 'btn btn-sm', onclick: () => reveal(node.path) }, _('common.showInFinder')) : null,
      ),
      h('div', { class: 'fstats' }, STATUSES.map(stat)),
      notes,
    );

    const filterInput = h('input', {
      class: 'input input-sm',
      placeholder: _('folders.filterPlaceholder'),
      value: filter,
      oninput: (e) => {
        filter = e.target.value;
        renderFiles();
      },
      onkeydown: (e) => {
        if (e.key === 'Escape') e.target.blur();
        e.stopPropagation();
      },
    });
    clear(
      detailToolbar,
      filterInput,
      statusFilter !== 'all'
        ? h(
            'button',
            {
              class: 'chip',
              title: _('folders.clearStatusFilter'),
              onclick: () => {
                statusFilter = 'all';
                renderDetail();
              },
            },
            h('span', { class: `swatch st-${statusFilter}` }),
            _('folders.onlyStatus', { status: LABEL[statusFilter] }),
            h('span', { class: 'chip-x' }, '×'),
          )
        : null,
      suspectOnly
        ? h('button', { class: 'chip', onclick: () => { suspectOnly = false; renderDetail(); } }, _('folders.suspectOnly'), h('span', { class: 'chip-x' }, '×'))
        : null,
      lowOnly
        ? h(
            'button',
            {
              class: 'chip',
              title: _('folders.clearLowQualityFilter'),
              onclick: () => {
                lowOnly = false;
                renderDetail();
              },
            },
            _('folders.lowQualityOnly'),
            h('span', { class: 'chip-x' }, '×'),
          )
        : null,
      node.children.length
        ? h(
            'label',
            { class: 'check' },
            h('input', {
              type: 'checkbox',
              checked: includeSub,
              onchange: (e) => {
                includeSub = e.target.checked;
                prefs.set('folders.includeSub', includeSub);
                renderDetail();
              },
            }),
            _('folders.includeSubfolders'),
          )
        : null,
    );
    renderFiles();
  }

  function renderFiles() {
    const node = selected();
    if (!node) return;
    const rank = { unsorted: 0, notImported: 1, missing: 2, copy: 3, rejected: 4, classified: 5 };
    const files = subtreeFiles(node).filter((f) => (statusFilter === 'all' || f.status === statusFilter) && (!lowOnly || f.quality?.low || f.quality?.unreadable) && (!suspectOnly || f.quality?.suspect) && fileMatches(f, filter));
    // Work still to do first; within a status, keep the folder order from the tree.
    const order = new Map(files.map((f, i) => [f, i]));
    fileItems = files.slice().sort((a, b) => rank[a.status] - rank[b.status] || order.get(a) - order.get(b));
    vlist.setItems(fileItems, h('div', { class: 'empty' }, filter || lowOnly || suspectOnly || statusFilter !== 'all' ? _('folders.noMatchingFiles') : _('folders.noAudioFiles')));
  }

  // ---------- screening ----------
  const fileIndex = (path) => fileItems.findIndex((f) => f.path === path);
  const currentFile = () => fileItems[fileIndex(selectedFile)] || null;

  function selectFile(path, { scroll = true } = {}) {
    selectedFile = path;
    focusFiles = true;
    vlist.render();
    if (scroll) vlist.scrollToIndex(fileIndex(path));
  }

  function playKey(f) {
    const p = playable(f);
    return p ? player.playId(p) : null;
  }

  const isPlaying = (f) => player.playing && player.current?.key === playKey(f);

  /** After marking a file, move to the next one (and keep playing if the marked one was playing). */
  function advanceFrom(path, nextPath, wasPlaying) {
    const target = fileItems.find((f) => f.path === nextPath) || fileItems[Math.min(fileIndex(path) + 1, fileItems.length - 1)];
    if (!target) return;
    selectFile(target.path);
    if (wasPlaying) {
      const p = playable(target);
      if (p) player.play(p);
    }
  }

  function markReject(f) {
    if (!f) return;
    const next = fileItems[fileIndex(f.path) + 1]?.path;
    const wasPlaying = isPlaying(f);
    if (f.viaPlan) {
      // A merged duplicate stays merged (only its file is kept); a plain reject is undone.
      const merged = store.findOps((op) => op.type === 'removeTrack' && op.deleteFile && op.asset === f.assetId && op.group != null).length;
      if (merged) store.keepFileOf(f.assetId);
      else store.revertOps((op) => op.type === 'removeTrack' && op.deleteFile && op.asset === f.assetId);
      return;
    }
    if (f.status === 'rejected') {
      store.setScreenMark([f.path], null);
      return;
    }
    if (f.status === 'missing') return toast(_('folders.fileMissingHint'));
    if (f.assetId != null) {
      // In Serato: remove it there and trash the file when the plan is applied.
      store.commit({ key: 'common.rejectTrack', params: { track: store.trackLabel(f.assetId) } }, [store.opReject(f.assetId)], { silent: true });
    } else {
      store.setScreenMark([f.path], 'reject');
    }
    advanceFrom(f.path, next, wasPlaying);
  }

  function markKeep(f) {
    if (!f) return;
    if (f.assetId != null || f.status === 'missing') return toast(_('folders.inSeratoHint'));
    const next = fileItems[fileIndex(f.path) + 1]?.path;
    const wasPlaying = isPlaying(f);
    if (f.kept) {
      store.setScreenMark([f.path], null);
      return;
    }
    store.setScreenMark([f.path], 'keep');
    if (f.inSerato) {
      const twin = store.base.tracks.get(f.inSerato[0]);
      toast(_('folders.duplicateWarning', { dir: twin ? fmt.shortPath(dirOf(effectivePath(store.eff, twin))) : '' }), { tone: 'warn', timeout: 7000 });
    }
    advanceFrom(f.path, next, wasPlaying);
  }

  function cratesCell(f) {
    const eff = store.eff;
    if (f.status === 'notImported') {
      if (!f.inSerato) return h('span', { class: 'muted' }, '—');
      const twin = store.base.tracks.get(f.inSerato[0]);
      const ok = f.inSerato.some((id) => isClassified(eff, store.rules, id));
      return h(
        'span',
        { class: 'ellipsis warn-text', title: inSeratoTip(f) },
        _('folders.copyOf', { dir: twin ? fmt.shortPath(dirOf(effectivePath(eff, twin))) : '', status: ok ? _('common.sorted') : _('common.unsorted') }),
      );
    }
    if (f.status === 'rejected')
      return h('span', { class: 'muted' }, f.viaPlan ? _('folders.rejectedViaPlan') : _('folders.rejectedPendingHint'));
    if (f.status === 'copy') {
      const twin = store.base.tracks.get(f.twins[0]);
      const twinPath = twin ? effectivePath(eff, twin) : '';
      const ok = f.twins.some((id) => isClassified(eff, store.rules, id));
      return h('span', { class: 'muted', title: twinPath }, _('folders.copyHint', { dir: fmt.shortPath(dirOf(twinPath)), status: ok ? _('common.sorted') : _('common.unsorted') }));
    }
    const ids = eff.cratesOf.get(f.assetId) || [];
    if (!ids.length) return h('span', { class: 'muted' }, _('common.inNoCrate'));
    const counted = ids.filter((c) => !store.rules.skip.has(c));
    const skipped = ids.filter((c) => store.rules.skip.has(c));
    const all = [...counted, ...skipped].map((c) => eff.pathOf(c));
    return h(
      'span',
      { class: 'ellipsis', title: all.join('\n') },
      counted.length ? h('span', {}, eff.pathOf(counted[0])) : h('span', { class: 'muted' }, eff.pathOf(skipped[0])),
      all.length > 1 ? h('span', { class: 'muted' }, `  +${all.length - 1}`) : null,
    );
  }

  /** Tooltip listing the Serato tracks that look like the same song as file `f`. */
  function inSeratoTip(f) {
    const lines = f.inSerato.map((id) => {
      const t = store.base.tracks.get(id);
      return t ? `${store.trackLabel(id)}\n   ${effectivePath(store.eff, t)}${t.exists ? '' : ` (${_('common.missingFile')})`}` : `#${id}`;
    });
    return `${_('folders.sameNameWarning')}\n${lines.join('\n')}`;
  }

  function playable(f) {
    if (f.status === 'missing') return null;
    if (f.assetId != null) return store.base.tracks.get(f.assetId);
    return { playKey: `f${f.path}`, src: `/api/audio-file?path=${encodeURIComponent(f.path)}`, title: stripExt(f.name), artist: _('common.fileNotInSerato') };
  }

  function renderFile(f) {
    const t = f.assetId != null ? store.base.tracks.get(f.assetId) : null;
    const node = selected();
    const rel = node && f.node !== node ? f.node.path.slice(node.path.length + 1) : '';
    const play = playable(f);
    const key = play ? player.playId(play) : null;
    const title = t ? t.title || stripExt(f.name) : stripExt(f.name);
    const sub = [t ? t.artist : `${fmt.size(f.size)} · ${fmt.date(f.mtime)}`, rel && `📁 ${rel}`].filter(Boolean).join(' · ');
    const canKeep = f.assetId == null && f.status !== 'missing';
    return h(
      'div',
      {
        class: `fileRow is-${f.status} ${f.path === selectedFile ? 'is-selected' : ''} ${f.kept ? 'is-kept' : ''}`,
        onclick: () => selectFile(f.path, { scroll: false }),
        oncontextmenu: (e) => fileMenu(e, f),
        ondblclick: () => play && player.play(play),
      },
      h('span', { class: `swatch st-${f.status}`, title: `${LABEL[f.status]}${_('sep.colon')}${HINT[f.status]}` }),
      play
        ? h(
            'button',
            {
              class: 'icon-btn',
              title: _('common.preview'),
              onclick: (e) => {
                e.stopPropagation();
                selectFile(f.path, { scroll: false });
                player.toggle(play);
              },
            },
            player.isCurrent(key) && player.playing ? '❚❚' : '▶',
          )
        : h('span'),
      h(
        'div',
        { class: 'trow-main' },
        h(
          'div',
          { class: 'trow-title', title: f.path },
          f.assetId != null && store.base.tracks.has(f.assetId) ? noteMark({ track: store.base.tracks.get(f.assetId) }) : noteMark({ path: f.path }),
          title,
          f.sameCopies && f.status !== 'copy' ? h('span', { class: 'tag tag-warn', title: _('folders.identicalFile') }, _('folders.duplicateCount', { n: f.sameCopies + 1 })) : null,
          f.inSerato ? h('span', { class: 'tag tag-warn', title: inSeratoTip(f) }, _('common.alreadyInSerato')) : null,
          plannedTag(f),
        ),
        h('div', { class: 'trow-sub' }, sub),
      ),
      cratesCell(f),
      h('span', { class: 'num' }, qualityBadge(f.quality || store.qualityOf(f.path, t), { compact: true })),
      h(
        'span',
        { class: 'screen-btns' },
        f.status !== 'missing'
          ? h(
              'button',
              {
                class: `screen-btn screen-x ${f.status === 'rejected' ? 'is-on' : ''}`,
                title: f.status === 'rejected' ? _('folders.undoReject') : _('folders.rejectButton'),
                onclick: (e) => {
                  e.stopPropagation();
                  selectFile(f.path, { scroll: false });
                  markReject(f);
                },
              },
              '✕',
            )
          : null,
        canKeep
          ? h(
              'button',
              {
                class: `screen-btn screen-v ${f.kept ? 'is-on' : ''}`,
                title: f.kept ? _('folders.undoKeep') : _('folders.keepButton'),
                onclick: (e) => {
                  e.stopPropagation();
                  selectFile(f.path, { scroll: false });
                  markKeep(f);
                },
              },
              '✓',
            )
          : null,
      ),
    );
  }

  // ---------- actions ----------
  async function reveal(path) {
    try {
      await api.reveal(path);
    } catch (e) {
      toast(_('common.couldNotOpen', { error: e.message }), { tone: 'danger' });
    }
  }

  async function openTrash(files) {
    const groups = new Map();
    for (const f of files) {
      const list = groups.get(f.node.path) || [];
      list.push(f);
      groups.set(f.node.path, list);
    }
    const bytes = files.reduce((n, f) => n + (f.size || 0), 0);
    const ok = await modal({
      title: _n(files.length, 'folders.trashConfirm'),
      wide: true,
      body: h(
        'div',
        { class: 'trash-confirm' },
        h(
          'p',
          {},
          _('folders.trashExplanation', { size: fmt.size(bytes) }),
        ),
        h(
          'div',
          { class: 'list trash-list' },
          [...groups].map(([dir, list]) => [
            h('div', { class: 'trash-dir' }, fmt.shortPath(dir), h('span', { class: 'muted small' }, ` ${_n(list.length, 'folders.files')}`)),
            list.map((f) => h('div', { class: 'trash-file', title: f.path }, f.name, h('span', { class: 'muted small' }, ` ${fmt.size(f.size)}`))),
          ]),
        ),
      ),
      actions: (close) => [
        h('button', { class: 'btn', onclick: () => close(false) }, _('common.cancel')),
        h('button', { class: 'btn btn-danger', onclick: () => close(true) }, _n(files.length, 'folders.trashButton')),
      ],
    });
    if (ok !== true) return;
    try {
      toast(_('folders.trashing'));
      const results = await store.trashFiles(files.map((f) => f.path));
      const done = results.filter((r) => r.ok);
      const failed = results.filter((r) => !r.ok);
      toast(_n(done.length, 'folders.trashed'), { action: () => restore(done.map((r) => r.path)), actionLabel: _('common.restore'), timeout: 10000 });
      if (failed.length) showFailures(_('folders.trashPartial'), failed);
    } catch (e) {
      toast(_('folders.trashFailed', { error: e.message }), { tone: 'danger', timeout: 8000 });
    }
  }

  async function restore(paths) {
    try {
      const results = await store.restoreFiles(paths);
      const failed = results.filter((r) => !r.ok);
      toast(_n(results.length - failed.length, 'folders.restored'));
      if (failed.length) showFailures(_('folders.restorePartial'), failed);
    } catch (e) {
      toast(_('folders.restoreFailed', { error: e.message }), { tone: 'danger', timeout: 8000 });
    }
  }

  function showFailures(title, failed) {
    modal({
      title,
      wide: true,
      body: h('div', { class: 'list trash-list' }, failed.map((r) => h('div', { class: 'trash-file', title: r.path }, fmt.shortPath(r.path), h('div', { class: 'muted small' }, r.error)))),
      actions: (close) => [h('button', { class: 'btn btn-primary', onclick: () => close() }, _('common.ok'))],
    });
  }

  function sortHere(node) {
    prefs.set('inbox.source', { kind: 'folder', path: node.path });
    navigate('inbox');
  }

  // ---------- right-click menus ----------
  function folderMenu(e, node) {
    focusFiles = false;
    select(node.key);
    contextMenu(e, [
      navigate ? { label: _('folders.goSort'), action: () => sortHere(node) } : null,
      node.children.length ? { label: expanded.has(node.key) ? _('common.collapse') : _('common.expand'), action: () => toggle(node.key) } : null,
      ...folderImportItems(node),
      'sep',
      !node.ghost ? { label: _('common.showInFinder'), action: () => reveal(node.path) } : null,
    ]);
  }

  // ---------- adding to Serato ----------
  const allFiles = (node) => [...node.files, ...node.children.flatMap(allFiles)];
  const folderName = (node) => node.path.slice(node.path.lastIndexOf('/') + 1);

  function plannedTag(f) {
    const imp = f.status === 'notImported' ? store.planned(f.path) : null;
    if (!imp) return null;
    const where = imp.crate != null && store.eff.crates.has(imp.crate) ? store.eff.pathOf(imp.crate) : _('folders.libraryOnly');
    return h('span', { class: 'tag tag-new', title: _('folders.importPlanned', { where }) }, _('folders.importingLabel'));
  }

  function addButton(node) {
    const files = (includeSub ? allFiles(node) : node.files).filter(importable);
    const todo = files.filter((f) => !store.planned(f.path));
    const planned = files.length - todo.length;
    if (!files.length) return null;
    return h(
      'div',
      { class: 'fnote-actions' },
      todo.length ? h('button', { class: 'btn btn-sm btn-primary', onclick: () => addToSerato(todo, { folderName: folderName(node) }) }, _n(todo.length, 'folders.importMenu')) : null,
      planned ? h('span', { class: 'muted small' }, _n(planned, 'folders.plannedCount')) : null,
    );
  }

  function folderImportItems(node) {
    if (node.ghost) return [];
    const files = allFiles(node).filter(importable);
    const todo = files.filter((f) => !store.planned(f.path));
    const planned = files.filter((f) => store.planned(f.path));
    return [
      todo.length ? { label: _n(todo.length, 'folders.importNewMenu'), action: () => addToSerato(todo, { folderName: folderName(node) }) } : null,
      planned.length ? { label: _n(planned.length, 'folders.cancelPlannedImport'), action: () => dontAdd(planned.map((f) => f.path)) } : null,
    ];
  }

  function fileMenu(e, f) {
    selectFile(f.path, { scroll: false });
    const p = playable(f);
    const canKeep = f.assetId == null && f.status !== 'missing';
    contextMenu(e, [
      p ? { label: isPlaying(f) ? _('common.pause') : _('common.play'), hint: _('common.space'), action: () => player.toggle(p) } : null,
      p ? { label: _('common.playFromStart'), hint: 'Q', action: () => player.play(p, { at: 0 }) } : null,
      'sep',
      f.status !== 'missing' ? { label: f.status === 'rejected' ? _('folders.undoReject') : _('common.reject'), hint: 'X', danger: f.status !== 'rejected', action: () => markReject(f) } : null,
      canKeep ? { label: f.kept ? _('folders.undoKeep') : _('common.keep'), hint: 'V', action: () => markKeep(f) } : null,
      'sep',
      importable(f)
        ? store.planned(f.path)
          ? { label: _('folders.cancelImport'), action: () => dontAdd([f.path]) }
          : { label: _('common.addToSeratoMenu'), action: () => addToSerato([f], { folderName: f.path.split('/').slice(-2, -1)[0] }) }
        : null,
      f.status !== 'missing' ? { label: _('common.showInFinder'), action: () => reveal(f.path) } : null,
      f.status !== 'missing' && spectrumAvailable() ? { label: _('common.spectrum'), action: () => showSpectrum({ path: f.path, title: f.assetId != null ? store.trackLabel(f.assetId) : stripExt(f.name), quality: f.quality }) } : null,
      f.assetId != null && store.base.tracks.has(f.assetId) ? noteMenuItem({ track: store.base.tracks.get(f.assetId) }) : noteMenuItem({ path: f.path }),
    ]);
  }

  // ---------- keyboard ----------
  function onKey(e) {
    if (e.metaKey || e.ctrlKey || e.altKey) return false;
    if (focusFiles && fileItems.length) {
      const f = currentFile();
      const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
      const move = (d) => {
        const i = fileIndex(selectedFile);
        const next = fileItems[Math.min(fileItems.length - 1, Math.max(0, i < 0 ? 0 : i + d))];
        if (!next) return;
        const wasPlaying = f && isPlaying(f);
        selectFile(next.path);
        if (wasPlaying && playable(next)) player.play(playable(next));
      };
      if (k === 'ArrowDown' || k === 'j') return move(1), true;
      if (k === 'ArrowUp' || k === 'k') return move(-1), true;
      if (k === 'Escape') {
        focusFiles = false;
        return true;
      }
      if (f) {
        const p = playable(f);
        if (k === ' ') {
          if (p) player.toggle(p);
          return true;
        }
        if (k === 'Enter') {
          if (p) player.play(p);
          return true;
        }
        const at = { q: 0, w: 0.25, e: 0.5, r: 0.75 }[k];
        if (at != null && p) {
          player.play(p, { at });
          return true;
        }
        if (k === 'x' || k === 'Delete' || k === 'Backspace') return markReject(f), true;
        if (k === 'v') return markKeep(f), true;
      }
    }
    if (e.key === ' ') {
      player.toggle();
      return true;
    }
    const i = visibleRows.findIndex((n) => n.key === selectedKey);
    const node = visibleRows[i];
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      const next = visibleRows[Math.min(visibleRows.length - 1, Math.max(0, i + (e.key === 'ArrowDown' ? 1 : -1)))];
      if (next) select(next.key, { scroll: true });
      return true;
    }
    if (e.key === 'ArrowRight' && node?.children.length && !expanded.has(node.key)) {
      toggle(node.key);
      return true;
    }
    if (e.key === 'ArrowLeft' && node) {
      if (expanded.has(node.key) && node.children.length) toggle(node.key);
      else if (node.parent) select(node.parent.key, { scroll: true });
      return true;
    }
    return false;
  }

  function render() {
    ensureReport();
    renderSummary();
    renderTreeToolbar();
    renderTree();
    renderDetail();
  }

  if (!store.folderScan) load();
  render();
  requestAnimationFrame(() => treeEl.querySelector('.frow.is-selected')?.scrollIntoView({ block: 'nearest' }));
  return {
    el,
    title: _('tab.folders'),
    update() {
      const scrollTop = treeEl.scrollTop;
      render();
      treeEl.scrollTop = scrollTop;
    },
    onKey,
    destroy() {
      offPlayer();
      vlist.destroy();
    },
  };
}
