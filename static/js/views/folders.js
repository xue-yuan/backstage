// Folders view: which folders on disk are already sorted into crates, which still need work.
// Disk files are matched to Serato tracks by path; "classified" follows store.rules.
// Screening: mark files reject (X) / keep (V) while listening. Files Serato does not use can then be
// moved to the macOS Trash (with one-click restore); tracks in Serato are staged in the plan instead.
import { BAR, buildReport, byName, HINT, LABEL, STATUSES } from '../folderReport.js';
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
  const treePanel = h('aside', { class: 'panel ftree-panel' }, h('div', { class: 'panel-head' }, h('h2', {}, _('Folders'))), treeToolbar, treeEl);
  const detailHead = h('div', { class: 'fdetail-head' });
  const detailToolbar = h('div', { class: 'toolbar' });
  const fileHead = h(
    'div',
    { class: 'fileRow fileRow-head' },
    h('span'),
    h('span'),
    h('span', {}, _('Songs')),
    h('span', {}, _('In crates')),
    h('span', { class: 'num' }, _('Format')),
    h('span', { class: 'num', title: _('X reject · V keep') }, _('Screen')),
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
      if (refresh) toast(_('Folders rescanned'));
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
          h('h2', {}, r ? _n(r.sum.files, '{roots}: {n} audio file', '{roots}: {n} audio files', { roots: r.roots.map((x) => x.name).join(_(', ')) }) : _('Folder status')),
          h(
            'span',
            { class: 'muted small' },
            store.folderScan ? _('Scanned at {time} ({s} s) · Scanning only reads; files move only when you press "Move to Trash"', { time: fmt.time(store.folderScan.scannedAt * 1000), s: store.folderScan.seconds }) : '',
          ),
        ),
        h(
          'div',
          { class: 'toolbar' },
          h('button', { class: 'btn btn-sm', onclick: () => editMusicFolders(), title: _('Choose which folders are scanned') }, _('Music folders · {n}', { n: store.folderScan?.roots.length ?? 0 })),
          h('button', { class: 'btn btn-sm', onclick: openUnsortedEditor, title: _('Choose which crates make their songs "Unsorted"') }, _('Unsorted crates · {n}', { n: unsortedCount })),
          h('button', { class: 'btn btn-sm', disabled: loading, onclick: () => load(true) }, loading ? _('Scanning…') : _('↻ Rescan')),
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
              ? h('span', { class: 'muted small' }, _('Reading each file\'s format… {done} / {total}', { done: store.audioProgress.done.toLocaleString(), total: store.audioProgress.total.toLocaleString() }))
              : store.audioProgress?.error
                ? h('span', { class: 'muted small' }, _('Could not read file formats: {error}', { error: store.audioProgress.error }))
                : h('span', { class: 'legend-item', title: _('Low quality: {reasons}', { reasons: LOW_QUALITY_TEXT }) }, h('span', { class: 'qbadge is-low' }, _('Low quality')), h('strong', { class: 'num' }, r.sum.low.toLocaleString())),
            r.sum.suspect ? h('span', { class: 'legend-item', title: _('Suspected transcodes: the sound stops where a lower bit rate cuts it (automatic guess)') }, h('span', { class: 'qbadge-suspect' }, _('Suspect')), h('strong', { class: 'num' }, r.sum.suspect.toLocaleString())) : null,
            store.spectrumProgress?.running ? h('span', { class: 'muted small' }, _('Looking for transcodes… {done} / {total}', { done: store.spectrumProgress.done.toLocaleString(), total: store.spectrumProgress.total.toLocaleString() })) : null,
            r.outsideCount ? h('span', { class: 'muted small', title: _('For example files on ~/Desktop or in the _Serato_ folder') }, _n(r.outsideCount, '{n} more Serato song is outside the scanned folders', '{n} more Serato songs are outside the scanned folders')) : null,
            r.outsideMissing ? h('span', { class: 'muted small' }, _n(r.outsideMissing, '· {n} missing song is outside them', '· {n} missing songs are outside them')) : null,
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
            h('span', {}, _n(files.length, '{n} file marked reject ({size}), not moved to the Trash yet.', '{n} files marked reject ({size}), not moved to the Trash yet.', { size: fmt.size(bytes) })),
            h('button', { class: 'btn btn-sm btn-danger', onclick: () => openTrash(files) }, _('Review and move to Trash…')),
          ]
        : null,
      viaPlan ? h('span', { class: 'muted small', title: _('These songs are in Serato. They must be removed from Serato before their files can go, so they wait in Plan') }, _n(viaPlan, '{n} more song in Serato is marked reject and is handled when you apply to Serato', '{n} more songs in Serato are marked reject and are handled when you apply to Serato')) : null,
      store.lastTrashed.length
        ? h('button', { class: 'btn btn-sm btn-ghost push-right', onclick: () => restore(store.lastTrashed) }, _n(store.lastTrashed.length, '↩ Restore the {n} file just trashed', '↩ Restore the {n} files just trashed'))
        : null,
    );
  }

  // ---------- tree ----------
  function sortedChildren(node) {
    let list = node.children.slice();
    if (hideDone) list = list.filter((c) => !c.done || c.total.missing || c.key === selectedKey);
    return list.sort(sortBy === 'todo' ? (a, b) => b.todo - a.todo || b.total.missing - a.total.missing || byName(a, b) : byName);
  }

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
      h('option', { value: 'name' }, _('By name')),
      h('option', { value: 'todo' }, _('Most to do first')),
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
        _('Hide finished'),
      ),
    );
  }

  function renderTree() {
    if (!report) {
      clear(treeEl, h('div', { class: 'empty' }, loading ? _('Scanning…') : loadError ? _('Scan failed: {error}', { error: loadError }) : ''));
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
        t.missing ? h('span', { class: 'tag tag-danger', title: _n(t.missing, '{n} missing song', '{n} missing songs') }, `✕${t.missing}`) : null,
        node.todo ? h('span', { class: 'todo', title: _('Unsorted {unsorted}, not imported {notImported}', { unsorted: t.unsorted, notImported: t.notImported }) }, node.todo.toLocaleString()) : node.done ? h('span', { class: 'done', title: _('Finished') }, '✓') : null,
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
  function subtreeFiles(node) {
    if (!includeSub) return node.files;
    const out = [];
    const walk = (n) => {
      out.push(...n.files);
      n.children.slice().sort(byName).forEach(walk);
    };
    walk(node);
    return out;
  }

  function fileMatches(f, q) {
    if (!q) return true;
    const t = f.assetId != null ? store.base.tracks.get(f.assetId) : null;
    const hay = `${f.name} ${t?.title || ''} ${t?.artist || ''}`.toLowerCase();
    return q
      .toLowerCase()
      .split(/\s+/)
      .every((w) => hay.includes(w));
  }

  function renderDetail() {
    const node = selected();
    if (!node) {
      clear(detailHead, h('div', { class: 'empty' }, report ? _('Pick a folder on the left') : loading ? _('Scanning…') : loadError ? _('Scan failed: {error}', { error: loadError }) : ''));
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
    if (node.ghost) notes.push(h('div', { class: 'fnote fnote-danger' }, _('This folder no longer exists (it may have been moved or renamed), but Serato still has songs pointing here.')));
    if (t.files && !todo && !t.missing)
      notes.push(h('div', { class: 'fnote fnote-ok' }, _('✓ Finished: every song here is in a sorting crate'), t.copy ? _n(t.copy, ' ({n} more copy; Serato uses the one elsewhere)', ' ({n} more copies; Serato uses the ones elsewhere)') : '', _('.')));
    if (t.unsorted)
      notes.push(
        h(
          'div',
          { class: 'fnote fnote-warn' },
          h('span', {}, _n(t.unsorted, '{n} song is already in Serato but not sorted yet.', '{n} songs are already in Serato but not sorted yet.')),
          h('button', { class: 'btn btn-sm btn-primary', onclick: () => sortHere(node) }, _('Go to Sort →')),
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
            h('strong', {}, _('Screen before importing: {done} / {total} screened', { done: screened.toLocaleString(), total: pool.toLocaleString() })),
            _(' (keep {kept}, reject {rejected})', { kept: t.kept.toLocaleString(), rejected: t.rejected.toLocaleString() }),
            h('br'),
            h('span', { class: 'muted' }, _('Click a song to start: ↑↓ change song, Space play, Q W E R jump to 0/25/50/75%, X reject, V keep. When done, move the rejects to the Trash, then add the rest to Serato (button on the right, or drag this folder into a crate under Inbox in Serato).')),
          ),
          addButton(node),
        ),
      );
    }
    if (crates.length)
      notes.push(
        h('div', { class: 'fnote' }, _('{crates} in Serato came from dragging this whole folder in, so it does not count as sorting. Once its songs are all sorted, you can delete that crate.', { crates: crates.map((name) => _('"{name}"', { name })).join(_(', ')) })),
      );
    if (t.unreadable)
      notes.push(h('div', { class: 'fnote fnote-danger' }, _n(t.unreadable, 'macOS cannot open {n} file. It may be damaged, or its extension may not match its real format. "Low quality only" lists it too; preview it to check.', 'macOS cannot open {n} files. They may be damaged, or their extensions may not match their real format. "Low quality only" lists them too; preview them to check.')));
    if (t.low || t.unreadable)
      notes.push(
        h(
          'div',
          { class: 'fnote fnote-danger' },
          h('span', { title: LOW_QUALITY_TEXT }, t.low ? _n(t.low, '{n} low-quality song ({rule}). AAC 256 and MP3 320 are not low quality.', '{n} low-quality songs ({rule}). AAC 256 and MP3 320 are not low quality.', { rule: LOW_QUALITY_TEXT }) : _('Quality is fine apart from the unreadable files above.')),
          h(
            'button',
            {
              class: `btn btn-sm ${lowOnly ? 'btn-primary' : ''}`,
              onclick: () => {
                lowOnly = !lowOnly;
                renderDetail();
              },
            },
            lowOnly ? _('Show all') : _('Low quality only'),
          ),
        ),
      );
    if (t.suspect)
      notes.push(
        h(
          'div',
          { class: 'fnote fnote-warn' },
          h('span', {}, _n(t.suspect, '{n} file looks like a transcode: its sound stops where a lower bit rate cuts it (for example an MP3 320 made from a 128k file). This is an automatic guess; check the spectrum before deleting.', '{n} files look like transcodes: their sound stops where a lower bit rate cuts it (for example an MP3 320 made from a 128k file). This is an automatic guess; check the spectrum before deleting.')),
          h(
            'button',
            {
              class: `btn btn-sm ${suspectOnly ? 'btn-primary' : ''}`,
              onclick: () => {
                suspectOnly = !suspectOnly;
                renderDetail();
              },
            },
            suspectOnly ? _('Show all') : _('Suspect only'),
          ),
        ),
      );
    if (t.missing)
      notes.push(
        h(
          'div',
          { class: 'fnote fnote-danger' },
          h('span', {}, _n(t.missing, '{n} song in Serato points here, but its file is gone.', '{n} songs in Serato point here, but their files are gone.')),
          h('button', { class: 'btn btn-sm', onclick: () => navigate('cleanup') }, _('Fix in Cleanup →')),
        ),
      );

    clear(
      detailHead,
      h(
        'div',
        { class: 'fdetail-title' },
        h('div', { class: 'grow' }, h('h2', {}, node.name), h('div', { class: 'path', title: node.path }, fmt.shortPath(node.path))),
        !node.ghost ? h('button', { class: 'btn btn-sm', onclick: () => reveal(node.path) }, _('Show in Finder')) : null,
      ),
      h('div', { class: 'fstats' }, STATUSES.map(stat)),
      notes,
    );

    const filterInput = h('input', {
      class: 'input input-sm',
      placeholder: _('Filter by file name, title, artist…'),
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
              title: _('Clear status filter'),
              onclick: () => {
                statusFilter = 'all';
                renderDetail();
              },
            },
            h('span', { class: `swatch st-${statusFilter}` }),
            _('Only {status}', { status: LABEL[statusFilter] }),
            h('span', { class: 'chip-x' }, '×'),
          )
        : null,
      suspectOnly
        ? h('button', { class: 'chip', onclick: () => { suspectOnly = false; renderDetail(); } }, _('Suspect only'), h('span', { class: 'chip-x' }, '×'))
        : null,
      lowOnly
        ? h(
            'button',
            {
              class: 'chip',
              title: _('Clear low-quality filter'),
              onclick: () => {
                lowOnly = false;
                renderDetail();
              },
            },
            _('Low quality only'),
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
            _('Include subfolders'),
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
    vlist.setItems(fileItems, h('div', { class: 'empty' }, filter || lowOnly || suspectOnly || statusFilter !== 'all' ? _('No matching files') : _('This folder has no audio files')));
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
    if (f.status === 'missing') return toast(_('This song\'s file is gone. Fix it in Cleanup'));
    if (f.assetId != null) {
      // In Serato: remove it there and trash the file when the plan is applied.
      store.commit(_('Reject: {track}', { track: store.trackLabel(f.assetId) }), [store.opReject(f.assetId)], { silent: true });
    } else {
      store.setScreenMark([f.path], 'reject');
    }
    advanceFrom(f.path, next, wasPlaying);
  }

  function markKeep(f) {
    if (!f) return;
    if (f.assetId != null || f.status === 'missing') return toast(_('This song is already in Serato. Sort it in Sort'));
    const next = fileItems[fileIndex(f.path) + 1]?.path;
    const wasPlaying = isPlaying(f);
    if (f.kept) {
      store.setScreenMark([f.path], null);
      return;
    }
    store.setScreenMark([f.path], 'keep');
    if (f.inSerato) {
      const twin = store.base.tracks.get(f.inSerato[0]);
      toast(_('Serato already has this song ({dir}). Importing this file too would make a duplicate.', { dir: twin ? fmt.shortPath(dirOf(effectivePath(store.eff, twin))) : '' }), { tone: 'warn', timeout: 7000 });
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
        _('Serato already has it: {dir} ({status})', { dir: twin ? fmt.shortPath(dirOf(effectivePath(eff, twin))) : '', status: ok ? _('Sorted') : _('Unsorted') }),
      );
    }
    if (f.status === 'rejected')
      return h('span', { class: 'muted' }, f.viaPlan ? _('Reject · removed and trashed when you apply to Serato') : _('Reject · not moved to the Trash yet'));
    if (f.status === 'copy') {
      const twin = store.base.tracks.get(f.twins[0]);
      const twinPath = twin ? effectivePath(eff, twin) : '';
      const ok = f.twins.some((id) => isClassified(eff, store.rules, id));
      return h('span', { class: 'muted', title: twinPath }, _('Copy · Serato uses {dir} ({status})', { dir: fmt.shortPath(dirOf(twinPath)), status: ok ? _('Sorted') : _('Unsorted') }));
    }
    const ids = eff.cratesOf.get(f.assetId) || [];
    if (!ids.length) return h('span', { class: 'muted' }, _('In no crate'));
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
      return t ? `${store.trackLabel(id)}\n   ${effectivePath(store.eff, t)}${t.exists ? '' : ` (${_('Missing file')})`}` : `#${id}`;
    });
    return `${_('Serato already has a song with this name. Importing this file too would make a duplicate:')}\n${lines.join('\n')}`;
  }

  function playable(f) {
    if (f.status === 'missing') return null;
    if (f.assetId != null) return store.base.tracks.get(f.assetId);
    return { playKey: `f${f.path}`, src: `/api/audio-file?path=${encodeURIComponent(f.path)}`, title: stripExt(f.name), artist: _('File not in Serato') };
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
      h('span', { class: `swatch st-${f.status}`, title: `${LABEL[f.status]}${_(': ')}${HINT[f.status]}` }),
      play
        ? h(
            'button',
            {
              class: 'icon-btn',
              title: _('Preview'),
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
          f.sameCopies && f.status !== 'copy' ? h('span', { class: 'tag tag-warn', title: _('An identical file exists on disk') }, _('Duplicate ×{n}', { n: f.sameCopies + 1 })) : null,
          f.inSerato ? h('span', { class: 'tag tag-warn', title: inSeratoTip(f) }, _('Already in Serato')) : null,
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
                title: f.status === 'rejected' ? _('Undo reject') : _('Reject (X)'),
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
                title: f.kept ? _('Undo keep') : _('Keep (V)'),
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
      toast(_('Could not open: {error}', { error: e.message }), { tone: 'danger' });
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
      title: _n(files.length, 'Move {n} file to the Trash?', 'Move {n} files to the Trash?'),
      wide: true,
      body: h(
        'div',
        { class: 'trash-confirm' },
        h(
          'p',
          {},
          _('{size} in total. The files go to the Mac Trash and are not deleted directly. Cratify remembers where each file was, so you can restore them with one click until you empty the Trash. None of these files are in Serato, so Serato is not affected.', { size: fmt.size(bytes) }),
        ),
        h(
          'div',
          { class: 'list trash-list' },
          [...groups].map(([dir, list]) => [
            h('div', { class: 'trash-dir' }, fmt.shortPath(dir), h('span', { class: 'muted small' }, ` ${_n(list.length, '{n} file', '{n} files')}`)),
            list.map((f) => h('div', { class: 'trash-file', title: f.path }, f.name, h('span', { class: 'muted small' }, ` ${fmt.size(f.size)}`))),
          ]),
        ),
      ),
      actions: (close) => [
        h('button', { class: 'btn', onclick: () => close(false) }, _('Cancel')),
        h('button', { class: 'btn btn-danger', onclick: () => close(true) }, _n(files.length, 'Move to Trash ({n} file)', 'Move to Trash ({n} files)')),
      ],
    });
    if (ok !== true) return;
    try {
      toast(_('Moving to the Trash…'));
      const results = await store.trashFiles(files.map((f) => f.path));
      const done = results.filter((r) => r.ok);
      const failed = results.filter((r) => !r.ok);
      toast(_n(done.length, 'Moved {n} file to the Trash', 'Moved {n} files to the Trash'), { action: () => restore(done.map((r) => r.path)), actionLabel: _('Restore'), timeout: 10000 });
      if (failed.length) showFailures(_('Some files were not moved'), failed);
    } catch (e) {
      toast(_('Could not move to the Trash: {error}', { error: e.message }), { tone: 'danger', timeout: 8000 });
    }
  }

  async function restore(paths) {
    try {
      const results = await store.restoreFiles(paths);
      const failed = results.filter((r) => !r.ok);
      toast(_n(results.length - failed.length, 'Restored {n} file to its original place', 'Restored {n} files to their original places'));
      if (failed.length) showFailures(_('Some files were not restored'), failed);
    } catch (e) {
      toast(_('Restore failed: {error}', { error: e.message }), { tone: 'danger', timeout: 8000 });
    }
  }

  function showFailures(title, failed) {
    modal({
      title,
      wide: true,
      body: h('div', { class: 'list trash-list' }, failed.map((r) => h('div', { class: 'trash-file', title: r.path }, fmt.shortPath(r.path), h('div', { class: 'muted small' }, r.error)))),
      actions: (close) => [h('button', { class: 'btn btn-primary', onclick: () => close() }, _('Got it'))],
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
      navigate ? { label: _('Go to Sort →'), action: () => sortHere(node) } : null,
      node.children.length ? { label: expanded.has(node.key) ? _('Collapse') : _('Expand'), action: () => toggle(node.key) } : null,
      ...folderImportItems(node),
      'sep',
      !node.ghost ? { label: _('Show in Finder'), action: () => reveal(node.path) } : null,
    ]);
  }

  // ---------- adding to Serato ----------
  const allFiles = (node) => [...node.files, ...node.children.flatMap(allFiles)];
  const folderName = (node) => node.path.slice(node.path.lastIndexOf('/') + 1);

  function plannedTag(f) {
    const imp = f.status === 'notImported' ? store.planned(f.path) : null;
    if (!imp) return null;
    const where = imp.crate != null && store.eff.crates.has(imp.crate) ? store.eff.pathOf(imp.crate) : _('the library, no crate');
    return h('span', { class: 'tag tag-new', title: _('In the plan: added to Serato when the plan is applied ({where})', { where }) }, _('Adding to Serato'));
  }

  function addButton(node) {
    const files = (includeSub ? allFiles(node) : node.files).filter(importable);
    const todo = files.filter((f) => !store.planned(f.path));
    const planned = files.length - todo.length;
    if (!files.length) return null;
    return h(
      'div',
      { class: 'fnote-actions' },
      todo.length ? h('button', { class: 'btn btn-sm btn-primary', onclick: () => addToSerato(todo, { folderName: folderName(node) }) }, _n(todo.length, 'Add {n} song to Serato…', 'Add {n} songs to Serato…')) : null,
      planned ? h('span', { class: 'muted small' }, _n(planned, '{n} in the plan', '{n} in the plan')) : null,
    );
  }

  function folderImportItems(node) {
    if (node.ghost) return [];
    const files = allFiles(node).filter(importable);
    const todo = files.filter((f) => !store.planned(f.path));
    const planned = files.filter((f) => store.planned(f.path));
    return [
      todo.length ? { label: _n(todo.length, 'Add {n} new song to Serato…', 'Add {n} new songs to Serato…'), action: () => addToSerato(todo, { folderName: folderName(node) }) } : null,
      planned.length ? { label: _n(planned.length, 'Do not add the {n} planned song', 'Do not add the {n} planned songs'), action: () => dontAdd(planned.map((f) => f.path)) } : null,
    ];
  }

  function fileMenu(e, f) {
    selectFile(f.path, { scroll: false });
    const p = playable(f);
    const canKeep = f.assetId == null && f.status !== 'missing';
    contextMenu(e, [
      p ? { label: isPlaying(f) ? _('Pause') : _('Play'), hint: _('Space'), action: () => player.toggle(p) } : null,
      p ? { label: _('Play from the start'), hint: 'Q', action: () => player.play(p, { at: 0 }) } : null,
      'sep',
      f.status !== 'missing' ? { label: f.status === 'rejected' ? _('Undo reject') : _('Reject'), hint: 'X', danger: f.status !== 'rejected', action: () => markReject(f) } : null,
      canKeep ? { label: f.kept ? _('Undo keep') : _('Keep'), hint: 'V', action: () => markKeep(f) } : null,
      'sep',
      importable(f)
        ? store.planned(f.path)
          ? { label: _('Do not add to Serato'), action: () => dontAdd([f.path]) }
          : { label: _('Add to Serato…'), action: () => addToSerato([f], { folderName: f.path.split('/').slice(-2, -1)[0] }) }
        : null,
      f.status !== 'missing' ? { label: _('Show in Finder'), action: () => reveal(f.path) } : null,
      f.status !== 'missing' && spectrumAvailable() ? { label: _('Spectrum'), action: () => showSpectrum({ path: f.path, title: f.assetId != null ? store.trackLabel(f.assetId) : stripExt(f.name), quality: f.quality }) } : null,
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
    title: _('Folders'),
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
