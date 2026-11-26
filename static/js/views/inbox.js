// Sort view: pick a source (uncategorised / recent / an inbox crate / a disk folder), listen, assign crates fast.
import { createCratePicker, pickCrateDialog } from '../cratePicker.js';
import { addedInPlan, baseName, effectivePath, isClassified, liveTracks, pathKey, suggestCrates, trackMatches } from '../model.js';
import { player } from '../player.js';
import { qualityBadge } from '../quality.js';
import { store } from '../store.js';
import { clear, fmt, h, prefs, VirtualList } from '../ui.js';

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
    placeholder: '篩選歌名、歌手、曲風…',
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
    h('option', { value: 'added' }, '新加入的在前'),
    h('option', { value: 'order' }, 'crate 原本順序'),
    h('option', { value: 'bpm' }, 'BPM'),
    h('option', { value: 'artist' }, '歌手'),
    h('option', { value: 'title' }, '歌名'),
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
    h('div', { class: 'toolbar' }, filterInput, sortSelect, h('label', { class: 'check' }, hideDoneBox, '隱藏已分類')),
    h(
      'div',
      { class: 'trow trow-head' },
      h('span'),
      h('span', {}, '歌名 / 歌手'),
      h('span', { class: 'num' }, 'BPM'),
      h('span', {}, 'Key'),
      h('span', {}, '曲風'),
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
    placeholder: '加入其他 crate…（按 / ）可輸入「上層 / 新名稱」建立',
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
    '加入時同時從來源 crate 移出',
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
      '加入後自動跳下一首（正在播放就接著播）',
    ),
    moveOutRow,
    h('div', { class: 'muted small' }, 'X：不要這首（排進變更計畫，套用到 Serato 時才會移除並把檔案丟到垃圾桶）'),
  );
  const detailEl = h(
    'aside',
    { class: 'panel inbox-detail' },
    infoEl,
    currentEl,
    pinnedEl,
    suggestEl,
    h('div', { class: 'detail-section' }, h('div', { class: 'section-label' }, '加入其他 crate'), picker.el),
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
      h('div', { class: 'section-label' }, '來源'),
      item({ kind: 'uncategorized' }, '不在任何 crate', uncategorized.length, left !== uncategorized.length ? `剩 ${left}` : ''),
      item({ kind: 'recent', days: 7 }, '最近 7 天加入', recent(7)),
      item({ kind: 'recent', days: 30 }, '最近 30 天加入', recent(30)),
      source.kind === 'folder'
        ? [h('div', { class: 'section-label' }, '從資料夾整理'), item(source, baseName(source.path), sourceList().length, fmt.shortPath(source.path).replace(/\/[^/]*$/, ''))]
        : null,
      navigate
        ? h('button', { class: 'btn btn-ghost btn-block', onclick: () => navigate('folders') }, source.kind === 'folder' ? '選擇其他資料夾…' : '從資料夾選…')
        : null,
      h('div', { class: 'section-label' }, '從 crate 整理'),
      inboxCrates.map((id) => item({ kind: 'crate', id }, eff.pathOf(id), (eff.members.get(id) || []).length)),
      h(
        'button',
        {
          class: 'btn btn-ghost btn-block',
          onclick: async () => {
            const id = await pickCrateDialog({ title: '要整理哪個 crate？', allowCreate: false });
            if (id != null) setSource({ kind: 'crate', id });
          },
        },
        '選擇其他 crate…',
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
        ? '不在任何 crate 的歌'
        : source.kind === 'recent'
          ? `最近 ${source.days} 天加入`
          : source.kind === 'folder'
            ? `資料夾：${baseName(source.path)}`
            : eff.pathOf(source.id);
    clear(listTitle, h('h2', {}, title));
    progress.firstChild.style.width = all.length ? `${(doneCount / all.length) * 100}%` : '0%';
    progressText.textContent = `已分類 ${doneCount} / ${all.length}`;
    moveOutRow.hidden = source.kind !== 'crate';
    vlist.setItems(items, h('div', { class: 'empty' }, filter ? '沒有符合篩選的歌' : '這裡沒有歌了 🎉'));
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
        h('div', { class: 'trow-title' }, t.title || t.fileName, !t.exists ? h('span', { class: 'tag tag-danger' }, '找不到檔案') : null),
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
      clear(infoEl, h('div', { class: 'empty' }, '選一首歌開始分類'));
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
        (playBtn = h('button', { class: 'play-big', title: '播放 / 暫停（空白鍵）', onclick: () => player.toggle(t) }, player.isCurrent(`t${t.id}`) && player.playing ? '❚❚' : '▶')),
        h('div', {}, h('h3', {}, t.title || t.fileName), h('div', { class: 'muted' }, [t.artist, t.remixer && `Remix: ${t.remixer}`].filter(Boolean).join(' · ') || '未知歌手')),
      ),
      h(
        'dl',
        { class: 'meta' },
        meta('BPM', fmt.bpm(t.bpm)),
        meta('Key', t.key || '–'),
        meta('長度', fmt.duration(t.lengthMs)),
        meta('格式', qualityBadge(store.trackQuality(t))),
        meta('曲風', t.genre || '–'),
        meta('加入', fmt.date(t.addedAt)),
        meta('播放', t.plays ? `${t.plays} 次` : '沒放過'),
        meta('專輯', t.album || '–'),
      ),
      h('div', { class: 'path', title: t.path }, fmt.shortPath(t.path)),
      !t.exists ? h('div', { class: 'notice notice-danger' }, '硬碟上找不到這個檔案，可到「清理」重新指定位置。') : null,
    );

    const crates = eff.cratesOf.get(t.id) || [];
    const gained = new Set(addedInPlan(eff, t.id));
    clear(
      currentEl,
      h('div', { class: 'section-label' }, `目前在 ${crates.length} 個 crate`),
      crates.length
        ? h(
            'div',
            { class: 'chips' },
            crates.map((c) =>
              h(
                'span',
                { class: `chip ${gained.has(c) ? 'chip-new' : ''}`, title: gained.has(c) ? '這次新加入（尚未寫入 Serato）' : '' },
                eff.pathOf(c),
                h('button', { class: 'chip-x', title: '從這個 crate 移除', onclick: () => toggleCrate(c) }, '×'),
              ),
            ),
          )
        : h('div', { class: 'muted small' }, '還沒有放進任何 crate'),
    );

    pinned = pinned.filter((id) => eff.crates.has(id));
    const inSet = new Set(crates);
    clear(
      pinnedEl,
      h(
        'div',
        { class: 'section-label row-between' },
        '快捷 crate（數字鍵 1–9）',
        pinned.length < 9 ? h('button', { class: 'btn btn-ghost btn-xs', onclick: addPin }, '+ 釘選') : null,
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
                  title: '取消釘選',
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
        : h('div', { class: 'muted small' }, '把常用的目標 crate 釘在這裡，按數字鍵就能加入。'),
    );

    suggestions = suggestCrates(eff, store.profiles, t, { exclude: new Set(inboxCrateIds()) });
    clear(
      suggestEl,
      h('div', { class: 'section-label' }, '建議（Shift + 數字）'),
      suggestions.length
        ? h(
            'div',
            { class: 'targets' },
            suggestions.map((s, i) =>
              h(
                'div',
                { class: 'target target-suggest', onclick: () => toggleCrate(s.id, { forceAdd: true }) },
                h('kbd', {}, `⇧${i + 1}`),
                h('span', { class: 'target-name' }, eff.pathOf(s.id), h('span', { class: 'target-why' }, s.reasons.join('・'))),
                !pinned.includes(s.id) && pinned.length < 9
                  ? h('button', {
                      class: 'target-unpin',
                      title: '釘選',
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
        : h('div', { class: 'muted small' }, '沒有把握的建議（這首歌缺少曲風、BPM 等資訊）'),
    );
  }

  function meta(label, value) {
    return [h('dt', {}, label), h('dd', {}, value)];
  }

  async function addPin() {
    const id = await pickCrateDialog({ title: '釘選 crate', exclude: new Set(pinned) });
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
      store.commit(`「${name}」移出 ${eff.pathOf(crateId)}`, [store.opRemove(crateId, t.id)]);
      return;
    }
    if (inIt) return;
    const ops = [store.opAdd(crateId, t.id)];
    const leaveSource =
      moveOut && source.kind === 'crate' && source.id !== crateId && (eff.members.get(source.id) || []).includes(t.id);
    if (leaveSource) ops.push(store.opRemove(source.id, t.id));
    const change = store.commit(`「${name}」→ ${eff.pathOf(crateId)}${leaveSource ? '（已移出來源）' : ''}`, ops);
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
    if (!store.commit(`不要：${t.title || t.fileName}`, [store.opReject(t.id)])) return;
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
    title: '分類新歌',
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
