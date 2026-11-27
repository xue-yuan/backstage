// Sort view: pick a source (uncategorised / recent / an inbox crate / a disk folder), listen, assign crates fast.
import { createCratePicker, pickCrateDialog } from '../cratePicker.js';
import { addedInPlan, baseName, effectivePath, isClassified, liveTracks, norm, pathKey, suggestCrates, trackMatches } from '../model.js';
import { player } from '../player.js';
import { qualityBadge } from '../quality.js';
import { noteDialog, noteMark, noteMenuItem, noteText, when } from '../notes.js';
import { showSpectrum, spectrumAvailable } from '../spectrogram.js';
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
  let pinned = prefs.get('inbox.pinned', []);
  let collapsed = new Set(prefs.get('inbox.collapsed', []));
  let crateFilter = '';
  const openDone = new Set(); // parents whose finished crates are listed (this visit only)
  // Crate order is fixed while the view is open (biggest backlog first, decided when a crate is first
  // listed), so rows do not jump while you sort and "next crate" walks a stable order.
  const rank = new Map();
  let nextRank = 0;
  let selectedId = null;
  let items = [];
  let suggestions = [];

  // ---------- layout ----------
  const sourcesTop = h('div');
  const crateHead = h('div', { class: 'section-label row-between' });
  const crateFilterInput = h('input', {
    class: 'input input-sm source-filter',
    placeholder: _('Filter crates…'),
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
          const id = await pickCrateDialog({ title: _('Which crate do you want to sort?'), allowCreate: false });
          if (id != null) setSource({ kind: 'crate', id });
        },
      },
      _('Pick another crate…'),
    ),
  );
  const listTitle = h('div', { class: 'list-title' });
  const progress = h('div', { class: 'progress' }, h('div', { class: 'progress-fill' }));
  const progressText = h('span', { class: 'muted small' });
  const nextBtn = h('button', { class: 'btn btn-sm', title: _('Next crate with songs left (N)'), onclick: () => goNextCrate() }, _('Next crate →'));
  const cleanOutBtn = h('button', { class: 'btn btn-sm', onclick: () => cleanOut() });
  const filterInput = h('input', {
    class: 'input input-sm',
    placeholder: _('Filter by title, artist, genre…'),
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
    h('option', { value: 'added' }, _('Newest first')),
    h('option', { value: 'order' }, _('Crate order')),
    h('option', { value: 'bpm' }, 'BPM'),
    h('option', { value: 'artist' }, _('Artist')),
    h('option', { value: 'title' }, _('Title')),
  );
  sortSelect.value = sort;
  const showSelect = h(
    'select',
    {
      class: 'input input-sm',
      title: _('Which songs to list'),
      onchange: (e) => {
        show = e.target.value;
        prefs.set('inbox.show', show);
        e.target.blur(); // give the keyboard shortcuts back
        renderList();
      },
    },
    h('option', { value: 'all' }, _('All songs')),
    h('option', { value: 'todo' }, _('Not sorted yet')),
    h('option', { value: 'done' }, _('Sorted only')),
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
      h('span', {}, _('Title / artist')),
      h('span', { class: 'num' }, 'BPM'),
      h('span', {}, 'Key'),
      h('span', {}, _('Format')),
      h('span', {}, _('Genre')),
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
    placeholder: _('Add to another crate… (/). Type "Parent / New name" to create one'),
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
  const moveOutRow = h('label', { class: 'check' }, moveOutBox, _('Remove from the source crate when adding'));
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
      _('Go to the next song after adding (keeps playing if a song is playing)'),
    ),
    moveOutRow,
    h('div', { class: 'muted small' }, _('X: reject this song (added to the plan; it is removed and its file moved to the Trash only when you apply to Serato)')),
    h('div', { class: 'muted small' }, _('⇧X: only remove it from the Serato library and keep the file (samples, demo tracks, files that belong to other apps)')),
  );
  const detailEl = h(
    'aside',
    { class: 'panel inbox-detail' },
    infoEl,
    currentEl,
    pinnedEl,
    suggestEl,
    h('div', { class: 'detail-section' }, h('div', { class: 'section-label' }, _('Add to another crate')), picker.el),
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

  // Songs of a source. A crate keeps listing songs moved out of it in the plan (shown as sorted).
  function sourceList(src = source) {
    const { base, eff } = store;
    let list;
    if (src.kind === 'uncategorized') {
      list = [...base.tracks.values()].filter((t) => !(base.baseCratesOf.get(t.id) || []).length);
    } else if (src.kind === 'recent') {
      const cutoff = Date.now() / 1000 - src.days * 86400;
      list = [...base.tracks.values()].filter((t) => t.addedAt >= cutoff);
    } else if (src.kind === 'folder') {
      const prefix = `${pathKey(src.path)}/`;
      list = liveTracks(eff).filter((t) => pathKey(effectivePath(eff, t)).startsWith(prefix));
    } else {
      const ids = [...new Set([...(base.members.get(src.id) || []), ...(eff.members.get(src.id) || [])])];
      list = ids.map((id) => base.tracks.get(id)).filter(Boolean);
    }
    return list.filter((t) => !eff.removedTracks.has(t.id));
  }

  function doneIn(src, t) {
    const eff = store.eff;
    // Same rule as the Folders report: a song is done once it sits in a crate that is not unsorted.
    // (Only when reorganising an already-sorted crate does "got another crate / left this one" count.)
    if (src.kind !== 'crate' || store.rules.skip.has(src.id)) return isClassified(eff, store.rules, t.id);
    if (addedInPlan(eff, t.id).some((c) => c !== src.id)) return true;
    return !(eff.members.get(src.id) || []).includes(t.id);
  }
  const isDone = (t) => doneIn(source, t);
  const leftIn = (src) => sourceList(src).filter((t) => !doneIn(src, t)).length;
  const fromUnsorted = () => source.kind === 'crate' && store.rules.skip.has(source.id);
  const moveOutOn = () => (fromUnsorted() ? moveOutInbox : moveOut);

  function sorted(list) {
    const by = {
      added: (a, b) => b.addedAt - a.addedAt || a.id - b.id,
      bpm: (a, b) => (a.bpm || 999) - (b.bpm || 999),
      artist: (a, b) => (a.artist || '￿').localeCompare(b.artist || '￿') || (a.title || '').localeCompare(b.title || ''),
      title: (a, b) => (a.title || a.fileName).localeCompare(b.title || b.fileName),
      order: null,
    }[sort];
    return by ? list.slice().sort(by) : list;
  }

  // Crates whose songs still need sorting (Inbox and everything under it, plus any crate marked unsorted).
  const inboxCrateIds = () => [...store.rules.skip].filter((id) => store.eff.crates.has(id));

  /** The unsorted crates as a tree: { id, total, left, leftIds (whole subtree), children, active, hasActive }. */
  function crateTree() {
    const eff = store.eff;
    const skip = store.rules.skip;
    const build = (id) => {
      const src = { kind: 'crate', id };
      const tracks = sourceList(src);
      const left = tracks.filter((t) => !doneIn(src, t));
      const children = (eff.children.get(id) || []).filter((c) => skip.has(c)).map(build).filter(Boolean);
      const leftIds = new Set(left.map((t) => t.id));
      for (const c of children) for (const a of c.leftIds) leftIds.add(a);
      const active = source.kind === 'crate' && source.id === id;
      const node = { id, total: tracks.length, left: left.length, leftIds, children, active, hasActive: active || children.some((c) => c.hasActive) };
      return node.total || children.length || active ? node : null;
    };
    const roots = inboxCrateIds().filter((id) => !skip.has(eff.crates.get(id).parent));
    return ordered(roots.map(build).filter(Boolean));
  }

  function ordered(nodes) {
    const eff = store.eff;
    const fresh = nodes
      .filter((n) => !rank.has(n.id))
      .sort((a, b) => b.leftIds.size - a.leftIds.size || eff.pathOf(a.id).localeCompare(eff.pathOf(b.id), undefined, { numeric: true }));
    for (const n of fresh) rank.set(n.id, nextRank++);
    for (const n of nodes) n.children = ordered(n.children);
    return nodes.sort((a, b) => rank.get(a.id) - rank.get(b.id));
  }

  /** Crates with songs of their own, in list order (collapsed and finished ones included). */
  function crateOrder(nodes, out = []) {
    for (const n of nodes) {
      if (n.total) out.push(n);
      crateOrder(n.children, out);
    }
    return out;
  }

  /** The next crate after the current one (in list order, wrapping) that still has songs to sort. */
  function nextCrate(tree = crateTree()) {
    const list = crateOrder(tree);
    const i = list.findIndex((n) => n.active);
    for (let k = 1; k <= list.length; k++) {
      const n = list[(i + k) % list.length];
      if (!n.active && n.left) return n;
    }
    return null;
  }

  function goNextCrate() {
    const n = nextCrate();
    if (!n) {
      toast(_('Every unsorted crate is done 🎉'));
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
      { class: `count ${!left && total ? 'count-done' : ''}`, title: _('{left} of {total} left', { left: left.toLocaleString(), total: total.toLocaleString() }) },
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
      h('div', { class: 'section-label' }, _('Source')),
      sourceItem({ kind: 'uncategorized' }, _('In no crate')),
      sourceItem({ kind: 'recent', days: 7 }, _('Added in the last {n} days', { n: 7 })),
      sourceItem({ kind: 'recent', days: 30 }, _('Added in the last {n} days', { n: 30 })),
      source.kind === 'folder'
        ? [h('div', { class: 'section-label' }, _('Sort from a folder')), sourceItem(source, baseName(source.path), { sub: fmt.shortPath(source.path).replace(/\/[^/]*$/, '') })]
        : null,
      navigate
        ? h('button', { class: 'btn btn-ghost btn-block', onclick: () => navigate('folders') }, source.kind === 'folder' ? _('Pick another folder…') : _('Pick from folders…'))
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
      _('Sort from a crate'),
      h('button', { class: 'btn btn-ghost btn-xs', disabled: !next, title: _('Next crate with songs left (N)'), onclick: () => goNextCrate() }, _('Next →')),
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
            h('span', { class: 'source-label' }, h('span', { class: 'source-chev' }, h('span', { class: `chev ${open ? 'is-open' : ''}` })), _n(done.length, '{n} crate done', '{n} crates done')),
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
        : h('div', { class: 'muted small source-empty' }, _('No matching crate'));
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
        ? _('Songs in no crate')
        : source.kind === 'recent'
          ? _('Added in the last {n} days', { n: source.days })
          : source.kind === 'folder'
            ? _('Folder: {name}', { name: baseName(source.path) })
            : eff.pathOf(source.id);
    clear(listTitle, h('h2', {}, title));
    progress.firstChild.style.width = all.length ? `${(doneCount / all.length) * 100}%` : '0%';
    progressText.textContent = _('Sorted {done} / {total}', { done: doneCount, total: all.length });
    moveOutRow.hidden = source.kind !== 'crate';
    moveOutBox.checked = moveOutOn();

    const finished = doneCount === all.length;
    const hasNext = !!nextCrate();
    nextBtn.hidden = !hasNext || (source.kind !== 'crate' && !finished);
    nextBtn.className = `btn btn-sm ${finished ? 'btn-primary' : ''}`;
    const stale = staleInSource();
    cleanOutBtn.hidden = !stale.length;
    cleanOutBtn.textContent = _n(stale.length, 'Take {n} sorted song out of this crate', 'Take {n} sorted songs out of this crate');
    cleanOutBtn.title = _('These songs are already in a sorted crate but still sit in this unsorted one. Removes them from this crate only (added to the plan).');

    const empty = filter
      ? h('div', { class: 'empty' }, _('No songs match the filter'))
      : show === 'done' && all.length
        ? h('div', { class: 'empty' }, _('Nothing sorted here yet'))
        : h('div', { class: 'empty' }, h('p', {}, _('No songs left here 🎉')), hasNext ? h('button', { class: 'btn btn-primary', onclick: () => goNextCrate() }, _('Next crate →')) : null);
    vlist.setItems(items, empty);
  }

  /** Songs of an unsorted source crate that are already sorted elsewhere but still sit in it. */
  function staleInSource() {
    return source.kind === 'crate' ? staleIn(source.id) : [];
  }
  function staleIn(crateId) {
    const eff = store.eff;
    if (!store.rules.skip.has(crateId)) return [];
    return (eff.members.get(crateId) || []).filter((a) => isClassified(eff, store.rules, a));
  }

  function cleanOut(crateId = source.id) {
    const ids = staleIn(crateId);
    if (!ids.length) return;
    const crate = store.eff.pathOf(crateId);
    store.commit(
      _n(ids.length, 'Took {n} sorted song out of {crate}', 'Took {n} sorted songs out of {crate}', { crate }),
      ids.map((a) => store.opRemove(crateId, a)),
    );
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
        h('div', { class: 'trow-title' }, noteMark({ track: t }), t.title || t.fileName, !t.exists ? h('span', { class: 'tag tag-danger' }, _('Missing file')) : null),
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
      clear(infoEl, h('div', { class: 'empty' }, _('Pick a song to start sorting')));
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
        (playBtn = h('button', { class: 'play-big', title: _('Play / pause (Space)'), onclick: () => player.toggle(t) }, player.isCurrent(`t${t.id}`) && player.playing ? '❚❚' : '▶')),
        h('div', {}, h('h3', {}, t.title || t.fileName), h('div', { class: 'muted' }, [t.artist, t.remixer && `Remix: ${t.remixer}`].filter(Boolean).join(' · ') || _('Unknown artist'))),
      ),
      h(
        'dl',
        { class: 'meta' },
        meta('BPM', fmt.bpm(t.bpm)),
        meta('Key', t.key || '–'),
        meta(_('Length'), fmt.duration(t.lengthMs)),
        meta(_('Format'), qualityBadge(store.trackQuality(t))),
        meta(_('Genre'), t.genre || '–'),
        meta(_('Added'), fmt.date(t.addedAt)),
        meta(_('Plays'), t.plays ? _n(t.plays, '{n} time', '{n} times') : _('Never played')),
        meta(_('Album'), t.album || '–'),
      ),
      h(
        'div',
        { class: 'path-row' },
        h('div', { class: 'path', title: t.path }, fmt.shortPath(t.path)),
        t.exists && spectrumAvailable()
          ? h('button', { class: 'btn btn-ghost btn-xs', title: _('Check where the sound stops (spots transcodes such as fake 320k)'), onclick: () => openSpectrum(t) }, _('Spectrum'))
          : null,
      ),
      !t.exists ? h('div', { class: 'notice notice-danger' }, _('This file is not on disk. You can relocate it in Cleanup.')) : null,
      detailNotes(t),
    );

    const crates = eff.cratesOf.get(t.id) || [];
    const gained = new Set(addedInPlan(eff, t.id));
    clear(
      currentEl,
      h('div', { class: 'section-label' }, _n(crates.length, 'Currently in {n} crate', 'Currently in {n} crates')),
      crates.length
        ? h(
            'div',
            { class: 'chips' },
            crates.map((c) =>
              h(
                'span',
                { class: `chip ${gained.has(c) ? 'chip-new' : ''}`, title: gained.has(c) ? _('Newly added (not in Serato yet)') : '' },
                eff.pathOf(c),
                h('button', { class: 'chip-x', title: _('Remove from this crate'), onclick: () => toggleCrate(c) }, '×'),
              ),
            ),
          )
        : h('div', { class: 'muted small' }, _('Not in any crate yet')),
    );

    pinned = pinned.filter((id) => eff.crates.has(id));
    const inSet = new Set(crates);
    clear(
      pinnedEl,
      h(
        'div',
        { class: 'section-label row-between' },
        _('Pinned crates (keys 1–9)'),
        pinned.length < 9 ? h('button', { class: 'btn btn-ghost btn-xs', onclick: addPin }, _('+ Pin')) : null,
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
                  title: _('Unpin'),
                  onclick: (e) => {
                    e.stopPropagation();
                    pinned.splice(i, 1);
                    prefs.set('inbox.pinned', pinned);
                    renderDetail();
                  },
                }, '×'),
              ),
            ),
          )
        : h('div', { class: 'muted small' }, _('Pin the crates you use most here, then add songs with the number keys.')),
    );

    suggestions = suggestCrates(eff, store.profiles, t, { exclude: new Set(inboxCrateIds()) });
    clear(
      suggestEl,
      h('div', { class: 'section-label' }, _('Suggestions (Shift + number)')),
      suggestions.length
        ? h(
            'div',
            { class: 'targets' },
            suggestions.map((s, i) =>
              h(
                'div',
                { class: 'target target-suggest', onclick: () => toggleCrate(s.id, { forceAdd: true }) },
                h('kbd', {}, `⇧${i + 1}`),
                h('span', { class: 'target-name' }, eff.pathOf(s.id), h('span', { class: 'target-why' }, s.reasons.join(_(' · ')))),
                !pinned.includes(s.id) && pinned.length < 9
                  ? h('button', {
                      class: 'target-unpin',
                      title: _('Pin'),
                      onclick: (e) => {
                        e.stopPropagation();
                        pinned.push(s.id);
                        prefs.set('inbox.pinned', pinned);
                        renderDetail();
                      },
                    }, '📌')
                  : null,
              ),
            ),
          )
        : h('div', { class: 'muted small' }, _('No confident suggestions (this song lacks genre, BPM and similar info)')),
    );
  }

  function meta(label, value) {
    return [h('dt', {}, label), h('dd', {}, value)];
  }

  async function addPin() {
    const id = await pickCrateDialog({ title: _('Pin a crate'), exclude: new Set(pinned) });
    if (id == null) return;
    pinned.push(id);
    prefs.set('inbox.pinned', pinned);
    renderDetail();
  }

  // Notes about the song (Notes tab), newest first; M writes a new one.
  function detailNotes(t) {
    const notes = store.notesFor(t);
    return h(
      'div',
      { class: 'detail-notes' },
      notes.slice(0, 3).map((n) => h('div', { class: 'note-mini', ondblclick: () => noteDialog({ track: t }) }, noteText(n.text), h('div', { class: 'muted small' }, when(n.created)))),
      notes.length > 3 ? h('a', { class: 'small', href: '#notes' }, _n(notes.length - 3, '{n} more in Notes →', '{n} more in Notes →')) : null,
      h('button', { class: 'btn btn-ghost btn-xs detail-note-add', title: 'M', onclick: () => noteDialog({ track: t }) }, notes.length ? _('+ Add a note') : _('+ Note about this song')),
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
      { label: player.isCurrent(`t${t.id}`) && player.playing ? _('Pause') : _('Play'), hint: _('Space'), action: () => player.toggle(t) },
      { label: _('Play from the start'), hint: 'Q', action: () => player.play(t, { at: 0 }) },
      'sep',
      {
        label: _('Add to a crate…'),
        hint: '/',
        action: async () => {
          const id = await pickCrateDialog({ title: _('Add "{track}" to…', { track: name }), exclude: new Set(crates) });
          if (id != null) toggleCrate(id, { forceAdd: true });
        },
      },
      ...crates.slice(0, 6).map((c) => ({ label: _('Remove from {crate}', { crate: eff.pathOf(c) }), action: () => toggleCrate(c) })),
      'sep',
      { label: _('Reject'), hint: 'X', danger: true, action: () => rejectSelected() },
      { label: _('Remove from the library, keep the file'), hint: '⇧X', action: () => rejectSelected({ keepFile: true }) },
      'sep',
      noteMenuItem({ track: t, hint: 'M' }),
      spectrumAvailable() ? { label: _('Spectrum'), disabled: !t.exists, action: () => openSpectrum(t) } : null,
      { label: _('Show in Finder'), disabled: !t.exists, action: () => revealInFinder(effectivePath(eff, t)) },
    ]);
  }

  function crateNodeMenu(e, n) {
    const stale = staleIn(n.id);
    contextMenu(e, [
      n.total ? { label: _('Sort this crate'), action: () => setSource({ kind: 'crate', id: n.id }) } : null,
      stale.length ? { label: _n(stale.length, 'Take {n} sorted song out of this crate', 'Take {n} sorted songs out of this crate'), action: () => cleanOut(n.id) } : null,
      n.children.length ? { label: collapsed.has(n.id) ? _('Expand') : _('Collapse'), action: () => toggleCollapsed(n.id) } : null,
      'sep',
      navigate
        ? {
            label: _('Open in Crates'),
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
      const label = _('"{name}" removed from {crate}', { name, crate });
      if (addedInPlan(eff, t.id).includes(crateId)) {
        // Added earlier in this plan: take that back instead of staging an add and a remove.
        const reverted = store.revertAdd(crateId, t.id);
        if (reverted.length) toast(label, { action: () => store.commit(_('"{name}" → {crate}', { name, crate }), reverted, { silent: true }) });
        return;
      }
      store.commit(label, [store.opRemove(crateId, t.id)]);
      return;
    }
    if (inIt) return;
    const leftBefore = source.kind === 'crate' ? leftIn(source) : 0;
    const add = store.opAdd(crateId, t.id);
    if (source.kind === 'crate') add.source = source.id; // where the song was sorted from (for the plan summary)
    const ops = [add];
    const leaveSource = moveOutOn() && source.kind === 'crate' && source.id !== crateId && (eff.members.get(source.id) || []).includes(t.id);
    if (leaveSource) ops.push(store.opRemove(source.id, t.id));
    const change = store.commit(`${_('"{name}" → {crate}', { name, crate })}${leaveSource ? _(' (removed from the source)') : ''}`, ops);
    if (change && autoAdvance) advance();
    if (change) celebrate(leftBefore);
  }

  // When the last song of a crate gets sorted, offer the next crate.
  function celebrate(leftBefore) {
    if (source.kind !== 'crate' || !leftBefore || leftIn(source)) return;
    const next = nextCrate();
    const crate = store.eff.pathOf(source.id);
    toast(_('All of {crate} is sorted 🎉', { crate }), next ? { action: () => goNextCrate(), actionLabel: _('Next: {crate}', { crate: store.eff.crates.get(next.id).name }), timeout: 10000 } : {});
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
    if (!store.commit(keepFile ? _('Remove from the Serato library (file kept): {track}', { track: name }) : _('Reject: {track}', { track: name }), ops)) return;
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
    title: _('Sort'),
    update: renderAll,
    onKey(e) {
      const t = selected();
      const digit = /^Digit([1-9])$/.exec(e.code);
      if (digit && !e.metaKey && !e.ctrlKey && !e.altKey) {
        const n = Number(digit[1]) - 1;
        if (e.shiftKey) {
          if (suggestions[n]) toggleCrate(suggestions[n].id, { forceAdd: true });
        } else if (pinned[n] != null) toggleCrate(pinned[n]);
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
