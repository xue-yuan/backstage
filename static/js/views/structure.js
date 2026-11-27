// Crates view: tree editing (rename / move / merge / delete / create) + per-crate track management.
import { createCratePicker, pickCrateDialog } from '../cratePicker.js';
import { effectivePath, norm, subtreeIds } from '../model.js';
import { player } from '../player.js';
import { qualityBadge } from '../quality.js';
import { noteMark, noteMenuItem } from '../notes.js';
import { showSpectrum, spectrumAvailable } from '../spectrogram.js';
import { parseId, store } from '../store.js';
import { openUnsortedEditor, unsortedReason } from '../unsorted.js';
import { clear, confirmDialog, contextMenu, fmt, h, modal, prefs, promptDialog, revealInFinder, toast, VirtualList } from '../ui.js';
import { _, _n } from '../i18n.js';

let dragging = null; // { kind: 'crate', id } | { kind: 'tracks', ids, from }

export function createStructureView({ navigate } = {}) {
  let selected = prefs.get('tree.selected', null);
  let expanded = new Set(prefs.get('tree.expanded', []));
  let treeFilter = '';
  let visible = []; // flattened visible tree rows: { id, depth }
  let focusArea = 'tree';
  let tracks = [];
  const selTracks = new Set();
  let anchor = -1;

  // ---------- layout ----------
  const treeFilterInput = h('input', {
    class: 'input input-sm',
    placeholder: _('Filter crates…'),
    oninput: (e) => {
      treeFilter = e.target.value;
      renderTree();
    },
    onkeydown: (e) => {
      if (e.key === 'Escape') e.target.blur();
      e.stopPropagation();
    },
  });
  const treeEl = h('div', { class: 'tree', onmousedown: () => (focusArea = 'tree') });
  const rootDrop = h('div', { class: 'tree-rootdrop' }, _('Drop here → move to the top level'));
  wireDrop(rootDrop, () => store.eff.rootId);
  const treePanel = h(
    'aside',
    { class: 'panel tree-panel' },
    h(
      'div',
      { class: 'toolbar' },
      treeFilterInput,
      h('button', { class: 'btn btn-sm', onclick: () => createCrate(store.eff.rootId) }, _('+ New crate')),
      h('button', { class: 'btn btn-sm', onclick: openUnsortedEditor, title: _('Choose which crates count as unsorted, and tidy up into Inbox') }, _('Unsorted…')),
    ),
    rootDrop,
    treeEl,
    h('div', { class: 'tree-hint muted small' }, _('Drag crates to rearrange them. Drag songs from the right onto a crate to add them (hold ⌥ to move)')),
  );

  const headEl = h('div', { class: 'panel-head crate-head' });
  const selBar = h('div', { class: 'toolbar selbar' });
  const vlist = new VirtualList({ rowHeight: 40, renderRow: renderTrackRow, className: 'track-list' });
  vlist.el.addEventListener('mousedown', () => (focusArea = 'tracks'));
  const detail = h(
    'section',
    { class: 'panel crate-detail' },
    headEl,
    selBar,
    h('div', { class: 'trow trow-head trow-crate' }, h('span'), h('span', {}, _('Title / artist')), h('span', { class: 'num' }, 'BPM'), h('span', {}, 'Key'), h('span', {}, _('Format')), h('span', {}, _('Genre')), h('span', { class: 'num' }, _('Other crates'))),
    vlist.el,
  );
  const el = h('div', { class: 'view structure' }, treePanel, detail);
  const offPlayer = player.onChange(() => vlist.render());

  // ---------- auto-scroll the crate tree while dragging near its top / bottom edge ----------
  // The closer to the edge (or past it), the faster it scrolls. Works for crates and for songs
  // dragged from the list on the right.
  const EDGE = 60; // px from the tree's top / bottom where scrolling starts
  const MAX_SPEED = 20; // px per frame
  let scrollStep = 0;
  let scrollFrame = 0;
  function scrollTick() {
    if (!dragging || !scrollStep) {
      scrollFrame = 0;
      return;
    }
    treeEl.scrollTop += scrollStep;
    scrollFrame = requestAnimationFrame(scrollTick);
  }
  function autoScroll(e) {
    if (!dragging) return;
    const r = treeEl.getBoundingClientRect();
    const near = (d) => Math.ceil(MAX_SPEED * Math.min(1, d / EDGE));
    if (e.clientX < r.left - 40 || e.clientX > r.right + 40) scrollStep = 0;
    else if (e.clientY < r.top + EDGE) scrollStep = -near(r.top + EDGE - e.clientY);
    else if (e.clientY > r.bottom - EDGE) scrollStep = near(e.clientY - (r.bottom - EDGE));
    else scrollStep = 0;
    if (scrollStep && !scrollFrame) scrollFrame = requestAnimationFrame(scrollTick);
  }
  const stopScroll = (e) => {
    if (e.type !== 'dragleave' || !e.relatedTarget) scrollStep = 0; // dragleave without relatedTarget = left the window
  };
  document.addEventListener('dragover', autoScroll);
  for (const t of ['drop', 'dragend', 'dragleave']) document.addEventListener(t, stopScroll);

  // ---------- tree ----------
  function saveExpanded() {
    prefs.set('tree.expanded', [...expanded]);
  }

  // Only scroll the selected crate into view when the selection itself changes (click / keys),
  // not on every re-render: a re-render after a drop must not yank the tree away.
  function renderTree({ reveal = false } = {}) {
    const keep = treeEl.scrollTop;
    const eff = store.eff;
    let show = null;
    if (treeFilter.trim()) {
      const words = norm(treeFilter).split(' ');
      show = new Set();
      for (const id of eff.crates.keys()) {
        const p = norm(eff.pathOf(id));
        if (words.every((w) => p.includes(w))) {
          for (let cur = id; cur != null && eff.crates.has(cur); cur = eff.crates.get(cur).parent) show.add(cur);
        }
      }
    }
    visible = [];
    const walk = (parent, depth) => {
      for (const id of eff.children.get(parent) || []) {
        if (show && !show.has(id)) continue;
        visible.push({ id, depth });
        if (show || expanded.has(id)) walk(id, depth + 1);
      }
    };
    walk(eff.rootId, 0);
    clear(treeEl, visible.map(({ id, depth }) => treeRow(id, depth, !!show)), !visible.length ? h('div', { class: 'empty' }, _('No crates match')) : null);
    if (reveal) treeEl.querySelector('.is-selected')?.scrollIntoView({ block: 'nearest' });
    else treeEl.scrollTop = keep;
  }

  function treeRow(id, depth, forceOpen) {
    const eff = store.eff;
    const c = eff.crates.get(id);
    const kids = eff.children.get(id) || [];
    const open = forceOpen || expanded.has(id);
    const st = c.status || {};
    const count = (eff.members.get(id) || []).length;
    const row = h(
      'div',
      {
        class: `tree-row ${id === selected ? 'is-selected' : ''}`,
        style: { paddingLeft: `${8 + depth * 16}px` },
        draggable: true,
        onclick: () => selectCrate(id),
        oncontextmenu: (e) => crateMenu(e, id),
        ondblclick: (e) => {
          if (!e.target.closest('.caret')) renameCrate(id); // double-clicking the arrow only toggles it twice
        },
        ondragstart: (e) => {
          dragging = { kind: 'crate', id };
          e.dataTransfer.effectAllowed = 'move';
          e.dataTransfer.setData('text/plain', eff.pathOf(id));
        },
        ondragend: () => (dragging = null),
      },
      h(
        'button',
        {
          class: `caret ${kids.length ? '' : 'is-leaf'}`,
          tabindex: -1,
          onclick: (e) => {
            e.stopPropagation();
            toggle(id);
          },
        },
        kids.length ? h('span', { class: `chev ${open ? 'is-open' : ''}` }) : '',
      ),
      h('span', { class: 'tree-name' }, c.name),
      st.created ? h('span', { class: 'tag tag-new' }, _('New')) : null,
      st.originalName != null ? h('span', { class: 'tag tag-edit', title: _('Original name: {name}', { name: st.originalName }) }, _('Renamed')) : null,
      st.originalParent !== undefined ? h('span', { class: 'tag tag-edit' }, _('Moved')) : st.reordered ? h('span', { class: 'tag tag-edit', title: _('New position in this level (added to the plan)') }, _('Reordered')) : null,
      st.merged ? h('span', { class: 'tag tag-edit' }, _('Merged')) : null,
      // Mark only the top-most unsorted crate; its sub-crates inherit it.
      store.rules.skip.has(id) && !store.rules.skip.has(c.parent) ? h('span', { class: 'tag tag-unsorted', title: _('Songs in this crate (and its child crates) count as unsorted') }, _('Unsorted crate')) : null,
      h('span', { class: 'tree-count' }, count || ''),
    );
    wireDrop(row, () => id);
    return row;
  }

  // A crate dragged over the top or bottom edge of a row goes before / after that crate (same level);
  // over the middle it goes into it. Songs always go into the crate.
  function dropZone(e, node, target) {
    if (dragging?.kind !== 'crate' || target === store.eff.rootId) return 'into';
    const r = node.getBoundingClientRect();
    const y = (e.clientY - r.top) / r.height;
    return y < 0.3 ? 'before' : y > 0.7 ? 'after' : 'into';
  }

  /** { parent, before } for dropping crate d before / after target, or null when not possible or no change. */
  function placeOf(d, target, zone) {
    const eff = store.eff;
    const t = eff.crates.get(target);
    if (!t || target === d.id) return null;
    const inside = subtreeIds(eff, d.id);
    if (inside.includes(target) || inside.includes(t.parent)) return null;
    const others = (eff.children.get(t.parent) || []).filter((x) => x !== d.id);
    const before = zone === 'before' ? target : (others[others.indexOf(target) + 1] ?? null);
    return isAt(d.id, t.parent, before) ? null : { parent: t.parent, before };
  }

  /** Is the crate already under `parent`, just before `before` (null: last)? */
  function isAt(id, parent, before) {
    const eff = store.eff;
    if (eff.crates.get(id)?.parent !== parent) return false;
    const sibs = eff.children.get(parent) || [];
    const others = sibs.filter((x) => x !== id);
    return sibs.indexOf(id) === (before == null ? others.length : others.indexOf(before));
  }

  function wireDrop(node, targetId) {
    const ZONES = ['is-drop', 'is-drop-before', 'is-drop-after'];
    // WebKit (the Mac app) only accepts a drop if both dragenter and dragover are cancelled.
    const accept = (e) => {
      const target = targetId();
      if (!dragging) return;
      const zone = dropZone(e, node, target);
      const ok = zone === 'into' ? canDrop(dragging, target) : !!placeOf(dragging, target, zone);
      node.classList.toggle('is-drop', ok && zone === 'into');
      node.classList.toggle('is-drop-before', ok && zone === 'before');
      node.classList.toggle('is-drop-after', ok && zone === 'after');
      if (!ok) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = dragging.kind === 'tracks' && !e.altKey ? 'copy' : 'move';
    };
    node.addEventListener('dragenter', accept);
    node.addEventListener('dragover', accept);
    node.addEventListener('dragleave', () => node.classList.remove(...ZONES));
    node.addEventListener('drop', (e) => {
      e.preventDefault();
      node.classList.remove(...ZONES);
      const zone = dropZone(e, node, targetId());
      const d = dragging;
      dragging = null;
      if (!d) return;
      const target = targetId();
      if (d.kind === 'crate' && zone !== 'into') {
        const place = placeOf(d, target, zone);
        if (place) placeCrate(d.id, place.parent, place.before);
      } else if (d.kind === 'crate') moveCrateTo(d.id, target);
      else addTracksTo(d.ids, target, e.altKey ? d.from : null);
    });
  }

  function canDrop(d, target) {
    const eff = store.eff;
    if (d.kind === 'crate') {
      if (target === d.id || eff.crates.get(d.id)?.parent === target) return false;
      return target === eff.rootId || !subtreeIds(eff, d.id).includes(target);
    }
    return target !== eff.rootId && target !== d.from;
  }

  function toggle(id, force) {
    const open = force ?? !expanded.has(id);
    if (open) expanded.add(id);
    else expanded.delete(id);
    saveExpanded();
    renderTree();
  }

  function selectCrate(id) {
    if (selected !== id) {
      selTracks.clear();
      anchor = -1;
    }
    selected = id;
    prefs.set('tree.selected', id);
    const eff = store.eff;
    for (let cur = eff.crates.get(id)?.parent; cur != null && eff.crates.has(cur); cur = eff.crates.get(cur).parent) expanded.add(cur);
    saveExpanded();
    renderTree({ reveal: true });
    renderDetail();
    vlist.el.scrollTop = 0;
  }

  // ---------- crate actions ----------
  const siblingNameTaken = (parent, name, except) => {
    const eff = store.eff;
    return (eff.children.get(parent) || []).some((id) => id !== except && norm(eff.crates.get(id).name) === norm(name));
  };

  async function createCrate(parent) {
    const eff = store.eff;
    const name = await promptDialog({
      title: parent === eff.rootId ? _('New crate') : _('New crate under "{parent}"', { parent: eff.pathOf(parent) }),
      placeholder: _('Crate name'),
      okText: _('Add crate'),
      validate: (v) => (siblingNameTaken(parent, v) ? _('This level already has that name') : null),
    });
    if (!name) return;
    const op = store.opCreate(name, parent);
    if (store.commit(_('Create crate "{path}"', { path: name }), [op])) {
      if (parent !== eff.rootId) expanded.add(parent);
      selectCrate(op.id);
    }
  }

  async function renameCrate(id) {
    const eff = store.eff;
    const c = eff.crates.get(id);
    if (!c) return;
    const name = await promptDialog({
      title: _('Rename'),
      value: c.name,
      okText: _('Save name'),
      validate: (v) => (v === c.name ? _('The name did not change') : siblingNameTaken(c.parent, v, id) ? _('This level already has that name') : null),
    });
    if (name) store.commit(_('Rename "{from}" to "{to}"', { from: c.name, to: name }), [store.opRename(id, name)]);
  }

  function moveCrateTo(id, parent) {
    const eff = store.eff;
    const c = eff.crates.get(id);
    if (siblingNameTaken(parent, c.name, id)) {
      toast(_('"{name}" already exists in the target. To merge, use "Merge into…"', { name: c.name }), { tone: 'danger' });
      return;
    }
    if (store.commit(parent === eff.rootId ? _('Move "{name}" to the top level', { name: c.name }) : _('Move "{name}" to {parent}', { name: c.name, parent: eff.pathOf(parent) }), [store.opMove(id, parent)])) {
      if (parent !== eff.rootId) expanded.add(parent);
      saveExpanded();
      selectCrate(id);
    }
  }

  /** Put a crate just before `before` under `parent` (null: last). Repeated reorders of one crate stay one change. */
  function placeCrate(id, parent, before) {
    const eff = store.eff;
    const c = eff.crates.get(id);
    if (!c) return;
    if (parent !== c.parent && siblingNameTaken(parent, c.name, id)) {
      toast(_('"{name}" already exists in the target. To merge, use "Merge into…"', { name: c.name }), { tone: 'danger' });
      return;
    }
    const op = store.opMove(id, parent, before);
    const last = store.plan.changes.at(-1);
    const prev = last?.ops.length === 1 ? last.ops[0] : null;
    if (op.reorder && prev?.type === 'moveCrate' && prev.reorder && prev.crate === id && prev.parent === parent) {
      store.undo(last.id);
      if (isAt(id, parent, before)) {
        toast(_('"{name}" is back in its original place', { name: c.name }));
        selectCrate(id);
        return;
      }
    }
    if (store.commit(op.text, [op])) {
      if (parent !== store.eff.rootId) expanded.add(parent);
      saveExpanded();
      selectCrate(id);
    }
  }

  const siblingsOf = (id) => store.eff.children.get(store.eff.crates.get(id)?.parent) || [];

  /** One place up (-1) or down (+1) within its level. */
  function nudge(id, delta) {
    const sibs = siblingsOf(id);
    const i = sibs.indexOf(id);
    if (i < 0 || i + delta < 0 || i + delta >= sibs.length) return;
    placeCrate(id, store.eff.crates.get(id).parent, delta < 0 ? sibs[i - 1] : (sibs[i + 2] ?? null));
  }

  function toEdge(id, top) {
    const others = siblingsOf(id).filter((x) => x !== id);
    placeCrate(id, store.eff.crates.get(id).parent, top ? (others[0] ?? null) : null);
  }

  async function moveDialog(id) {
    const eff = store.eff;
    const exclude = new Set(subtreeIds(eff, id));
    const target = await modal({
      title: _('Move "{crate}" to…', { crate: eff.pathOf(id) }),
      wide: true,
      body: (close) => [
        h('button', { class: 'btn btn-block', disabled: eff.crates.get(id).parent === eff.rootId, onclick: () => close(eff.rootId) }, _('Move to the top level')),
        createCratePicker({ inline: true, autofocus: true, exclude: () => exclude, placeholder: _('Or pick the crate to put it under'), onPick: (t) => close(t) }).el,
      ],
    });
    if (target != null) moveCrateTo(id, target);
  }

  async function mergeDialog(id) {
    const eff = store.eff;
    const target = await pickCrateDialog({ title: _('Merge "{crate}" into… (its songs and child crates move over)', { crate: eff.pathOf(id) }), exclude: new Set(subtreeIds(eff, id)), allowCreate: false });
    if (target == null) return;
    if (store.commit(_('Merged "{from}" into "{into}"', { from: eff.pathOf(id), into: eff.pathOf(target) }), [store.opMerge(id, target)])) selectCrate(target);
  }

  async function deleteCrate(id) {
    const eff = store.eff;
    const ids = subtreeIds(eff, id);
    const nTracks = new Set(ids.flatMap((c) => eff.members.get(c) || [])).size;
    const ok = await confirmDialog({
      title: _('Delete "{crate}"?', { crate: eff.pathOf(id) }),
      message: `${ids.length > 1 ? _n(ids.length - 1, 'Includes {n} child crate. ', 'Includes {n} child crates. ') : ''}${_n(nTracks, '{n} song loses this sorting (the song stays in the library). This only goes into the plan and can be undone.', '{n} songs lose this sorting (the songs stay in the library). This only goes into the plan and can be undone.')}`,
      okText: _('Stage in plan'),
      danger: true,
    });
    if (!ok) return;
    const parent = eff.crates.get(id).parent;
    if (store.commit(_('Delete crate "{crate}"', { crate: eff.pathOf(id) }), [store.opDelete(id)])) {
      selected = store.eff.crates.has(parent) ? parent : null;
      renderAll();
    }
  }

  // ---------- right-click menus ----------
  function expandAll(id, open) {
    for (const c of subtreeIds(store.eff, id)) {
      if (!(store.eff.children.get(c) || []).length) continue;
      if (open) expanded.add(c);
      else expanded.delete(c);
    }
    saveExpanded();
    renderTree();
  }

  function crateMenu(e, id) {
    if (selected !== id) selectCrate(id);
    const eff = store.eff;
    const kids = (eff.children.get(id) || []).length;
    const songs = (eff.members.get(id) || []).length;
    const reason = unsortedReason(id);
    const auto = store.rules.auto.has(id);
    contextMenu(e, [
      navigate && songs
        ? {
            label: _('Sort the songs in this crate'),
            action: () => {
              prefs.set('inbox.source', { kind: 'crate', id });
              navigate('inbox');
            },
          }
        : null,
      'sep',
      { label: _('Rename'), hint: 'F2', action: () => renameCrate(id) },
      { label: _('New child crate'), hint: 'N', action: () => createCrate(id) },
      { label: _('Move…'), action: () => moveDialog(id) },
      ...(() => {
        const sibs = siblingsOf(id);
        const i = sibs.indexOf(id);
        const first = i <= 0;
        const last = i === sibs.length - 1;
        return [
          { label: _('Move up'), hint: '⌥↑', disabled: first, action: () => nudge(id, -1) },
          { label: _('Move down'), hint: '⌥↓', disabled: last, action: () => nudge(id, 1) },
          { label: _('Move to the top of this level'), disabled: first, action: () => toEdge(id, true) },
          { label: _('Move to the bottom of this level'), disabled: last, action: () => toEdge(id, false) },
        ];
      })(),
      { label: _('Merge into…'), action: () => mergeDialog(id) },
      'sep',
      reason === 'inherited'
        ? null
        : {
            label: reason != null ? _('Stop counting as unsorted') : _('Count as unsorted'),
            action: () => store.setClassifyOverride(id, reason != null ? (auto ? 'count' : null) : auto ? null : 'skip'),
          },
      kids ? { label: _('Expand all below'), action: () => expandAll(id, true) } : null,
      kids ? { label: _('Collapse all below'), action: () => expandAll(id, false) } : null,
      'sep',
      { label: _('Delete…'), hint: 'Delete', danger: true, action: () => deleteCrate(id) },
    ]);
  }

  function trackMenu(e, t, i) {
    focusArea = 'tracks';
    if (!selTracks.has(t.id)) {
      selTracks.clear();
      selTracks.add(t.id);
      anchor = i;
      renderSelBar();
      vlist.render();
    }
    const n = selTracks.size;
    const crate = store.eff.pathOf(selected);
    contextMenu(e, [
      { label: player.isCurrent(`t${t.id}`) && player.playing ? _('Pause') : _('Play'), hint: _('Space'), action: () => player.toggle(t) },
      { label: _('Show in Finder'), disabled: !t.exists, action: () => revealInFinder(effectivePath(store.eff, t)) },
      spectrumAvailable() ? { label: _('Spectrum'), disabled: !t.exists, action: () => showSpectrum({ path: effectivePath(store.eff, t), title: t.title || t.fileName, quality: store.trackQuality(t) }) } : null,
      noteMenuItem({ track: t }),
      'sep',
      { label: n > 1 ? _n(n, 'Add {n} song to…', 'Add {n} songs to…') : _('Add to…'), action: () => tracksTo('copy') },
      { label: n > 1 ? _n(n, 'Move {n} song to…', 'Move {n} songs to…') : _('Move to…'), action: () => tracksTo('move') },
      'sep',
      { label: _n(n, 'Remove {n} song from "{crate}"', 'Remove {n} songs from "{crate}"', { crate }), hint: 'Delete', danger: true, action: removeSelected },
    ]);
  }

  // ---------- tracks ----------
  function renderDetail() {
    const eff = store.eff;
    if (selected != null && !eff.crates.has(selected)) selected = null;
    if (selected == null) {
      clear(headEl, h('div', { class: 'empty' }, _('Pick a crate on the left')));
      clear(selBar);
      tracks = [];
      vlist.setItems([]);
      return;
    }
    const c = eff.crates.get(selected);
    const st = c.status || {};
    const kids = eff.children.get(selected) || [];
    tracks = (eff.members.get(selected) || []).map((a) => store.base.tracks.get(a)).filter(Boolean);
    for (const id of selTracks) if (!tracks.some((t) => t.id === id)) selTracks.delete(id);

    const notes = [];
    if (st.created) notes.push(_('newly created'));
    if (st.originalName != null) notes.push(_('originally "{name}"', { name: st.originalName }));
    if (st.originalParent !== undefined) notes.push(_('originally in "{parent}"', { parent: st.originalParent === eff.rootId ? _('top level') : eff.pathOf(st.originalParent) }));
    clear(
      headEl,
      h(
        'div',
        { class: 'crate-title' },
        h('h2', {}, eff.pathOf(selected)),
        h('div', { class: 'muted small' }, `${_n(tracks.length, '{n} song', '{n} songs')} · ${_n(kids.length, '{n} child crate', '{n} child crates')}`, notes.length ? ` · ${_('{notes} (not in Serato yet)', { notes: notes.join(_(', ')) })}` : ''),
        (() => {
          const adding = [...eff.imports.values()].filter((i) => i.crate === selected).length;
          return adding ? h('div', { class: 'small import-pending' }, _n(adding, '+ {n} song from disk is added when the plan is applied (see Folders)', '+ {n} songs from disk are added when the plan is applied (see Folders)')) : null;
        })(),
      ),
      h(
        'div',
        { class: 'toolbar' },
        h('button', { class: 'btn btn-sm', onclick: () => renameCrate(selected), title: 'F2' }, _('Rename')),
        h('button', { class: 'btn btn-sm', onclick: () => createCrate(selected), title: 'N' }, _('New child crate')),
        h('button', { class: 'btn btn-sm', onclick: () => moveDialog(selected) }, _('Move…')),
        h('button', { class: 'btn btn-sm', onclick: () => mergeDialog(selected) }, _('Merge into…')),
        h('button', { class: 'btn btn-sm btn-danger-ghost', onclick: () => deleteCrate(selected), title: 'Delete' }, _('Delete')),
        unsortedToggle(selected),
      ),
    );
    renderSelBar();
    vlist.setItems(tracks, h('div', { class: 'empty' }, kids.length ? _('This crate only holds child crates, no songs directly') : _('Empty crate')));
  }

  function unsortedToggle(id) {
    const reason = unsortedReason(id);
    if (reason === 'inherited') {
      let top = id;
      while (store.rules.skip.has(store.eff.crates.get(top)?.parent)) top = store.eff.crates.get(top).parent;
      return h('span', { class: 'tag tag-unsorted', title: _('Because it is under "{crate}"', { crate: store.eff.pathOf(top) }) }, _('Unsorted (inherited)'));
    }
    const on = reason != null;
    return h(
      'label',
      { class: 'check', title: _('Songs in this crate (and its child crates) count as unsorted') },
      h('input', {
        type: 'checkbox',
        checked: on,
        onchange: (e) => {
          const auto = store.rules.auto.has(id);
          store.setClassifyOverride(id, e.target.checked ? (auto ? null : 'skip') : auto ? 'count' : null);
        },
      }),
      _('Counts as unsorted'),
    );
  }

  function renderSelBar() {
    const n = selTracks.size;
    clear(
      selBar,
      n
        ? [
            h('span', { class: 'muted' }, _n(n, '{n} song selected', '{n} songs selected')),
            h('button', { class: 'btn btn-sm', onclick: () => tracksTo('copy') }, _('Add to…')),
            h('button', { class: 'btn btn-sm', onclick: () => tracksTo('move') }, _('Move to…')),
            h('button', { class: 'btn btn-sm btn-danger-ghost', onclick: removeSelected }, _('Remove from this crate')),
            h('button', { class: 'btn btn-ghost btn-sm', onclick: () => { selTracks.clear(); renderSelBar(); vlist.render(); } }, _('Deselect')),
          ]
        : h('span', { class: 'muted small' }, _('Click songs (⇧ range, ⌘ multiple, ⌘A all) and drag them onto a crate on the left')),
    );
  }

  function renderTrackRow(t, i) {
    const eff = store.eff;
    const isNew = !(store.base.members.get(selected) || []).includes(t.id);
    const others = (eff.cratesOf.get(t.id) || []).length - 1;
    return h(
      'div',
      {
        class: `trow trow-crate ${selTracks.has(t.id) ? 'is-selected' : ''}`,
        draggable: true,
        onclick: (e) => clickTrack(e, t, i),
        oncontextmenu: (e) => trackMenu(e, t, i),
        ondblclick: () => player.play(t),
        ondragstart: (e) => {
          if (!selTracks.has(t.id)) {
            selTracks.clear();
            selTracks.add(t.id);
            renderSelBar();
            vlist.render();
          }
          dragging = { kind: 'tracks', ids: [...selTracks], from: selected };
          e.dataTransfer.effectAllowed = 'copyMove';
          e.dataTransfer.setData('text/plain', _n(selTracks.size, '{n} track', '{n} tracks'));
        },
        ondragend: () => (dragging = null),
      },
      h('span', { class: 'trow-status' }, player.isCurrent(`t${t.id}`) ? (player.playing ? '♪' : '❚❚') : isNew ? h('span', { class: 'dot dot-new', title: _('Newly added') }) : ''),
      h('div', { class: 'trow-main' }, h('div', { class: 'trow-title' }, noteMark({ track: t }), t.title || t.fileName), h('div', { class: 'trow-sub' }, t.artist || '—')),
      h('span', { class: 'num' }, fmt.bpm(t.bpm)),
      h('span', {}, t.key || '–'),
      h('span', { class: 'ellipsis' }, qualityBadge(store.trackQuality(t), { compact: true })),
      h('span', { class: 'ellipsis muted' }, t.genre || ''),
      h('span', { class: 'num muted', title: (eff.cratesOf.get(t.id) || []).filter((c) => c !== selected).map((c) => eff.pathOf(c)).join('\n') }, others || ''),
    );
  }

  function clickTrack(e, t, i) {
    focusArea = 'tracks';
    if (e.shiftKey && anchor >= 0) {
      const [a, b] = [Math.min(anchor, i), Math.max(anchor, i)];
      if (!e.metaKey) selTracks.clear();
      for (let k = a; k <= b; k++) selTracks.add(tracks[k].id);
    } else if (e.metaKey || e.ctrlKey) {
      if (selTracks.has(t.id)) selTracks.delete(t.id);
      else selTracks.add(t.id);
      anchor = i;
    } else {
      selTracks.clear();
      selTracks.add(t.id);
      anchor = i;
    }
    renderSelBar();
    vlist.render();
  }

  function addTracksTo(ids, target, moveFrom) {
    const eff = store.eff;
    const have = new Set(eff.members.get(target) || []);
    const ops = ids.filter((a) => !have.has(a)).map((a) => store.opAdd(target, a));
    if (moveFrom != null) ops.push(...ids.map((a) => store.opRemove(moveFrom, a)));
    if (!ops.length) {
      toast(_('These songs are already in "{crate}"', { crate: eff.pathOf(target) }));
      return;
    }
    store.commit(moveFrom != null ? _n(ids.length, 'Move {n} song to "{crate}"', 'Move {n} songs to "{crate}"', { crate: eff.pathOf(target) }) : _n(ids.length, 'Add {n} song to "{crate}"', 'Add {n} songs to "{crate}"', { crate: eff.pathOf(target) }), ops);
  }

  async function tracksTo(mode) {
    const ids = [...selTracks];
    const target = await pickCrateDialog({ title: mode === 'move' ? _n(ids.length, 'Move {n} song to…', 'Move {n} songs to…') : _n(ids.length, 'Add {n} song to…', 'Add {n} songs to…'), exclude: new Set([selected]) });
    if (target == null) return;
    addTracksTo(ids, parseId(target), mode === 'move' ? selected : null);
    if (mode === 'move') selTracks.clear();
  }

  function removeSelected() {
    const ids = [...selTracks];
    selTracks.clear();
    store.commit(_n(ids.length, 'Remove {n} song from "{crate}"', 'Remove {n} songs from "{crate}"', { crate: store.eff.pathOf(selected) }), ids.map((a) => store.opRemove(selected, a)));
  }

  function renderAll() {
    renderTree();
    renderDetail();
  }

  if (selected == null || !store.eff.crates.has(selected)) selected = (store.eff.children.get(store.eff.rootId) || [])[0] ?? null;
  // Another view may have picked the crate to show (prefs 'tree.selected'): open the crates around it.
  for (let cur = store.eff.crates.get(selected)?.parent; store.eff.crates.has(cur); cur = store.eff.crates.get(cur).parent) expanded.add(cur);
  renderAll();
  requestAnimationFrame(() => treeEl.querySelector('.is-selected')?.scrollIntoView({ block: 'nearest' })); // once, when the view opens

  return {
    el,
    title: _('Crates'),
    update: renderAll,
    onKey(e) {
      if (focusArea === 'tracks') {
        if ((e.metaKey || e.ctrlKey) && e.key === 'a') {
          tracks.forEach((t) => selTracks.add(t.id));
          renderSelBar();
          vlist.render();
          return true;
        }
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          const i = Math.min(tracks.length - 1, Math.max(0, anchor + (e.key === 'ArrowDown' ? 1 : -1)));
          if (tracks[i]) {
            clickTrack({ shiftKey: e.shiftKey, metaKey: false }, tracks[i], i);
            if (!e.shiftKey) anchor = i;
            vlist.scrollToIndex(i);
          }
          return true;
        }
        if (e.key === ' ') {
          const t = tracks.find((x) => selTracks.has(x.id)) || tracks[0];
          if (t) player.toggle(t);
          return true;
        }
        if (e.key === 'Backspace' || e.key === 'Delete') {
          if (selTracks.size) removeSelected();
          return true;
        }
        if (e.key === 'Escape') {
          focusArea = 'tree';
          return true;
        }
      }
      // tree
      if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
        if (selected != null) nudge(selected, e.key === 'ArrowUp' ? -1 : 1);
        return true;
      }
      const idx = visible.findIndex((r) => r.id === selected);
      switch (e.key) {
        case 'ArrowDown':
          if (visible[idx + 1]) selectCrate(visible[idx + 1].id);
          return true;
        case 'ArrowUp':
          if (idx > 0) selectCrate(visible[idx - 1].id);
          return true;
        case 'ArrowRight':
          if (selected != null && (store.eff.children.get(selected) || []).length) toggle(selected, true);
          return true;
        case 'ArrowLeft': {
          if (selected == null) return true;
          if (expanded.has(selected)) toggle(selected, false);
          else {
            const parent = store.eff.crates.get(selected)?.parent;
            if (store.eff.crates.has(parent)) selectCrate(parent);
          }
          return true;
        }
        case 'F2':
        case 'Enter':
          if (selected != null) renameCrate(selected);
          return true;
        case 'n':
          createCrate(selected ?? store.eff.rootId);
          return true;
        case 'Backspace':
        case 'Delete':
          if (selected != null) deleteCrate(selected);
          return true;
        case ' ':
          player.toggle();
          return true;
        default:
          return false;
      }
    },
    destroy() {
      offPlayer();
      vlist.destroy();
      document.removeEventListener('dragover', autoScroll);
      for (const t of ['drop', 'dragend', 'dragleave']) document.removeEventListener(t, stopScroll);
      cancelAnimationFrame(scrollFrame);
    },
  };
}
