// Sort view: pick a source (uncategorised / recent / an inbox crate / a disk folder), listen, assign crates fast.
import { createCratePicker, pickCrateDialog } from '../cratePicker.js';
import { addedInPlan, baseName, effectivePath, norm, suggestCrates, trackMatches } from '../model.js';
import { player } from '../player.js';
import { qualityBadge } from '../quality.js';
import { noteDialog, noteMark, noteMenuItem, noteText, when } from '../notes.js';
import { showSpectrum, spectrumAvailable } from '../spectrogram.js';
import { crateOrder, isDoneIn, nextCrate as nextCrateIn, orderCrateTree, sortSongs, sourceSongs, staleSongs, unsortedCrates, unsortedCrateTree } from '../sortSources.js';
import { store } from '../store.js';
import { clear, contextMenu, fmt, h, prefs, revealInFinder, toast, VirtualList } from '../ui.js';
import { _, _n } from '../i18n.js';

export function createInboxView({ navigate } = {}) {
  let source = prefs.get('inbox.source', { kind: 'uncategorized' });
  let filter = '';
  // 'all' | 'todo' (not sorted yet) | 'done' (sorted only); older versions saved a "hide sorted" checkbox.
  let show = prefs.get('inbox.show', prefs.get('inbox.hideDone', false) ? 'todo' : 'all');
  let sort = prefs.get('inbox.sort', 'added');
  let autoAdvance = prefs.get('inbox.autoAdvance', true);
  let moveOut = prefs.get('inbox.moveOut', false); // sorting from an already-sorted crate
  let moveOutInbox = prefs.get('inbox.moveOutInbox', true); // sorting from an unsorted crate: on, so the Inbox shrinks
  let collapsed = new Set(prefs.get('inbox.collapsed', []));
  let crateFilter = '';
  const openDone = new Set(); // parents whose finished crates are listed (this visit only)
  // Crate order is fixed while the view is open (biggest backlog first, decided when a crate is first
  // listed), so rows do not jump while you sort and "next crate" walks a stable order.
  const rank = { ids: new Map(), next: 0 }; // list position of each unsorted crate, kept while sorting
  let selectedId = null;
  let items = [];
  let suggestions = [];

  // ---------- layout ----------
  const sourcesTop = h('div');
  const crateHead = h('div', { class: 'section-label row-between' });
  const crateFilterInput = h('input', {
    class: 'input input-sm source-filter',
    placeholder: _('common.filterCrates'),
    oninput: (e) => {
      crateFilter = e.target.value;
      renderCrateList();
    },
    onkeydown: (e) => {
      if (e.key === 'Escape') {
        e.target.value = crateFilter = '';
        renderCrateList();
        e.target.blur();
      }
      e.stopPropagation();
    },
  });
  const crateListEl = h('div', { class: 'source-tree' });
  const sourcesEl = h(
    'aside',
    { class: 'panel inbox-sources' },
    sourcesTop,
    crateHead,
    crateFilterInput,
    crateListEl,
    h(
      'button',
      {
        class: 'btn btn-ghost btn-block',
        onclick: async () => {
          const id = await pickCrateDialog({ title: _('sort.chooseCrate'), allowCreate: false });
          if (id != null) setSource({ kind: 'crate', id });
        },
      },
      _('sort.pickAnotherCrate'),
    ),
  );
  const listTitle = h('div', { class: 'list-title' });
  const progress = h('div', { class: 'progress' }, h('div', { class: 'progress-fill' }));
  const progressText = h('span', { class: 'muted small' });
  const nextBtn = h('button', { class: 'btn btn-sm', title: _('sort.nextCrateButton'), onclick: () => goNextCrate() }, _('sort.nextCrate'));
  const cleanOutBtn = h('button', { class: 'btn btn-sm', onclick: () => cleanOut() });
  const filterInput = h('input', {
    class: 'input input-sm',
    placeholder: _('sort.filterPlaceholder'),
    oninput: (e) => {
      filter = e.target.value;
      renderList();
    },
    onkeydown: (e) => {
      if (e.key === 'Escape') e.target.blur();
      e.stopPropagation();
    },
  });
  const sortSelect = h(
    'select',
    {
      class: 'input input-sm',
      onchange: (e) => {
        sort = e.target.value;
        prefs.set('inbox.sort', sort);
        renderList();
      },
    },
    h('option', { value: 'added' }, _('sort.newestFirst')),
    h('option', { value: 'order' }, _('sort.crateOrder')),
    h('option', { value: 'bpm' }, 'BPM'),
    h('option', { value: 'artist' }, _('sort.artist')),
    h('option', { value: 'title' }, _('sort.title')),
  );
  sortSelect.value = sort;
  const showSelect = h(
    'select',
    {
      class: 'input input-sm',
      title: _('sort.listFilter'),
      onchange: (e) => {
        show = e.target.value;
        prefs.set('inbox.show', show);
        e.target.blur(); // give the keyboard shortcuts back
        renderList();
      },
    },
    h('option', { value: 'all' }, _('sort.allSongs')),
    h('option', { value: 'todo' }, _('sort.notSorted')),
    h('option', { value: 'done' }, _('sort.sortedOnly')),
  );
  showSelect.value = show;

  const vlist = new VirtualList({ rowHeight: 44, renderRow, className: 'track-list' });
  const listEl = h(
    'section',
    { class: 'panel inbox-list' },
    h('div', { class: 'panel-head' }, listTitle, h('div', { class: 'progress-row' }, progress, progressText, cleanOutBtn, nextBtn)),
    h('div', { class: 'toolbar' }, filterInput, showSelect, sortSelect),
    h(
      'div',
      { class: 'trow trow-inbox trow-head' },
      h('span'),
      h('span', {}, _('common.titleArtist')),
      h('span', { class: 'num' }, 'BPM'),
      h('span', {}, 'Key'),
      h('span', {}, _('common.format')),
      h('span', {}, _('common.genre')),
      h('span', { class: 'num' }, 'Crates'),
    ),
    vlist.el,
  );

  const infoEl = h('div', { class: 'detail-info' });
  const currentEl = h('div', { class: 'detail-section' });
  const pinnedEl = h('div', { class: 'detail-section' });
  const suggestEl = h('div', { class: 'detail-section' });
  const picker = createCratePicker({
    allowCreate: true,
    placeholder: _('sort.otherCratePlaceholder'),
    activeIds: () => new Set(store.eff.cratesOf.get(selectedId) || []),
    onPick: (id) => toggleCrate(id, { forceAdd: true }),
  });
  // One checkbox, two remembered settings: unsorted sources default to on, sorted crates to off.
  const moveOutBox = h('input', {
    type: 'checkbox',
    onchange: (e) => {
      if (fromUnsorted()) prefs.set('inbox.moveOutInbox', (moveOutInbox = e.target.checked));
      else prefs.set('inbox.moveOut', (moveOut = e.target.checked));
    },
  });
  const moveOutRow = h('label', { class: 'check' }, moveOutBox, _('common.leaveSource'));
  const optionsEl = h(
    'div',
    { class: 'detail-section options' },
    h(
      'label',
      { class: 'check' },
      h('input', {
        type: 'checkbox',
        checked: autoAdvance,
        onchange: (e) => {
          autoAdvance = e.target.checked;
          prefs.set('inbox.autoAdvance', autoAdvance);
        },
      }),
      _('sort.autoAdvance'),
    ),
    moveOutRow,
    h('div', { class: 'muted small' }, _('sort.rejectHint')),
    h('div', { class: 'muted small' }, _('sort.removeKeepHint')),
  );
  const detailEl = h(
    'aside',
    { class: 'panel inbox-detail' },
    infoEl,
    currentEl,
    pinnedEl,
    suggestEl,
    h('div', { class: 'detail-section' }, h('div', { class: 'section-label' }, _('sort.addAnotherCrate')), picker.el),
    optionsEl,
  );

  const el = h('div', { class: 'view inbox' }, sourcesEl, listEl, detailEl);
  let playBtn = null;
  const offPlayer = player.onChange(() => {
    vlist.render();
    if (playBtn) playBtn.textContent = player.isCurrent(`t${selectedId}`) && player.playing ? '❚❚' : '▶';
  });

  // ---------- data ----------
  const selected = () => store.base.tracks.get(selectedId);

  // Data for the lists (sortSources.js), bound to the current source and the view's state.
  const sourceList = (src = source) => sourceSongs(store.base, store.eff, src);
  const doneIn = (src, t) => isDoneIn(store.eff, store.rules, src, t);
  const isDone = (t) => doneIn(source, t);
  const leftIn = (src) => sourceList(src).filter((t) => !doneIn(src, t)).length;
  const fromUnsorted = () => source.kind === 'crate' && store.rules.skip.has(source.id);
  const moveOutOn = () => (fromUnsorted() ? moveOutInbox : moveOut);
  const sorted = (list) => sortSongs(list, sort);
  const inboxCrateIds = () => unsortedCrates(store.eff, store.rules);
  /** The unsorted crates as a tree, kept in a stable order (see orderCrateTree). */
  const crateTree = () => orderCrateTree(unsortedCrateTree(store.base, store.eff, store.rules, source.kind === 'crate' ? source.id : null), store.eff, rank);
  const nextCrate = (tree = crateTree()) => nextCrateIn(tree);

  function goNextCrate() {
    const n = nextCrate();
    if (!n) {
      toast(_('sort.allDone'));
      return;
    }
    setSource({ kind: 'crate', id: n.id });
  }

  function toggleCollapsed(id) {
    if (collapsed.has(id)) collapsed.delete(id);
    else collapsed.add(id);
    prefs.set('inbox.collapsed', [...collapsed]);
    renderCrateList();
  }

  // ---------- rendering ----------
  const leftCount = (left, total) =>
    h(
      'span',
      { class: `count ${!left && total ? 'count-done' : ''}`, title: _('sort.remaining', { left: left.toLocaleString(), total: total.toLocaleString() }) },
      left || !total ? left.toLocaleString() : '✓',
    );

  function sourceItem(src, label, { sub, style } = {}) {
    const list = sourceList(src);
    const left = list.filter((t) => !doneIn(src, t)).length;
    const active = JSON.stringify(src) === JSON.stringify(source);
    return h(
      'button',
      { class: `source ${active ? 'is-active' : ''}`, title: label, style, onclick: () => setSource(src) },
      h('span', { class: 'source-label' }, label, sub ? h('span', { class: 'muted small' }, ` ${sub}`) : null),
      leftCount(left, list.length),
    );
  }

  function renderSources() {
    clear(
      sourcesTop,
      h('div', { class: 'section-label' }, _('sort.source')),
      sourceItem({ kind: 'uncategorized' }, _('common.inNoCrate')),
      sourceItem({ kind: 'recent', days: 7 }, _('common.recentlyAdded', { n: 7 })),
      sourceItem({ kind: 'recent', days: 30 }, _('common.recentlyAdded', { n: 30 })),
      source.kind === 'folder'
        ? [h('div', { class: 'section-label' }, _('sort.sortFromFolder')), sourceItem(source, baseName(source.path), { sub: fmt.shortPath(source.path).replace(/\/[^/]*$/, '') })]
        : null,
      navigate
        ? h('button', { class: 'btn btn-ghost btn-block', onclick: () => navigate('folders') }, source.kind === 'folder' ? _('sort.pickAnotherFolder') : _('sort.pickFromFolders'))
        : null,
    );
    renderCrateList();
  }

  function renderCrateList() {
    const eff = store.eff;
    const tree = crateTree();
    const next = nextCrate(tree);
    clear(
      crateHead,
      _('common.sortFromCrate'),
      h('button', { class: 'btn btn-ghost btn-xs', disabled: !next, title: _('sort.nextCrateButton'), onclick: () => goNextCrate() }, _('sort.next')),
    );
    const all = crateOrder(tree);
    crateFilterInput.hidden = all.length < 8 && !crateFilter;

    const node = (n, depth) => {
      const kids = n.children.length > 0;
      const open = kids && !collapsed.has(n.id);
      return [
        h(
          'button',
          {
            class: `source ${n.active ? 'is-active' : ''}`,
            style: { paddingLeft: `${8 + depth * 14}px` },
            title: eff.pathOf(n.id),
            onclick: () => (n.total ? setSource({ kind: 'crate', id: n.id }) : toggleCollapsed(n.id)),
            oncontextmenu: (e) => crateNodeMenu(e, n),
          },
          h(
            'span',
            { class: 'source-label' },
            h(
              'span',
              {
                class: `source-chev ${kids ? '' : 'is-leaf'}`,
                onclick: (e) => {
                  if (!kids) return;
                  e.stopPropagation();
                  toggleCollapsed(n.id);
                },
              },
              kids ? h('span', { class: `chev ${open ? 'is-open' : ''}` }) : null,
            ),
            eff.crates.get(n.id).name,
          ),
          leftCount(n.leftIds.size, n.total),
        ),
        open ? level(n.children, n.id, depth + 1) : null,
      ];
    };
    // Crates with songs left first; finished ones fold into one "N done" row per level.
    const level = (nodes, parentKey, depth) => {
      const done = nodes.filter((n) => !n.leftIds.size && !n.hasActive);
      const out = nodes.filter((n) => !done.includes(n)).map((n) => node(n, depth));
      if (done.length) {
        const open = openDone.has(parentKey);
        out.push(
          h(
            'button',
            {
              class: 'source source-done',
              style: { paddingLeft: `${8 + depth * 14}px` },
              onclick: () => {
                if (open) openDone.delete(parentKey);
                else openDone.add(parentKey);
                renderCrateList();
              },
            },
            h('span', { class: 'source-label' }, h('span', { class: 'source-chev' }, h('span', { class: `chev ${open ? 'is-open' : ''}` })), _n(done.length, 'sort.cratesDone')),
          ),
          open ? done.map((n) => node(n, depth)) : null,
        );
      }
      return out;
    };

    let body;
    if (crateFilter.trim()) {
      const words = norm(crateFilter).split(' ').filter(Boolean);
      const hits = all.filter((n) => words.every((w) => norm(eff.pathOf(n.id)).includes(w)));
      body = hits.length
        ? hits.map((n) => sourceItem({ kind: 'crate', id: n.id }, eff.pathOf(n.id)))
        : h('div', { class: 'muted small source-empty' }, _('common.noMatchingCrate'));
    } else {
      body = level(tree, 'root', 0);
    }
    // A sorted crate picked with "Pick another crate…" is listed on its own.
    const other = source.kind === 'crate' && !store.rules.skip.has(source.id) && eff.crates.has(source.id) ? sourceItem(source, eff.pathOf(source.id)) : null;
    clear(crateListEl, body, other);
  }

  function setSource(src) {
    source = src;
    prefs.set('inbox.source', source);
    if (src.kind === 'crate' && store.eff.crates.has(src.id)) {
      // Show the new source: open the crates it sits in (you can fold them again afterwards).
      for (let p = store.eff.crates.get(src.id).parent; store.eff.crates.has(p); p = store.eff.crates.get(p).parent) collapsed.delete(p);
      prefs.set('inbox.collapsed', [...collapsed]);
    }
    selectedId = null;
    if (src.kind === 'crate' && sort === 'added') sort = 'order';
    if (src.kind !== 'crate' && sort === 'order') sort = 'added';
    sortSelect.value = sort;
    renderAll();
    vlist.el.scrollTop = 0;
    requestAnimationFrame(() => sourcesEl.querySelector('.source.is-active')?.scrollIntoView({ block: 'nearest' }));
  }

  function renderList() {
    const eff = store.eff;
    if (source.kind === 'crate' && !eff.crates.has(source.id)) source = { kind: 'uncategorized' };
    const all = sourceList();
    const doneCount = all.filter(isDone).length;
    // The selected song stays listed until you move on, so it does not vanish right after you sort it.
    const shown = (t) => show === 'all' || t.id === selectedId || (show === 'done') === isDone(t);
    items = sorted(all).filter((t) => trackMatches(t, filter) && shown(t));
    if (selectedId == null || !items.some((t) => t.id === selectedId)) selectedId = items.find((t) => !isDone(t))?.id ?? items[0]?.id ?? null;

    const title =
      source.kind === 'uncategorized'
        ? _('sort.songsInNoCrate')
        : source.kind === 'recent'
          ? _('common.recentlyAdded', { n: source.days })
          : source.kind === 'folder'
            ? _('sort.folderTitle', { name: baseName(source.path) })
            : eff.pathOf(source.id);
    clear(listTitle, h('h2', {}, title));
    progress.firstChild.style.width = all.length ? `${(doneCount / all.length) * 100}%` : '0%';
    progressText.textContent = _('sort.progress', { done: doneCount, total: all.length });
    moveOutRow.hidden = source.kind !== 'crate';
    moveOutBox.checked = moveOutOn();

    const finished = doneCount === all.length;
    const hasNext = !!nextCrate();
    nextBtn.hidden = !hasNext || (source.kind !== 'crate' && !finished);
    nextBtn.className = `btn btn-sm ${finished ? 'btn-primary' : ''}`;
    const stale = staleInSource();
    cleanOutBtn.hidden = !stale.length;
    cleanOutBtn.textContent = _n(stale.length, 'common.removeSorted');
    cleanOutBtn.title = _('sort.removeSortedHint');

    const empty = filter
      ? h('div', { class: 'empty' }, _('sort.noSongsMatchFilter'))
      : show === 'done' && all.length
        ? h('div', { class: 'empty' }, _('sort.noneSorted'))
        : h('div', { class: 'empty' }, h('p', {}, _('sort.noSongsLeft')), hasNext ? h('button', { class: 'btn btn-primary', onclick: () => goNextCrate() }, _('sort.nextCrate')) : null);
    vlist.setItems(items, empty);
  }

  /** Songs of an unsorted source crate that are already sorted elsewhere but still sit in it. */
  function staleInSource() {
    return source.kind === 'crate' ? staleIn(source.id) : [];
  }
  const staleIn = (crateId) => staleSongs(store.eff, store.rules, crateId);

  function cleanOut(crateId = source.id) {
    const ids = staleIn(crateId);
    if (!ids.length) return;
    const crate = store.eff.pathOf(crateId);
    store.commit({ key: 'sort.removedSorted', n: ids.length, params: { crate } }, ids.map((a) => store.opRemove(crateId, a)));
  }

  function renderRow(t) {
    const done = isDone(t);
    const n = (store.eff.cratesOf.get(t.id) || []).length;
    return h(
      'div',
      {
        class: `trow trow-inbox ${t.id === selectedId ? 'is-selected' : ''} ${done ? 'is-done' : ''}`,
        onclick: () => select(t.id),
        oncontextmenu: (e) => songMenu(e, t),
        ondblclick: () => player.play(t),
      },
      h('span', { class: 'trow-status' }, player.isCurrent(`t${t.id}`) ? (player.playing ? '♪' : '❚❚') : done ? '✓' : ''),
      h(
        'div',
        { class: 'trow-main' },
        h('div', { class: 'trow-title' }, noteMark({ track: t }), t.title || t.fileName, !t.exists ? h('span', { class: 'tag tag-danger' }, _('common.missingFile')) : null),
        h('div', { class: 'trow-sub' }, t.artist || '—'),
      ),
      h('span', { class: 'num' }, fmt.bpm(t.bpm)),
      h('span', {}, t.key || '–'),
      h('span', { class: 'ellipsis' }, qualityBadge(store.trackQuality(t), { compact: true })),
      h('span', { class: 'ellipsis muted' }, t.genre || ''),
      h('span', { class: 'num' }, n ? h('span', { class: 'pill' }, n) : h('span', { class: 'muted' }, '0')),
    );
  }

  function select(id, { scroll = true } = {}) {
    const wasPlaying = player.playing && player.current?.key === `t${selectedId}`;
    selectedId = id;
    vlist.render();
    if (scroll) vlist.scrollToIndex(items.findIndex((t) => t.id === id));
    renderDetail();
    if (wasPlaying && id != null) player.play(selected());
  }

  function renderDetail() {
    const t = selected();
    const eff = store.eff;
    detailEl.classList.toggle('is-empty', !t);
    if (!t) {
      clear(infoEl, h('div', { class: 'empty' }, _('sort.pickSong')));
      clear(currentEl);
      clear(pinnedEl);
      clear(suggestEl);
      return;
    }
    clear(
      infoEl,
      h(
        'div',
        { class: 'detail-head' },
        (playBtn = h('button', { class: 'play-big', title: _('common.playPauseSpace'), onclick: () => player.toggle(t) }, player.isCurrent(`t${t.id}`) && player.playing ? '❚❚' : '▶')),
        h('div', {}, h('h3', {}, t.title || t.fileName), h('div', { class: 'muted' }, [t.artist, t.remixer && `Remix: ${t.remixer}`].filter(Boolean).join(' · ') || _('sort.unknownArtist'))),
      ),
      h(
        'dl',
        { class: 'meta' },
        meta('BPM', fmt.bpm(t.bpm)),
        meta('Key', t.key || '–'),
        meta(_('sort.length'), fmt.duration(t.lengthMs)),
        meta(_('common.format'), qualityBadge(store.trackQuality(t))),
        meta(_('common.genre'), t.genre || '–'),
        meta(_('sort.added'), fmt.date(t.addedAt)),
        meta(_('sort.plays'), t.plays ? _n(t.plays, 'sort.times') : _('sort.neverPlayed')),
        meta(_('sort.album'), t.album || '–'),
      ),
      h(
        'div',
        { class: 'path-row' },
        h('div', { class: 'path', title: t.path }, fmt.shortPath(t.path)),
        t.exists && spectrumAvailable()
          ? h('button', { class: 'btn btn-ghost btn-xs', title: _('common.spectrumHint'), onclick: () => openSpectrum(t) }, _('common.spectrum'))
          : null,
      ),
      !t.exists ? h('div', { class: 'notice notice-danger' }, _('sort.fileMissing')) : null,
      detailNotes(t),
    );

    const crates = eff.cratesOf.get(t.id) || [];
    const gained = new Set(addedInPlan(eff, t.id));
    clear(
      currentEl,
      h('div', { class: 'section-label' }, _n(crates.length, 'sort.currentlyInCrates')),
      crates.length
        ? h(
            'div',
            { class: 'chips' },
            crates.map((c) =>
              h(
                'span',
                { class: `chip ${gained.has(c) ? 'chip-new' : ''}`, title: gained.has(c) ? _('sort.newlyAddedHint') : '' },
                eff.pathOf(c),
                h('button', { class: 'chip-x', title: _('common.removeFromThisCrate'), onclick: () => toggleCrate(c) }, '×'),
              ),
            ),
          )
        : h('div', { class: 'muted small' }, _('sort.noCrates')),
    );

    const pinned = store.pinnedCrates.filter((id) => eff.crates.has(id));
    const inSet = new Set(crates);
    clear(
      pinnedEl,
      h(
        'div',
        { class: 'section-label row-between' },
        _('sort.pinnedTitle'),
        pinned.length < 9 ? h('button', { class: 'btn btn-ghost btn-xs', onclick: addPin }, _('common.pinButton')) : null,
      ),
      pinned.length
        ? h(
            'div',
            { class: 'targets' },
            pinned.map((id, i) =>
              h(
                'div',
                { class: `target ${inSet.has(id) ? 'is-on' : ''}`, onclick: () => toggleCrate(id) },
                h('kbd', {}, i + 1),
                h('span', { class: 'target-name' }, eff.pathOf(id)),
                h('button', {
                  class: 'target-unpin',
                  title: _('sort.unpin'),
                  onclick: (e) => {
                    e.stopPropagation();
                    store.setPinnedCrates(pinned.filter((_id, j) => j !== i));
                  },
                }, '×'),
              ),
            ),
          )
        : h('div', { class: 'muted small' }, _('sort.pinHint')),
    );

    suggestions = suggestCrates(eff, store.profiles, t, { exclude: new Set(inboxCrateIds()) });
    clear(
      suggestEl,
      h('div', { class: 'section-label' }, _('sort.suggestionsTitle')),
      suggestions.length
        ? h(
            'div',
            { class: 'targets' },
            suggestions.map((s, i) =>
              h(
                'div',
                { class: 'target target-suggest', onclick: () => toggleCrate(s.id, { forceAdd: true }) },
                h('kbd', {}, `⇧${i + 1}`),
                h('span', { class: 'target-name' }, eff.pathOf(s.id), h('span', { class: 'target-why' }, s.reasons.join(_('sep.dot')))),
                !pinned.includes(s.id) && pinned.length < 9
                  ? h('button', {
                      class: 'target-unpin',
                      title: _('sort.pin'),
                      onclick: (e) => {
                        e.stopPropagation();
                        store.setPinnedCrates([...pinned, s.id]);
                      },
                    }, '📌')
                  : null,
              ),
            ),
          )
        : h('div', { class: 'muted small' }, _('sort.noSuggestions')),
    );
  }

  function meta(label, value) {
    return [h('dt', {}, label), h('dd', {}, value)];
  }

  async function addPin() {
    const id = await pickCrateDialog({ title: _('sort.pinCrate'), exclude: new Set(store.pinnedCrates) });
    if (id == null) return;
    store.setPinnedCrates([...store.pinnedCrates, id]);
  }

  // Notes about the song (Notes tab), newest first; M writes a new one.
  function detailNotes(t) {
    const notes = store.notesFor(t);
    return h(
      'div',
      { class: 'detail-notes' },
      notes.slice(0, 3).map((n) => h('div', { class: 'note-mini', ondblclick: () => noteDialog({ track: t }) }, noteText(n.text), h('div', { class: 'muted small' }, when(n.created)))),
      notes.length > 3 ? h('a', { class: 'small', href: '#notes' }, _n(notes.length - 3, 'common.moreInNotes')) : null,
      h('button', { class: 'btn btn-ghost btn-xs detail-note-add', title: 'M', onclick: () => noteDialog({ track: t }) }, notes.length ? _('sort.addNote') : _('sort.noteAboutSong')),
    );
  }

  // ---------- right-click menus ----------
  const openSpectrum = (t) => showSpectrum({ path: effectivePath(store.eff, t), title: t.title || t.fileName, quality: store.trackQuality(t) });

  function songMenu(e, t) {
    if (t.id !== selectedId) select(t.id, { scroll: false });
    const eff = store.eff;
    const crates = eff.cratesOf.get(t.id) || [];
    const name = t.title || t.fileName;
    contextMenu(e, [
      { label: player.isCurrent(`t${t.id}`) && player.playing ? _('common.pause') : _('common.play'), hint: _('common.space'), action: () => player.toggle(t) },
      { label: _('common.playFromStart'), hint: 'Q', action: () => player.play(t, { at: 0 }) },
      'sep',
      {
        label: _('sort.addToCrateMenu'),
        hint: '/',
        action: async () => {
          const id = await pickCrateDialog({ title: _('sort.addTrackTitle', { track: name }), exclude: new Set(crates) });
          if (id != null) toggleCrate(id, { forceAdd: true });
        },
      },
      ...crates.slice(0, 6).map((c) => ({ label: _('sort.removeFromCrate', { crate: eff.pathOf(c) }), action: () => toggleCrate(c) })),
      'sep',
      { label: _('common.reject'), hint: 'X', danger: true, action: () => rejectSelected() },
      { label: _('common.removeKeepFile'), hint: '⇧X', action: () => rejectSelected({ keepFile: true }) },
      'sep',
      noteMenuItem({ track: t, hint: 'M' }),
      spectrumAvailable() ? { label: _('common.spectrum'), disabled: !t.exists, action: () => openSpectrum(t) } : null,
      { label: _('common.showInFinder'), disabled: !t.exists, action: () => revealInFinder(effectivePath(eff, t)) },
    ]);
  }

  function crateNodeMenu(e, n) {
    const stale = staleIn(n.id);
    contextMenu(e, [
      n.total ? { label: _('sort.sortCrate'), action: () => setSource({ kind: 'crate', id: n.id }) } : null,
      stale.length ? { label: _n(stale.length, 'common.removeSorted'), action: () => cleanOut(n.id) } : null,
      n.children.length ? { label: collapsed.has(n.id) ? _('common.expand') : _('common.collapse'), action: () => toggleCollapsed(n.id) } : null,
      'sep',
      navigate
        ? {
            label: _('sort.openInCrates'),
            action: () => {
              prefs.set('tree.selected', n.id);
              navigate('structure');
            },
          }
        : null,
    ]);
  }

  // ---------- actions ----------
  function toggleCrate(crateId, { forceAdd = false } = {}) {
    const t = selected();
    if (!t) return;
    const eff = store.eff;
    const name = t.title || t.fileName;
    const crate = eff.pathOf(crateId);
    const inIt = (eff.members.get(crateId) || []).includes(t.id);
    if (inIt && !forceAdd) {
      const title = { key: 'sort.removedFrom', params: { name, crate } };
      if (addedInPlan(eff, t.id).includes(crateId)) {
        // Added earlier in this plan: take that back instead of staging an add and a remove.
        const reverted = store.revertAdd(crateId, t.id);
        if (reverted.length) toast(_(title.key, title.params), { action: () => store.commit({ key: 'sort.addedTo', params: { name, crate } }, reverted, { silent: true }) });
        return;
      }
      store.commit(title, [store.opRemove(crateId, t.id)]);
      return;
    }
    if (inIt) return;
    const leftBefore = source.kind === 'crate' ? leftIn(source) : 0;
    const add = store.opAdd(crateId, t.id);
    if (source.kind === 'crate') add.source = source.id; // where the song was sorted from (for the plan summary)
    const ops = [add];
    const leaveSource = moveOutOn() && source.kind === 'crate' && source.id !== crateId && (eff.members.get(source.id) || []).includes(t.id);
    if (leaveSource) ops.push(store.opRemove(source.id, t.id));
    const change = store.commit({ key: 'sort.addedTo', params: { name, crate }, extra: leaveSource ? [{ key: 'sort.removedFromSource' }] : [] }, ops);
    if (change && autoAdvance) advance();
    if (change) celebrate(leftBefore);
  }

  // When the last song of a crate gets sorted, offer the next crate.
  function celebrate(leftBefore) {
    if (source.kind !== 'crate' || !leftBefore || leftIn(source)) return;
    const next = nextCrate();
    const crate = store.eff.pathOf(source.id);
    toast(_('sort.allSorted', { crate }), next ? { action: () => goNextCrate(), actionLabel: _('sort.nextCrateNamed', { crate: store.eff.crates.get(next.id).name }), timeout: 10000 } : {});
  }

  function advance() {
    const idx = items.findIndex((t) => t.id === selectedId);
    const next = items.slice(idx + 1).find((t) => !isDone(t)) || items[idx + 1];
    if (next) select(next.id);
  }

  // Reject: staged in the plan (remove from Serato + move the file to the Trash when the plan is applied).
  // keepFile (⇧X): only remove it from the library, e.g. samples and demo tracks that belong to other apps.
  function rejectSelected({ keepFile = false } = {}) {
    const t = selected();
    if (!t) return;
    const idx = items.findIndex((x) => x.id === t.id);
    const next = items.slice(idx + 1).find((x) => !isDone(x)) || items[idx + 1] || items[idx - 1];
    const wasPlaying = player.playing && player.current?.key === `t${t.id}`;
    const leftBefore = source.kind === 'crate' ? leftIn(source) : 0;
    const name = t.title || t.fileName;
    const ops = keepFile ? [store.opRemoveTrack(t.id, '')] : [store.opReject(t.id)];
    if (!store.commit({ key: keepFile ? 'op.removeTrack' : 'common.rejectTrack', params: { track: name } }, ops)) return;
    if (next) {
      select(next.id);
      if (wasPlaying) player.play(next);
    }
    celebrate(leftBefore);
  }

  function move(delta) {
    const idx = items.findIndex((t) => t.id === selectedId);
    const next = items[Math.min(items.length - 1, Math.max(0, idx + delta))];
    if (next) select(next.id);
  }

  function renderAll() {
    renderSources();
    renderList();
    renderDetail();
  }

  renderAll();

  return {
    el,
    title: _('tab.sort'),
    update: renderAll,
    onKey(e) {
      const t = selected();
      const digit = /^Digit([1-9])$/.exec(e.code);
      if (digit && !e.metaKey && !e.ctrlKey && !e.altKey) {
        const n = Number(digit[1]) - 1;
        if (e.shiftKey) {
          if (suggestions[n]) toggleCrate(suggestions[n].id, { forceAdd: true });
        } else {
          const pinned = store.pinnedCrates.filter((id) => store.eff.crates.has(id)); // as listed in the panel
          if (pinned[n] != null) toggleCrate(pinned[n]);
        }
        return true;
      }
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
          if (t) player.toggle(t);
          return true;
        case 'ArrowRight':
          player.seekBy(e.shiftKey ? 30 : 10);
          return true;
        case 'ArrowLeft':
          player.seekBy(e.shiftKey ? -30 : -10);
          return true;
        case 'q':
        case 'w':
        case 'e':
        case 'r':
          if (t) player.play(t, { at: { q: 0, w: 0.25, e: 0.5, r: 0.75 }[e.key] });
          return true;
        case '/':
          picker.focus();
          return true;
        case 'n':
          goNextCrate();
          return true;
        case 'm':
          if (t) noteDialog({ track: t });
          return true;
        case 'x':
        case 'Delete':
        case 'Backspace':
          rejectSelected();
          return true;
        case 'X':
          rejectSelected({ keepFile: true });
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
