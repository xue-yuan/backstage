// Cleanup view: missing files (relocate / remove), duplicates (merge into a keeper), empty crates.
import { findDuplicates, findEmptyCrates, findUncategorized } from '../model.js';
import { player } from '../player.js';
import { qualityBadge, qualityScore } from '../quality.js';
import { api, store } from '../store.js';
import { clear, confirmDialog, fmt, h, prefs } from '../ui.js';

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
      seg('missing', '找不到檔案', missingOpen),
      seg('dupes', '重複曲目', dupes),
      seg('empty', '空的 crate', empty),
      h(
        'button',
        {
          class: 'seg',
          title: '到「分類新歌」處理',
          onclick: () => {
            prefs.set('inbox.source', { kind: 'uncategorized' });
            navigate('inbox');
          },
        },
        '不在任何 crate',
        h('span', { class: 'count' }, uncategorized),
        ' →',
      ),
    );
  }

  function playBtn(key, track) {
    return h(
      'button',
      { class: 'icon-btn', dataset: { playKey: key }, title: '試聽', onclick: () => player.toggle(track) },
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
        `Serato 資料庫裡有 ${list.length} 首歌在硬碟上找不到。我在 ~/Music 裡找同檔名的檔案當作候選位置。`,
        '如果候選檔案在 Serato 裡已經有另一筆記錄（通常是搬過資料夾後重新匯入），就把這首的 crate 合併到那一筆，而不是再建一筆指向同一個檔案。',
      ),
      scanning ? h('p', { class: 'muted' }, '掃描中…') : null,
      scanError ? h('p', { class: 'notice notice-danger' }, `掃描失敗：${scanError}`) : null,
      candidates
        ? h(
            'div',
            { class: 'toolbar' },
            h('button', { class: 'btn btn-primary', disabled: !single.length, onclick: () => resolveAll(single) }, `套用所有唯一候選（${single.length} 首）`),
            h('button', { class: 'btn', disabled: !none.length, onclick: () => removeAll(none) }, `移除找不到候選的（${none.length} 首）`),
            h('button', { class: 'btn btn-ghost', onclick: scan }, '重新掃描'),
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
      const pick = chosen.get(t.id) ?? cands[0]?.path;
      const crates = store.base.baseCratesOf.get(t.id) || [];
      let body;
      if (relocatedTo || removed) {
        body = h(
          'div',
          { class: 'staged' },
          h('span', { class: 'tag tag-ok' }, '已排入計畫'),
          relocatedTo ? ` 改到 ${fmt.shortPath(relocatedTo)}` : ` 從資料庫移除（${eff.removedTracks.get(t.id) || '找不到檔案'}）`,
          h('button', {
            class: 'btn btn-ghost btn-xs',
            onclick: () => store.revertOps((op) => op.missing === t.id || ((op.type === 'relocate' || op.type === 'removeTrack') && op.asset === t.id)),
          }, '取消'),
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
                    playBtn(`f${c.path}`, { key: `f${c.path}`, src: `/api/audio-file?path=${encodeURIComponent(c.path)}`, title: t.title || t.fileName, artist: '候選檔案' }),
                    h('span', { class: 'cand-path', title: c.path }, fmt.shortPath(c.path)),
                    libraryTrackAt(c.path) != null ? h('span', { class: 'tag tag-edit', title: '這個檔案在 Serato 裡已經有另一筆記錄' }, '已在資料庫') : null,
                    h('span', { class: 'muted small' }, `${fmt.size(c.size)} · ${fmt.date(c.modifiedAt)}`),
                  ),
                ),
              )
            : candidates
              ? h('div', { class: 'muted small' }, '找不到同檔名的檔案')
              : null,
          h(
            'div',
            { class: 'row-actions' },
            cands.length
              ? h(
                  'button',
                  { class: 'btn btn-sm btn-primary', onclick: () => resolve(t, pick) },
                  libraryTrackAt(pick) != null ? '合併到資料庫裡那一筆' : '使用這個位置',
                )
              : null,
            h('button', { class: 'btn btn-sm', onclick: () => store.commit(`從資料庫移除：${t.title || t.fileName}`, [store.opRemoveTrack(t.id, '找不到檔案')]) }, '從資料庫移除'),
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
          h('span', { class: 'muted small' }, crates.length ? `在 ${crates.length} 個 crate` : '不在任何 crate'),
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
    ops.push({ ...store.opRemoveTrack(t.id, '已合併到同一個檔案的另一筆記錄'), missing: t.id });
    return ops;
  }
  function resolve(t, path) {
    const merge = libraryTrackAt(path) != null;
    store.commit(`${merge ? '合併到現有記錄' : '重新指定位置'}：${t.title || t.fileName}`, resolveOps(t, path));
  }
  function resolveAll(list) {
    store.commit(`處理 ${list.length} 首找不到的歌（合併或重新指定位置）`, list.flatMap((t) => resolveOps(t, candidates[t.id][0].path)));
  }
  async function removeAll(list) {
    const ok = await confirmDialog({
      title: `移除 ${list.length} 首找不到的歌？`,
      message: '只會排入變更計畫（從 Serato 資料庫移除、不刪任何檔案），隨時可以在「變更計畫」復原。',
      okText: '排入計畫',
    });
    if (ok) store.commit(`移除 ${list.length} 首找不到的歌`, list.map((t) => store.opRemoveTrack(t.id, '找不到檔案')));
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
      h('p', {}, '依「歌手 + 歌名」找出重複的曲目。選一首要保留的，其他首的 crate 會合併到保留的那首，然後從資料庫移除（不刪檔案）。'),
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
          '只顯示長度差 2 秒內的（排除 Extended / Radio 等不同版本）',
        ),
        dismissed.size
          ? h('button', {
              class: 'btn btn-ghost btn-sm',
              onclick: () => {
                dismissed = new Set();
                prefs.set('dupes.dismissed', []);
                render();
              },
            }, `顯示已忽略的 ${dismissed.size} 組`)
          : null,
      ),
    );

    const stagedCards = [...staged].map(([key, ops]) => {
      const removed = ops.filter((o) => o.type === 'removeTrack').map((o) => base.tracks.get(o.asset));
      const keeper = base.tracks.get(ops.find((o) => o.keeper)?.keeper);
      return h(
        'div',
        { class: 'card is-staged' },
        h(
          'div',
          { class: 'staged' },
          h('span', { class: 'tag tag-ok' }, '已排入計畫'),
          ` 保留 ${keeper ? `${keeper.title || keeper.fileName}（${store.trackQuality(keeper).label}）` : ''}，移除 ${removed.length} 首重複`,
          h('button', { class: 'btn btn-ghost btn-xs', onclick: () => store.revertOps((op) => op.group === key) }, '取消'),
        ),
      );
    });

    const cards = groups.map((g) => {
      const keep = keepers.get(g.key) ?? g.keeper;
      const first = g.tracks[0];
      return h(
        'div',
        { class: 'card' },
        h(
          'div',
          { class: 'card-head' },
          h('div', {}, h('strong', {}, first.title || first.fileName), h('span', { class: 'muted' }, first.artist ? ` · ${first.artist}` : ''), ` (${g.tracks.length})`),
          g.spreadMs > 2000 ? h('span', { class: 'tag tag-warn', title: '長度不同，可能是不同版本' }, `長度差 ${Math.round(g.spreadMs / 1000)} 秒`) : null,
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
              h('span', { class: 'dupe-path', title: t.path }, fmt.shortPath(t.path), !t.exists ? h('span', { class: 'tag tag-danger' }, '找不到檔案') : null),
              h('span', { class: 'muted small', title: crates.map((c) => eff.pathOf(c)).join('\n') }, `${crates.length} crate · 播 ${t.plays}`),
            );
          }),
        ),
        h(
          'div',
          { class: 'row-actions' },
          h('button', { class: 'btn btn-sm btn-primary', onclick: () => mergeDupes(g, keep) }, '保留選取的，合併其他'),
          h('button', {
            class: 'btn btn-sm btn-ghost',
            onclick: () => {
              dismissed.add(g.key);
              prefs.set('dupes.dismissed', [...dismissed]);
              render();
            },
          }, '不是重複'),
        ),
      );
    });
    return [head, h('div', { class: 'cards' }, stagedCards, cards.length ? cards : h('div', { class: 'empty' }, '沒有重複的曲目 🎉'))];
  }

  function mergeDupes(g, keepId) {
    const eff = store.eff;
    const keepCrates = new Set(eff.cratesOf.get(keepId) || []);
    const ops = [];
    for (const t of g.tracks) {
      if (t.id === keepId) continue;
      for (const c of eff.cratesOf.get(t.id) || []) {
        if (!keepCrates.has(c)) {
          keepCrates.add(c);
          ops.push({ ...store.opAdd(c, keepId), group: g.key, keeper: keepId });
        }
      }
      ops.push({ ...store.opRemoveTrack(t.id, '重複'), group: g.key, keeper: keepId });
    }
    const keeper = store.base.tracks.get(keepId);
    store.commit(`合併重複：${keeper.title || keeper.fileName}（保留 ${store.trackQuality(keeper).label}）`, ops);
  }

  // ---------- empty crates ----------
  function renderEmpty() {
    const eff = store.eff;
    const list = findEmptyCrates(eff).sort((a, b) => eff.pathOf(a).localeCompare(eff.pathOf(b)));
    for (const id of emptySelected) if (!list.includes(id)) emptySelected.delete(id);
    const head = h(
      'div',
      { class: 'cleanup-intro' },
      h('p', {}, '沒有歌、也沒有子 crate 的 crate。像「開場」這種預留的分類可以留著，勾選要刪的就好。'),
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
        }, emptySelected.size === list.length && list.length ? '全部取消' : '全選'),
        h('button', { class: 'btn btn-sm btn-danger', disabled: !emptySelected.size, onclick: deleteSelected }, `刪除選取的（${emptySelected.size}）`),
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
        eff.crates.get(id).status?.created ? h('span', { class: 'tag tag-new' }, '新建') : null,
      ),
    );
    return [head, h('div', { class: 'list' }, rows.length ? rows : h('div', { class: 'empty' }, '沒有空的 crate'))];
  }

  function deleteSelected() {
    const ids = [...emptySelected];
    emptySelected.clear();
    store.commit(`刪除 ${ids.length} 個空的 crate`, ids.map((id) => store.opDelete(id)));
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
    title: '清理',
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
