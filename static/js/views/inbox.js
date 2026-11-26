// Sort view: pick a source (uncategorised / recent / an inbox crate / a disk folder), listen, assign crates fast.
import { createCratePicker, pickCrateDialog } from '../cratePicker.js';
import { addedInPlan, baseName, effectivePath, isClassified, liveTracks, pathKey, suggestCrates, trackMatches } from '../model.js';
import { player } from '../player.js';
import { qualityBadge } from '../quality.js';
import { store } from '../store.js';
import { clear, fmt, h, prefs, VirtualList } from '../ui.js';
import { _, _n } from '../i18n.js';

export function createInboxView({ navigate } = {}) {
  let source = prefs.get('inbox.source', { kind: 'uncategorized' });
  let filter = '';
  let hideDone = prefs.get('inbox.hideDone', false);
  let sort = prefs.get('inbox.sort', 'added');
  let autoAdvance = prefs.get('inbox.autoAdvance', true);
  let moveOut = prefs.get('inbox.moveOut', false);
  let pinned = prefs.get('inbox.pinned', []);
  let selectedId = null;
  let items = [];
  let suggestions = [];

  // ---------- layout ----------
  const sourcesEl = h('aside', { class: 'panel inbox-sources' });
  const listTitle = h('div', { class: 'list-title' });
  const progress = h('div', { class: 'progress' }, h('div', { class: 'progress-fill' }));
  const progressText = h('span', { class: 'muted small' });
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
  const hideDoneBox = h('input', {
    type: 'checkbox',
    checked: hideDone,
    onchange: (e) => {
      hideDone = e.target.checked;
      prefs.set('inbox.hideDone', hideDone);
      renderList();
    },
  });

  const vlist = new VirtualList({ rowHeight: 44, renderRow, className: 'track-list' });
  const listEl = h(
    'section',
    { class: 'panel inbox-list' },
    h('div', { class: 'panel-head' }, listTitle, h('div', { class: 'progress-row' }, progress, progressText)),
    h('div', { class: 'toolbar' }, filterInput, sortSelect, h('label', { class: 'check' }, hideDoneBox, _('Hide sorted'))),
    h(
      'div',
      { class: 'trow trow-head' },
      h('span'),
      h('span', {}, _('Title / artist')),
      h('span', { class: 'num' }, 'BPM'),
      h('span', {}, 'Key'),
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
  const moveOutRow = h(
    'label',
    { class: 'check' },
    h('input', {
      type: 'checkbox',
      checked: moveOut,
      onchange: (e) => {
        moveOut = e.target.checked;
        prefs.set('inbox.moveOut', moveOut);
      },
    }),
    _('Remove from the source crate when adding'),
  );
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

  function sourceList() {
    const { base, eff } = store;
    let list;
    if (source.kind === 'uncategorized') {
      list = [...base.tracks.values()].filter((t) => !(base.baseCratesOf.get(t.id) || []).length);
    } else if (source.kind === 'recent') {
      const cutoff = Date.now() / 1000 - source.days * 86400;
      list = [...base.tracks.values()].filter((t) => t.addedAt >= cutoff);
    } else if (source.kind === 'folder') {
      const prefix = `${pathKey(source.path)}/`;
      list = liveTracks(eff).filter((t) => pathKey(effectivePath(eff, t)).startsWith(prefix));
    } else {
      const ids = [...new Set([...(base.members.get(source.id) || []), ...(eff.members.get(source.id) || [])])];
      list = ids.map((id) => base.tracks.get(id)).filter(Boolean);
    }
    return list.filter((t) => !eff.removedTracks.has(t.id));
  }

  function isDone(t) {
    const eff = store.eff;
    // Same rule as the Folders report: a song is done once it sits in a crate that is not unsorted.
    // (Only when reorganising an already-sorted crate does "got another crate / left this one" count.)
    if (source.kind !== 'crate' || store.rules.skip.has(source.id)) return isClassified(eff, store.rules, t.id);
    const gained = addedInPlan(eff, t.id).filter((c) => !(source.kind === 'crate' && c === source.id));
    if (gained.length) return true;
    if (source.kind === 'crate' && !(eff.members.get(source.id) || []).includes(t.id)) return true;
    return false;
  }

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
  function inboxCrateIds() {
    const eff = store.eff;
    return [...store.rules.skip].filter((id) => eff.crates.has(id)).sort((a, b) => eff.pathOf(a).localeCompare(eff.pathOf(b), undefined, { numeric: true }));
  }

  // ---------- rendering ----------
  function renderSources() {
    const { base, eff } = store;
    const uncategorized = [...base.tracks.values()].filter((t) => !(base.baseCratesOf.get(t.id) || []).length);
    const left = uncategorized.filter((t) => !(eff.cratesOf.get(t.id) || []).length && !eff.removedTracks.has(t.id)).length;
    const now = Date.now() / 1000;
    const recent = (days) => [...base.tracks.values()].filter((t) => t.addedAt >= now - days * 86400).length;
    const inboxCrates = inboxCrateIds().filter((id) => (eff.members.get(id) || []).length || id === source.id);
    if (source.kind === 'crate' && !inboxCrates.includes(source.id) && eff.crates.has(source.id)) inboxCrates.push(source.id);

    const item = (src, label, count, sub) => {
      const active = JSON.stringify(src) === JSON.stringify(source);
      return h(
        'button',
        { class: `source ${active ? 'is-active' : ''}`, title: label, onclick: () => setSource(src) },
        h('span', { class: 'source-label' }, label, sub ? h('span', { class: 'muted small' }, ` ${sub}`) : null),
        h('span', { class: 'count' }, count),
      );
    };
    clear(
      sourcesEl,
      h('div', { class: 'section-label' }, _('Source')),
      item({ kind: 'uncategorized' }, _('In no crate'), uncategorized.length, left !== uncategorized.length ? _('{n} left', { n: left }) : ''),
      item({ kind: 'recent', days: 7 }, _('Added in the last {n} days', { n: 7 }), recent(7)),
      item({ kind: 'recent', days: 30 }, _('Added in the last {n} days', { n: 30 }), recent(30)),
      source.kind === 'folder'
        ? [h('div', { class: 'section-label' }, _('Sort from a folder')), item(source, baseName(source.path), sourceList().length, fmt.shortPath(source.path).replace(/\/[^/]*$/, ''))]
        : null,
      navigate
        ? h('button', { class: 'btn btn-ghost btn-block', onclick: () => navigate('folders') }, source.kind === 'folder' ? _('Pick another folder…') : _('Pick from folders…'))
        : null,
      h('div', { class: 'section-label' }, _('Sort from a crate')),
      inboxCrates.map((id) => item({ kind: 'crate', id }, eff.pathOf(id), (eff.members.get(id) || []).length)),
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
  }

  function setSource(src) {
    source = src;
    prefs.set('inbox.source', source);
    selectedId = null;
    if (src.kind === 'crate' && sort === 'added') sort = 'order';
    if (src.kind !== 'crate' && sort === 'order') sort = 'added';
    sortSelect.value = sort;
    renderAll();
    vlist.el.scrollTop = 0;
  }

  function renderList() {
    const eff = store.eff;
    if (source.kind === 'crate' && !eff.crates.has(source.id)) source = { kind: 'uncategorized' };
    const all = sourceList();
    const doneCount = all.filter(isDone).length;
    items = sorted(all).filter((t) => trackMatches(t, filter) && (!hideDone || !isDone(t) || t.id === selectedId));
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
    vlist.setItems(items, h('div', { class: 'empty' }, filter ? _('No songs match the filter') : _('No songs left here 🎉')));
  }

  function renderRow(t) {
    const done = isDone(t);
    const n = (store.eff.cratesOf.get(t.id) || []).length;
    return h(
      'div',
      {
        class: `trow ${t.id === selectedId ? 'is-selected' : ''} ${done ? 'is-done' : ''}`,
        onclick: () => select(t.id),
        ondblclick: () => player.play(t),
      },
      h('span', { class: 'trow-status' }, player.isCurrent(`t${t.id}`) ? (player.playing ? '♪' : '❚❚') : done ? '✓' : ''),
      h(
        'div',
        { class: 'trow-main' },
        h('div', { class: 'trow-title' }, t.title || t.fileName, !t.exists ? h('span', { class: 'tag tag-danger' }, _('Missing file')) : null),
        h('div', { class: 'trow-sub' }, t.artist || '—'),
      ),
      h('span', { class: 'num' }, fmt.bpm(t.bpm)),
      h('span', {}, t.key || '–'),
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
      h('div', { class: 'path', title: t.path }, fmt.shortPath(t.path)),
      !t.exists ? h('div', { class: 'notice notice-danger' }, _('This file is not on disk. You can relocate it in Cleanup.')) : null,
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

  // ---------- actions ----------
  function toggleCrate(crateId, { forceAdd = false } = {}) {
    const t = selected();
    if (!t) return;
    const eff = store.eff;
    const name = t.title || t.fileName;
    const inIt = (eff.members.get(crateId) || []).includes(t.id);
    if (inIt && !forceAdd) {
      store.commit(_('"{name}" removed from {crate}', { name, crate: eff.pathOf(crateId) }), [store.opRemove(crateId, t.id)]);
      return;
    }
    if (inIt) return;
    const ops = [store.opAdd(crateId, t.id)];
    const leaveSource =
      moveOut && source.kind === 'crate' && source.id !== crateId && (eff.members.get(source.id) || []).includes(t.id);
    if (leaveSource) ops.push(store.opRemove(source.id, t.id));
    const change = store.commit(`${_('"{name}" → {crate}', { name, crate: eff.pathOf(crateId) })}${leaveSource ? _(' (removed from the source)') : ''}`, ops);
    if (change && autoAdvance) advance();
  }

  function advance() {
    const idx = items.findIndex((t) => t.id === selectedId);
    const next = items.slice(idx + 1).find((t) => !isDone(t)) || items[idx + 1];
    if (next) select(next.id);
  }

  // Reject: staged in the plan (remove from Serato + move the file to the Trash when the plan is applied).
  function rejectSelected() {
    const t = selected();
    if (!t) return;
    const idx = items.findIndex((x) => x.id === t.id);
    const next = items.slice(idx + 1).find((x) => !isDone(x)) || items[idx + 1] || items[idx - 1];
    const wasPlaying = player.playing && player.current?.key === `t${t.id}`;
    if (!store.commit(_('Reject: {track}', { track: t.title || t.fileName }), [store.opReject(t.id)])) return;
    if (next) {
      select(next.id);
      if (wasPlaying) player.play(next);
    }
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
        case 'x':
        case 'Delete':
        case 'Backspace':
          rejectSelected();
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
