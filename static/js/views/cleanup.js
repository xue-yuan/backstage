// Cleanup view: missing files (relocate / remove), duplicates (merge into a keeper), empty crates.
import { effectivePath, findDuplicates, findEmptyCrates, findUncategorized, liveTracks, pathKey } from '../model.js';
import { player } from '../player.js';
import { qualityBadge, qualityScore } from '../quality.js';
import { showSpectrum, spectrumAvailable } from '../spectrogram.js';
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
  let qualityDiffOnly = prefs.get('dupes.qualityDiffOnly', false);
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
      seg('missing', _('common.missingFiles'), missingOpen),
      seg('dupes', _('common.duplicates'), dupes),
      seg('empty', _('common.emptyCrates'), empty),
      h(
        'button',
        {
          class: 'seg',
          title: _('cleanup.openInSort'),
          onclick: () => {
            prefs.set('inbox.source', { kind: 'uncategorized' });
            navigate('inbox');
          },
        },
        _('common.inNoCrate'),
        h('span', { class: 'count' }, uncategorized),
        ' →',
      ),
    );
  }

  function playBtn(key, track) {
    return h(
      'button',
      { class: 'icon-btn', dataset: { playKey: key }, title: _('common.preview'), onclick: () => player.toggle(track) },
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
        _n(list.length, 'cleanup.missingIntro'),
        _('cleanup.mergeExplanation'),
      ),
      scanning ? h('p', { class: 'muted' }, _('common.scanning')) : null,
      scanError ? h('p', { class: 'notice notice-danger' }, _('common.scanFailed', { error: scanError })) : null,
      candidates
        ? h(
            'div',
            { class: 'toolbar' },
            h('button', { class: 'btn btn-primary', disabled: !single.length, onclick: () => resolveAll(single) }, _n(single.length, 'cleanup.applyAllUnique')),
            h('button', { class: 'btn', disabled: !none.length, onclick: () => removeAll(none) }, _n(none.length, 'cleanup.removeWithoutCandidate')),
            h('button', { class: 'btn btn-ghost', onclick: scan }, _('cleanup.scanAgain')),
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
          h('span', { class: 'tag tag-ok' }, _('cleanup.inPlan')),
          relocatedTo ? ` ${_('cleanup.movedTo', { path: fmt.shortPath(relocatedTo) })}` : ` ${_('cleanup.removedFromLibrary', { reason: eff.removedTracks.get(t.id) || _('common.missingFile') })}`,
          h('button', {
            class: 'btn btn-ghost btn-xs',
            onclick: () => store.revertOps((op) => op.missing === t.id || ((op.type === 'relocate' || op.type === 'removeTrack') && op.asset === t.id)),
          }, _('common.cancel')),
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
                    playBtn(`f${c.path}`, { playKey: `f${c.path}`, src: `/api/audio-file?path=${encodeURIComponent(c.path)}`, title: t.title || t.fileName, artist: _('cleanup.candidateFile') }),
                    h('span', { class: 'cand-path', title: c.path }, fmt.shortPath(c.path)),
                    libraryTrackAt(c.path) != null ? h('span', { class: 'tag tag-edit', title: _('cleanup.hasOtherRecord') }, _('cleanup.inLibrary')) : null,
                    h('span', { class: 'muted small' }, `${fmt.size(c.size)} · ${fmt.date(c.modifiedAt)}`),
                  ),
                ),
              )
            : candidates
              ? h('div', { class: 'muted small' }, _('cleanup.noCandidate'))
              : null,
          h(
            'div',
            { class: 'row-actions' },
            cands.length
              ? h(
                  'button',
                  { class: 'btn btn-sm btn-primary', onclick: () => resolve(t, pick) },
                  libraryTrackAt(pick) != null ? _('cleanup.mergeIntoRecord') : _('cleanup.useLocation'),
                )
              : null,
            h('button', { class: 'btn btn-sm', onclick: () => store.commit(_('cleanup.removeTrackChange', { track: t.title || t.fileName }), [store.opRemoveTrack(t.id, _('common.missingFile'))]) }, _('cleanup.removeFromLibrary')),
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
          h('span', { class: 'muted small' }, crates.length ? _n(crates.length, 'common.inCrateCount') : _('common.inNoCrate')),
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
    ops.push({ ...store.opRemoveTrack(t.id, _('cleanup.mergedNote')), missing: t.id });
    return ops;
  }
  function resolve(t, path) {
    const merge = libraryTrackAt(path) != null;
    store.commit(merge ? _('cleanup.mergeChange', { track: t.title || t.fileName }) : _('cleanup.relocateChange', { track: t.title || t.fileName }), resolveOps(t, path));
  }
  function resolveAll(list) {
    store.commit(_n(list.length, 'cleanup.fixMissingChange'), list.flatMap((t) => resolveOps(t, candidates[t.id][0].path)));
  }
  async function removeAll(list) {
    const ok = await confirmDialog({
      title: _n(list.length, 'cleanup.removeMissingConfirm'),
      message: _('cleanup.removeMissingWarning'),
      okText: _('common.addToPlan'),
    });
    if (ok) store.commit(_n(list.length, 'cleanup.removeMissing'), list.map((t) => store.opRemoveTrack(t.id, _('common.missingFile'))));
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
    if (qualityDiffOnly) groups = groups.filter((g) => bestQuality(g) != null);
    const keepOf = (g) => {
      // A remembered pick that has left the group (e.g. removed under Missing files) falls back to the suggestion.
      const picked = keepers.get(g.key);
      return g.tracks.some((t) => t.id === picked) ? picked : g.keeper;
    };
    const sameVersion = groups.filter((g) => g.spreadMs <= 2000);

    const head = h(
      'div',
      { class: 'cleanup-intro' },
      h(
        'p',
        {},
        _('cleanup.duplicatesIntro'),
        ' ',
        _('cleanup.mergeAndTrashNote'),
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
          _('cleanup.sameLengthOnly'),
        ),
        h(
          'label',
          { class: 'check' },
          h('input', {
            type: 'checkbox',
            checked: qualityDiffOnly,
            onchange: (e) => {
              qualityDiffOnly = e.target.checked;
              prefs.set('dupes.qualityDiffOnly', qualityDiffOnly);
              render();
            },
          }),
          _('cleanup.qualityDiffersOnly'),
        ),
        dismissed.size
          ? h('button', {
              class: 'btn btn-ghost btn-sm',
              onclick: () => {
                dismissed = new Set();
                prefs.set('dupes.dismissed', []);
                render();
              },
            }, _n(dismissed.size, 'cleanup.showDismissedGroups'))
          : null,
      ),
      sameVersion.length > 1
        ? h(
            'div',
            { class: 'toolbar' },
            h('button', { class: 'btn btn-sm btn-primary', onclick: () => mergeAll(sameVersion, keepOf, groups.length - sameVersion.length) }, _n(sameVersion.length, 'cleanup.mergeAllGroups')),
            h('button', { class: 'btn btn-sm btn-danger-ghost', onclick: () => mergeAll(sameVersion, keepOf, groups.length - sameVersion.length, { trash: true }) }, _('cleanup.mergeAllAndTrash')),
            groups.length > sameVersion.length
              ? h('span', { class: 'muted small' }, _n(groups.length - sameVersion.length, 'cleanup.lengthSkipped'))
              : null,
          )
        : null,
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
          h('span', { class: 'tag tag-ok' }, _('cleanup.inPlan')),
          ` ${_n(removed.length, 'cleanup.groupSummary', { keeper: keeper ? _('cleanup.keeperLabel', { title: keeper.title || keeper.fileName, quality: store.trackQuality(keeper).label }) : '' })}`,
          nTrash ? h('span', { class: 'tag tag-danger' }, _n(nTrash, 'cleanup.filesToTrash')) : null,
          h('button', { class: 'btn btn-ghost btn-xs', onclick: () => store.revertOps((op) => op.group === key) }, _('common.cancel')),
        ),
      );
    });

    const owners = pathOwners();
    const cards = groups.map((g) => {
      const keep = keepOf(g);
      const best = bestQuality(g);
      const first = g.tracks[0];
      const trashable = trashableOthers(g, keep, owners);
      return h(
        'div',
        { class: 'card' },
        h(
          'div',
          { class: 'card-head' },
          h('div', {}, h('strong', {}, first.title || first.fileName), h('span', { class: 'muted' }, first.artist ? ` · ${first.artist}` : ''), ` (${g.tracks.length})`),
          g.spreadMs > 2000 ? h('span', { class: 'tag tag-warn', title: _('cleanup.lengthsDiffer') }, _('cleanup.lengthGap', { s: Math.round(g.spreadMs / 1000) })) : null,
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
              h('span', { class: 'dupe-fmt' }, qualityBadge(store.trackQuality(t), { compact: true }), best != null && scoreOf(t) === best ? h('span', { class: 'tag tag-ok' }, _('cleanup.bestQuality')) : null),
              h('span', { class: 'num' }, fmt.duration(t.lengthMs)),
              h('span', { class: 'num' }, fmt.bpm(t.bpm)),
              h('span', {}, t.key || '–'),
              h('span', { class: 'dupe-path', title: t.path }, fmt.shortPath(t.path), !t.exists ? h('span', { class: 'tag tag-danger' }, _('common.missingFile')) : null),
              h('span', { class: 'muted small', title: crates.map((c) => eff.pathOf(c)).join('\n') }, _('cleanup.cratesAndPlays', { crates: crates.length, plays: t.plays })),
              spectrumAvailable() && t.exists
                ? h('button', {
                    class: 'btn btn-ghost btn-xs',
                    title: _('common.spectrumHint'),
                    onclick: (e) => {
                      e.preventDefault(); // inside the row's label: do not pick this copy
                      showSpectrum({ path: effectivePath(eff, t), title: t.title || t.fileName, quality: store.trackQuality(t) });
                    },
                  }, _('common.spectrum'))
                : h('span'),
            );
          }),
        ),
        h(
          'div',
          { class: 'row-actions' },
          h('button', { class: 'btn btn-sm btn-primary', onclick: () => mergeDupes(g, keep) }, _('cleanup.mergeGroup')),
          trashable.length
            ? h(
                'button',
                {
                  class: 'btn btn-sm btn-danger-ghost',
                  title: `${_('cleanup.trashListTitle')}\n${trashable.map((t) => effectivePath(eff, t)).join('\n')}`,
                  onclick: () => mergeDupes(g, keep, { trash: true }),
                },
                _n(trashable.length, 'cleanup.mergeAndTrashOthers'),
              )
            : null,
          h('button', {
            class: 'btn btn-sm btn-ghost',
            onclick: () => {
              dismissed.add(g.key);
              prefs.set('dupes.dismissed', [...dismissed]);
              render();
            },
          }, _('cleanup.notDuplicates')),
        ),
      );
    });
    return [head, h('div', { class: 'cards' }, stagedCards, cards.length ? cards : h('div', { class: 'empty' }, _('cleanup.noDuplicates')))];
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

  /** The best quality score in a group, or null when every copy has the same quality (or it is unknown). */
  function bestQuality(g) {
    const scores = g.tracks.map(scoreOf);
    if (scores.some((s) => s == null)) return null;
    const best = Math.max(...scores);
    return scores.some((s) => s !== best) ? best : null;
  }

  /** Ops merging a group into keepId: its crates move to the keeper, the others leave the library. */
  function dupeOps(g, keepId, { trash = false, owners } = {}) {
    if (!g.tracks.some((t) => t.id === keepId)) return { ops: [], trashed: 0 }; // never remove every copy
    const eff = store.eff;
    const keepCrates = new Set(eff.cratesOf.get(keepId) || []);
    const toTrash = new Set(trash ? trashableOthers(g, keepId, owners).map((t) => t.id) : []);
    const ops = [];
    for (const t of g.tracks) {
      if (t.id === keepId) continue;
      for (const c of eff.cratesOf.get(t.id) || []) {
        if (!keepCrates.has(c)) {
          keepCrates.add(c);
          ops.push({ ...store.opAdd(c, keepId), group: g.key, keeper: keepId });
        }
      }
      ops.push({ ...store.opRemoveTrack(t.id, _('cleanup.duplicate'), { deleteFile: toTrash.has(t.id) }), group: g.key, keeper: keepId });
    }
    return { ops, trashed: toTrash.size };
  }

  const withTrash = (label, n) => (n ? `${label}${_n(n, 'cleanup.filesToTrashSuffix')}` : label);

  function mergeDupes(g, keepId, { trash = false } = {}) {
    const { ops, trashed } = dupeOps(g, keepId, { trash });
    if (!ops.length) return;
    const keeper = store.base.tracks.get(keepId);
    store.commit(withTrash(_('cleanup.mergeDuplicatesChange', { title: keeper.title || keeper.fileName, quality: store.trackQuality(keeper).label }), trashed), ops);
  }

  // Merge every listed group at once, each keeping its selected copy. One change in the plan; each
  // group can still be undone on its own from the plan summary.
  async function mergeAll(list, keepOf, skipped, { trash = false } = {}) {
    const owners = pathOwners();
    const parts = list.map((g) => dupeOps(g, keepOf(g), { trash, owners }));
    const ops = parts.flatMap((p) => p.ops);
    const removed = ops.filter((o) => o.type === 'removeTrack').length;
    const trashed = parts.reduce((n, p) => n + p.trashed, 0);
    if (!ops.length) return;
    const ok = await confirmDialog({
      title: _n(list.length, 'cleanup.mergeGroupsConfirm'),
      message: [
        _n(removed, 'cleanup.mergeRemovesCopies'),
        trashed ? _n(trashed, 'cleanup.mergeTrashesFiles') : null,
        skipped ? _n(skipped, 'cleanup.mergeSkipsGroups') : null,
        _('cleanup.mergeUndoNote'),
      ].filter(Boolean).join(' '),
      okText: trash ? _('cleanup.mergeAndTrash') : _('cleanup.mergeAll'),
      danger: trash,
    });
    if (ok) store.commit(withTrash(_n(list.length, 'cleanup.mergeGroupsChange'), trashed), ops);
  }

  // ---------- empty crates ----------
  function renderEmpty() {
    const eff = store.eff;
    const list = findEmptyCrates(eff).sort((a, b) => eff.pathOf(a).localeCompare(eff.pathOf(b)));
    for (const id of emptySelected) if (!list.includes(id)) emptySelected.delete(id);
    const head = h(
      'div',
      { class: 'cleanup-intro' },
      h('p', {}, _('cleanup.emptyIntro')),
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
        }, emptySelected.size === list.length && list.length ? _('cleanup.selectNone') : _('cleanup.selectAll')),
        h('button', { class: 'btn btn-sm btn-danger', disabled: !emptySelected.size, onclick: deleteSelected }, _('cleanup.deleteSelected', { n: emptySelected.size })),
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
        eff.crates.get(id).status?.created ? h('span', { class: 'tag tag-new' }, _('cleanup.created')) : null,
      ),
    );
    return [head, h('div', { class: 'list' }, rows.length ? rows : h('div', { class: 'empty' }, _('cleanup.noEmptyCrates')))];
  }

  function deleteSelected() {
    const ids = [...emptySelected];
    emptySelected.clear();
    store.commit(_n(ids.length, 'cleanup.deleteEmptyCrates'), ids.map((id) => store.opDelete(id)));
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
    title: _('tab.cleanup'),
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
