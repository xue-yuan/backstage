// Cleanup view: missing files (relocate / remove), duplicates (merge into a keeper), empty crates.
import { effectivePath, findDuplicates, findEmptyCrates, findUncategorized, liveTracks, pathKey } from '../model.js';
import { player } from '../player.js';
import { qualityBadge, qualityScore } from '../quality.js';
import { api, store } from '../store.js';
import { clear, confirmDialog, fmt, h, prefs } from '../ui.js';
import { _, _n } from '../i18n.js';

// Real-codec score for picking which duplicate to keep; undefined falls back to Serato's data.
const scoreOf = (t) => {
  const q = store.trackQuality(t);
  return q.known ? qualityScore(q) : undefined;
};

export function createCleanupView({ navigate }) {
  let tab = prefs.get('cleanup.tab', 'missing');
  let candidates = null; // { [assetId]: [{path,size,modifiedAt}] }
  let scanError = null;
  let scanning = false;
  const chosen = new Map(); // assetId -> chosen candidate path
  const keepers = new Map(); // dup group key -> asset id
  let dismissed = new Set(prefs.get('dupes.dismissed', []));
  let closeLengthOnly = prefs.get('dupes.closeLengthOnly', false);
  const emptySelected = new Set();

  const tabsEl = h('div', { class: 'segmented' });
  const bodyEl = h('div', { class: 'cleanup-body' });
  const el = h('div', { class: 'view cleanup' }, h('div', { class: 'cleanup-head' }, tabsEl), bodyEl);
  const offPlayer = player.onChange(() => {
    for (const b of el.querySelectorAll('[data-play-key]')) {
      b.textContent = player.isCurrent(b.dataset.playKey) && player.playing ? '❚❚' : '▶';
    }
  });

  const missingAll = () => [...store.base.tracks.values()].filter((t) => !t.exists);
  // The music-folder scan says which files may go to the Trash (the Overview usually loaded it already).
  if (!store.folderScan) store.loadFolders().catch(() => {});

  function renderTabs() {
    const eff = store.eff;
    const missingOpen = missingAll().filter((t) => !eff.relocated.has(t.id) && !eff.removedTracks.has(t.id)).length;
    const dupes = findDuplicates(eff, scoreOf).filter((g) => !dismissed.has(g.key)).length;
    const empty = findEmptyCrates(eff).length;
    const uncategorized = findUncategorized(eff).length;
    const seg = (id, label, n) =>
      h(
        'button',
        {
          class: `seg ${tab === id ? 'is-active' : ''}`,
          onclick: () => {
            tab = id;
            prefs.set('cleanup.tab', tab);
            render();
          },
        },
        label,
        h('span', { class: `count ${n ? 'count-warn' : ''}` }, n),
      );
    clear(
      tabsEl,
      seg('missing', _('Missing files'), missingOpen),
      seg('dupes', _('Duplicates'), dupes),
      seg('empty', _('Empty crates'), empty),
      h(
        'button',
        {
          class: 'seg',
          title: _('Handle in Sort'),
          onclick: () => {
            prefs.set('inbox.source', { kind: 'uncategorized' });
            navigate('inbox');
          },
        },
        _('In no crate'),
        h('span', { class: 'count' }, uncategorized),
        ' →',
      ),
    );
  }

  function playBtn(key, track) {
    return h(
      'button',
      { class: 'icon-btn', dataset: { playKey: key }, title: _('Preview'), onclick: () => player.toggle(track) },
      player.isCurrent(key) && player.playing ? '❚❚' : '▶',
    );
  }

  // ---------- missing ----------
  async function scan() {
    scanning = true;
    scanError = null;
    render();
    try {
      candidates = (await api.relocateCandidates()).candidates;
    } catch (e) {
      scanError = e.message;
    }
    scanning = false;
    render();
  }

  function renderMissing() {
    const eff = store.eff;
    const list = missingAll();
    if (!candidates && !scanning && !scanError) scan();
    const open = list.filter((t) => !eff.relocated.has(t.id) && !eff.removedTracks.has(t.id));
    const single = open.filter((t) => candidates?.[t.id]?.length === 1);
    const none = open.filter((t) => candidates && !candidates[t.id]?.length);

    const head = h(
      'div',
      { class: 'cleanup-intro' },
      h(
        'p',
        {},
        _n(list.length, '{n} song in the Serato library is not on disk. Files with the same name in ~/Music are offered as candidate locations.', '{n} songs in the Serato library are not on disk. Files with the same name in ~/Music are offered as candidate locations.'),
        _('If a candidate file already has its own record in Serato (usually because the folder was moved and imported again), this song\'s crates are merged into that record instead of adding a second record for the same file.'),
      ),
      scanning ? h('p', { class: 'muted' }, _('Scanning…')) : null,
      scanError ? h('p', { class: 'notice notice-danger' }, _('Scan failed: {error}', { error: scanError })) : null,
      candidates
        ? h(
            'div',
            { class: 'toolbar' },
            h('button', { class: 'btn btn-primary', disabled: !single.length, onclick: () => resolveAll(single) }, _n(single.length, 'Apply all unique candidates ({n} song)', 'Apply all unique candidates ({n} songs)')),
            h('button', { class: 'btn', disabled: !none.length, onclick: () => removeAll(none) }, _n(none.length, 'Remove those without a candidate ({n} song)', 'Remove those without a candidate ({n} songs)')),
            h('button', { class: 'btn btn-ghost', onclick: scan }, _('Scan again')),
          )
        : null,
    );

    // Unresolved first (those with a candidate on top), staged ones last.
    const rank = (t) => (eff.relocated.has(t.id) || eff.removedTracks.has(t.id) ? 2 : candidates?.[t.id]?.length ? 0 : 1);
    list.sort((a, b) => rank(a) - rank(b));
    const rows = list.map((t) => {
      const relocatedTo = eff.relocated.get(t.id);
      const removed = eff.removedTracks.has(t.id);
      const cands = candidates?.[t.id] || [];
      const pick = cands.some((c) => c.path === chosen.get(t.id)) ? chosen.get(t.id) : cands[0]?.path; // a pick gone after a rescan falls back
      const crates = store.base.baseCratesOf.get(t.id) || [];
      let body;
      if (relocatedTo || removed) {
        body = h(
          'div',
          { class: 'staged' },
          h('span', { class: 'tag tag-ok' }, _('Staged')),
          relocatedTo ? ` ${_('moved to {path}', { path: fmt.shortPath(relocatedTo) })}` : ` ${_('removed from the library ({reason})', { reason: eff.removedTracks.get(t.id) || _('Missing file') })}`,
          h('button', {
            class: 'btn btn-ghost btn-xs',
            onclick: () => store.revertOps((op) => op.missing === t.id || ((op.type === 'relocate' || op.type === 'removeTrack') && op.asset === t.id)),
          }, _('Cancel')),
        );
      } else {
        body = h(
          'div',
          {},
          cands.length
            ? h(
                'div',
                { class: 'cands' },
                cands.map((c) =>
                  h(
                    'label',
                    { class: 'cand' },
                    h('input', {
                      type: 'radio',
                      name: `cand-${t.id}`,
                      checked: c.path === pick,
                      onchange: () => {
                        chosen.set(t.id, c.path);
                        render();
                      },
                    }),
                    playBtn(`f${c.path}`, { playKey: `f${c.path}`, src: `/api/audio-file?path=${encodeURIComponent(c.path)}`, title: t.title || t.fileName, artist: _('Candidate file') }),
                    h('span', { class: 'cand-path', title: c.path }, fmt.shortPath(c.path)),
                    libraryTrackAt(c.path) != null ? h('span', { class: 'tag tag-edit', title: _('This file already has another record in Serato') }, _('In library')) : null,
                    h('span', { class: 'muted small' }, `${fmt.size(c.size)} · ${fmt.date(c.modifiedAt)}`),
                  ),
                ),
              )
            : candidates
              ? h('div', { class: 'muted small' }, _('No file with the same name'))
              : null,
          h(
            'div',
            { class: 'row-actions' },
            cands.length
              ? h(
                  'button',
                  { class: 'btn btn-sm btn-primary', onclick: () => resolve(t, pick) },
                  libraryTrackAt(pick) != null ? _('Merge into that record') : _('Use this location'),
                )
              : null,
            h('button', { class: 'btn btn-sm', onclick: () => store.commit(_('Remove from library: {track}', { track: t.title || t.fileName }), [store.opRemoveTrack(t.id, _('Missing file'))]) }, _('Remove from library')),
          ),
        );
      }
      return h(
        'div',
        { class: `card ${relocatedTo || removed ? 'is-staged' : ''}` },
        h(
          'div',
          { class: 'card-head' },
          h('div', {}, h('strong', {}, t.title || t.fileName), h('span', { class: 'muted' }, t.artist ? ` · ${t.artist}` : '')),
          h('span', { class: 'muted small' }, crates.length ? _n(crates.length, 'In {n} crate', 'In {n} crates') : _('In no crate')),
        ),
        h('div', { class: 'path path-missing', title: t.path }, fmt.shortPath(t.path)),
        body,
      );
    });
    return [head, h('div', { class: 'cards' }, rows)];
  }

  /** Live library track already pointing at `path`, if any. */
  function libraryTrackAt(path) {
    const id = pathIndex().get(path);
    return id != null && !store.eff.removedTracks.has(id) ? id : null;
  }
  let _pathIndex = null;
  let _pathIndexFor = null;
  function pathIndex() {
    if (_pathIndexFor !== store.base) {
      _pathIndex = new Map([...store.base.tracks.values()].map((t) => [t.path, t.id]));
      _pathIndexFor = store.base;
    }
    return _pathIndex;
  }

  // Either merge into the library entry that already owns the file, or point this entry at it.
  function resolveOps(t, path) {
    const existing = libraryTrackAt(path);
    if (existing == null) return [{ ...store.opRelocate(t.id, path), missing: t.id }];
    const eff = store.eff;
    const have = new Set(eff.cratesOf.get(existing) || []);
    const ops = (eff.cratesOf.get(t.id) || []).filter((c) => !have.has(c)).map((c) => ({ ...store.opAdd(c, existing), missing: t.id }));
    ops.push({ ...store.opRemoveTrack(t.id, _('Merged into another record of the same file')), missing: t.id });
    return ops;
  }
  function resolve(t, path) {
    const merge = libraryTrackAt(path) != null;
    store.commit(merge ? _('Merge into existing record: {track}', { track: t.title || t.fileName }) : _('Relocate: {track}', { track: t.title || t.fileName }), resolveOps(t, path));
  }
  function resolveAll(list) {
    store.commit(_n(list.length, 'Fix {n} missing song (merge or relocate)', 'Fix {n} missing songs (merge or relocate)'), list.flatMap((t) => resolveOps(t, candidates[t.id][0].path)));
  }
  async function removeAll(list) {
    const ok = await confirmDialog({
      title: _n(list.length, 'Remove {n} missing song?', 'Remove {n} missing songs?'),
      message: _('This only goes into the plan (removed from the Serato library, no files deleted) and can be undone in Plan at any time.'),
      okText: _('Stage in plan'),
    });
    if (ok) store.commit(_n(list.length, 'Remove {n} missing song', 'Remove {n} missing songs'), list.map((t) => store.opRemoveTrack(t.id, _('Missing file'))));
  }

  // ---------- duplicates ----------
  function renderDupes() {
    const eff = store.eff;
    const base = store.base;
    // Include groups whose extra copies are already staged for removal, so they can be reverted.
    const staged = new Map();
    for (const op of store.findOps((o) => o.group)) {
      if (!staged.has(op.group)) staged.set(op.group, []);
      staged.get(op.group).push(op);
    }
    let groups = findDuplicates(eff, scoreOf).filter((g) => !dismissed.has(g.key) && !staged.has(g.key));
    if (closeLengthOnly) groups = groups.filter((g) => g.spreadMs <= 2000);

    const head = h(
      'div',
      { class: 'cleanup-intro' },
      h(
        'p',
        {},
        _('Finds duplicates by "artist + title". Pick the one to keep: the crates of the others are merged into it, then the others are removed from the library (files are not deleted).'),
        ' ',
        _('"…and Trash the other files" also moves their files to the Trash after Apply to Serato, so they cannot be imported again by mistake.'),
      ),
      h(
        'div',
        { class: 'toolbar' },
        h(
          'label',
          { class: 'check' },
          h('input', {
            type: 'checkbox',
            checked: closeLengthOnly,
            onchange: (e) => {
              closeLengthOnly = e.target.checked;
              prefs.set('dupes.closeLengthOnly', closeLengthOnly);
              render();
            },
          }),
          _('Only show songs within 2 s of each other in length (skips different versions such as Extended / Radio)'),
        ),
        dismissed.size
          ? h('button', {
              class: 'btn btn-ghost btn-sm',
              onclick: () => {
                dismissed = new Set();
                prefs.set('dupes.dismissed', []);
                render();
              },
            }, _n(dismissed.size, 'Show {n} dismissed group', 'Show {n} dismissed groups'))
          : null,
      ),
    );

    const stagedCards = [...staged].map(([key, ops]) => {
      const removed = ops.filter((o) => o.type === 'removeTrack').map((o) => base.tracks.get(o.asset));
      const nTrash = ops.filter((o) => o.type === 'removeTrack' && o.deleteFile).length;
      const keeper = base.tracks.get(ops.find((o) => o.keeper)?.keeper);
      return h(
        'div',
        { class: 'card is-staged' },
        h(
          'div',
          { class: 'staged' },
          h('span', { class: 'tag tag-ok' }, _('Staged')),
          ` ${_n(removed.length, 'keep {keeper}, remove {n} duplicate', 'keep {keeper}, remove {n} duplicates', { keeper: keeper ? _('{title} ({quality})', { title: keeper.title || keeper.fileName, quality: store.trackQuality(keeper).label }) : '' })}`,
          nTrash ? h('span', { class: 'tag tag-danger' }, _n(nTrash, '{n} file to the Trash', '{n} files to the Trash')) : null,
          h('button', { class: 'btn btn-ghost btn-xs', onclick: () => store.revertOps((op) => op.group === key) }, _('Cancel')),
        ),
      );
    });

    const owners = pathOwners();
    const cards = groups.map((g) => {
      // A remembered pick that has left the group (e.g. removed under Missing files) falls back to the suggestion.
      const picked = keepers.get(g.key);
      const keep = g.tracks.some((t) => t.id === picked) ? picked : g.keeper;
      const first = g.tracks[0];
      const trashable = trashableOthers(g, keep, owners);
      return h(
        'div',
        { class: 'card' },
        h(
          'div',
          { class: 'card-head' },
          h('div', {}, h('strong', {}, first.title || first.fileName), h('span', { class: 'muted' }, first.artist ? ` · ${first.artist}` : ''), ` (${g.tracks.length})`),
          g.spreadMs > 2000 ? h('span', { class: 'tag tag-warn', title: _('Different lengths, maybe different versions') }, _('{s} s apart', { s: Math.round(g.spreadMs / 1000) })) : null,
        ),
        h(
          'div',
          { class: 'dupe-rows' },
          g.tracks.map((t) => {
            const crates = eff.cratesOf.get(t.id) || [];
            return h(
              'label',
              { class: `dupe-row ${t.id === keep ? 'is-keep' : ''}` },
              h('input', {
                type: 'radio',
                name: `keep-${g.key}`,
                checked: t.id === keep,
                onchange: () => {
                  keepers.set(g.key, t.id);
                  render();
                },
              }),
              playBtn(`t${t.id}`, t),
              h('span', { class: 'dupe-fmt' }, qualityBadge(store.trackQuality(t), { compact: true })),
              h('span', { class: 'num' }, fmt.duration(t.lengthMs)),
              h('span', { class: 'num' }, fmt.bpm(t.bpm)),
              h('span', {}, t.key || '–'),
              h('span', { class: 'dupe-path', title: t.path }, fmt.shortPath(t.path), !t.exists ? h('span', { class: 'tag tag-danger' }, _('Missing file')) : null),
              h('span', { class: 'muted small', title: crates.map((c) => eff.pathOf(c)).join('\n') }, _('{crates} crates · {plays} plays', { crates: crates.length, plays: t.plays })),
            );
          }),
        ),
        h(
          'div',
          { class: 'row-actions' },
          h('button', { class: 'btn btn-sm btn-primary', onclick: () => mergeDupes(g, keep) }, _('Keep the selected one, merge the others')),
          trashable.length
            ? h(
                'button',
                {
                  class: 'btn btn-sm btn-danger-ghost',
                  title: `${_('After Apply to Serato succeeds, these files go to the macOS Trash (restorable):')}\n${trashable.map((t) => effectivePath(eff, t)).join('\n')}`,
                  onclick: () => mergeDupes(g, keep, { trash: true }),
                },
                _n(trashable.length, '…and Trash the other file', '…and Trash the other {n} files'),
              )
            : null,
          h('button', {
            class: 'btn btn-sm btn-ghost',
            onclick: () => {
              dismissed.add(g.key);
              prefs.set('dupes.dismissed', [...dismissed]);
              render();
            },
          }, _('Not duplicates')),
        ),
      );
    });
    return [head, h('div', { class: 'cards' }, stagedCards, cards.length ? cards : h('div', { class: 'empty' }, _('No duplicates 🎉')))];
  }

  /** pathKey -> ids of live tracks using that file (memoised per plan/snapshot version). */
  let _owners = null;
  let _ownersFor = -1;
  function pathOwners() {
    if (_ownersFor !== store.version) {
      _owners = new Map();
      for (const t of liveTracks(store.eff)) {
        const k = pathKey(effectivePath(store.eff, t));
        _owners.set(k, [...(_owners.get(k) || []), t.id]);
      }
      _ownersFor = store.version;
    }
    return _owners;
  }

  /**
   * The other tracks of a group whose files may go to the Trash: the file exists, lies inside the
   * scanned music folders (the server refuses anything else) and no record that stays in Serato uses it
   * (two records can point at the same file).
   */
  function trashableOthers(g, keepId, owners = pathOwners()) {
    const eff = store.eff;
    const roots = (store.folderScan?.roots || []).map((r) => `${pathKey(r)}/`);
    const leaving = new Set(g.tracks.filter((t) => t.id !== keepId).map((t) => t.id));
    return g.tracks.filter((t) => {
      if (!leaving.has(t.id) || (!t.exists && !eff.relocated.has(t.id))) return false;
      const k = pathKey(effectivePath(eff, t));
      if (!roots.some((r) => k.startsWith(r))) return false;
      return (owners.get(k) || []).every((id) => leaving.has(id));
    });
  }

  function mergeDupes(g, keepId, { trash = false } = {}) {
    if (!g.tracks.some((t) => t.id === keepId)) return; // never remove every copy
    const eff = store.eff;
    const keepCrates = new Set(eff.cratesOf.get(keepId) || []);
    const toTrash = new Set(trash ? trashableOthers(g, keepId).map((t) => t.id) : []);
    const ops = [];
    for (const t of g.tracks) {
      if (t.id === keepId) continue;
      for (const c of eff.cratesOf.get(t.id) || []) {
        if (!keepCrates.has(c)) {
          keepCrates.add(c);
          ops.push({ ...store.opAdd(c, keepId), group: g.key, keeper: keepId });
        }
      }
      ops.push({ ...store.opRemoveTrack(t.id, _('Duplicate'), { deleteFile: toTrash.has(t.id) }), group: g.key, keeper: keepId });
    }
    const keeper = store.base.tracks.get(keepId);
    const label = _('Merge duplicates: {title} (keep {quality})', { title: keeper.title || keeper.fileName, quality: store.trackQuality(keeper).label });
    store.commit(toTrash.size ? `${label}${_n(toTrash.size, ', {n} file to the Trash', ', {n} files to the Trash')}` : label, ops);
  }

  // ---------- empty crates ----------
  function renderEmpty() {
    const eff = store.eff;
    const list = findEmptyCrates(eff).sort((a, b) => eff.pathOf(a).localeCompare(eff.pathOf(b)));
    for (const id of emptySelected) if (!list.includes(id)) emptySelected.delete(id);
    const head = h(
      'div',
      { class: 'cleanup-intro' },
      h('p', {}, _('Crates with no songs and no child crates. Placeholder crates such as an "Opening" crate can stay; tick only the ones to delete.')),
      h(
        'div',
        { class: 'toolbar' },
        h('button', {
          class: 'btn btn-sm',
          onclick: () => {
            if (emptySelected.size === list.length) emptySelected.clear();
            else list.forEach((id) => emptySelected.add(id));
            render();
          },
        }, emptySelected.size === list.length && list.length ? _('Select none') : _('Select all')),
        h('button', { class: 'btn btn-sm btn-danger', disabled: !emptySelected.size, onclick: deleteSelected }, _('Delete selected ({n})', { n: emptySelected.size })),
      ),
    );
    const rows = list.map((id) =>
      h(
        'label',
        { class: 'list-row' },
        h('input', {
          type: 'checkbox',
          checked: emptySelected.has(id),
          onchange: (e) => {
            if (e.target.checked) emptySelected.add(id);
            else emptySelected.delete(id);
            render();
          },
        }),
        h('span', { class: 'grow' }, eff.pathOf(id)),
        eff.crates.get(id).status?.created ? h('span', { class: 'tag tag-new' }, _('Created')) : null,
      ),
    );
    return [head, h('div', { class: 'list' }, rows.length ? rows : h('div', { class: 'empty' }, _('No empty crates')))];
  }

  function deleteSelected() {
    const ids = [...emptySelected];
    emptySelected.clear();
    store.commit(_n(ids.length, 'Delete {n} empty crate', 'Delete {n} empty crates'), ids.map((id) => store.opDelete(id)));
  }

  function render() {
    renderTabs();
    const scrollTop = bodyEl.scrollTop;
    const content = tab === 'missing' ? renderMissing() : tab === 'dupes' ? renderDupes() : renderEmpty();
    clear(bodyEl, h('div', { class: 'cleanup-inner' }, content));
    bodyEl.scrollTop = scrollTop;
  }

  render();
  return {
    el,
    title: _('Cleanup'),
    update: render,
    onKey(e) {
      if (e.key === ' ') {
        player.toggle();
        return true;
      }
      return false;
    },
    destroy: offPlayer,
  };
}
