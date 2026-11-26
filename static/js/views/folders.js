// Folders view: which folders on disk are already sorted into crates, which still need work.
// Disk files are matched to Serato tracks by path; "classified" follows store.rules.
// Screening: mark files reject (X) / keep (V) while listening. Files Serato does not use can then be
// moved to the macOS Trash (with one-click restore); tracks in Serato are staged in the plan instead.
import { BAR, buildReport, byName, HINT, LABEL, STATUSES } from '../folderReport.js';
import { dirOf, effectivePath, isClassified } from '../model.js';
import { player } from '../player.js';
import { LOW_QUALITY_TEXT, qualityBadge } from '../quality.js';
import { api, store } from '../store.js';
import { openUnsortedEditor, unsortedRoots } from '../unsorted.js';
import { clear, confirmDialog, fmt, h, modal, prefs, toast, VirtualList } from '../ui.js';

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
  let includeSub = prefs.get('folders.includeSub', true);
  let filter = '';
  let visibleRows = [];
  let fileItems = [];
  let selectedFile = null; // path of the highlighted file row
  let focusFiles = false; // arrow keys move in the file list (true) or the folder tree (false)

  const summaryEl = h('section', { class: 'panel folders-summary' });
  const treeEl = h('div', { class: 'ftree' });
  const treeToolbar = h('div', { class: 'toolbar' });
  const treePanel = h('aside', { class: 'panel ftree-panel' }, h('div', { class: 'panel-head' }, h('h2', {}, '資料夾')), treeToolbar, treeEl);
  const detailHead = h('div', { class: 'fdetail-head' });
  const detailToolbar = h('div', { class: 'toolbar' });
  const fileHead = h(
    'div',
    { class: 'fileRow fileRow-head' },
    h('span'),
    h('span'),
    h('span', {}, '歌曲'),
    h('span', {}, '在哪些 crate'),
    h('span', { class: 'num' }, '格式'),
    h('span', { class: 'num', title: 'X 不要・V 留下' }, '篩選'),
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
      if (refresh) toast('已重新掃描資料夾');
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
          h('h2', {}, r ? `${r.roots.map((x) => x.name).join('、')} 共 ${r.sum.files.toLocaleString()} 個音檔` : '資料夾狀態'),
          h(
            'span',
            { class: 'muted small' },
            store.folderScan ? `掃描於 ${fmt.time(store.folderScan.scannedAt * 1000)}（${store.folderScan.seconds} 秒）・掃描只讀取；只有按「丟到垃圾桶」才會移動檔案` : '',
          ),
        ),
        h(
          'div',
          { class: 'toolbar' },
          h('button', { class: 'btn btn-sm', onclick: openUnsortedEditor, title: '設定哪些 crate 裡的歌算「待分類」' }, `未分類 crate・${unsortedCount} 個`),
          h('button', { class: 'btn btn-sm', disabled: loading, onclick: () => load(true) }, loading ? '掃描中…' : '↻ 重新掃描'),
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
              ? h('span', { class: 'muted small' }, `正在讀取每個檔案的格式… ${store.audioProgress.done.toLocaleString()} / ${store.audioProgress.total.toLocaleString()}`)
              : store.audioProgress?.error
                ? h('span', { class: 'muted small' }, `讀不到檔案格式：${store.audioProgress.error}`)
                : h('span', { class: 'legend-item', title: `低音質：${LOW_QUALITY_TEXT}` }, h('span', { class: 'qbadge is-low' }, '低音質'), h('strong', { class: 'num' }, r.sum.low.toLocaleString())),
            r.outsideCount ? h('span', { class: 'muted small', title: '例如 ~/Desktop 或 _Serato_ 資料夾裡的檔案' }, `另有 ${r.outsideCount} 首 Serato 的歌不在掃描範圍內`) : null,
            r.outsideMissing ? h('span', { class: 'muted small' }, `、${r.outsideMissing} 首找不到的歌在掃描範圍外`) : null,
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
            h('span', {}, `已標記不要 ${files.length.toLocaleString()} 個檔案（${fmt.size(bytes)}），還沒丟掉。`),
            h('button', { class: 'btn btn-sm btn-danger', onclick: () => openTrash(files) }, '檢查並丟到垃圾桶…'),
          ]
        : null,
      viaPlan ? h('span', { class: 'muted small', title: '這些歌在 Serato 裡，要先從 Serato 移除才能刪檔，所以排在「變更計畫」裡' }, `另有 ${viaPlan} 首 Serato 裡的歌標記不要，等「套用到 Serato」時一起處理`) : null,
      store.lastTrashed.length
        ? h('button', { class: 'btn btn-sm btn-ghost push-right', onclick: () => restore(store.lastTrashed) }, `↩ 還原剛剛丟掉的 ${store.lastTrashed.length} 個`)
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
      h('option', { value: 'name' }, '依名稱'),
      h('option', { value: 'todo' }, '待處理多的在前'),
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
        '隱藏整理完的',
      ),
    );
  }

  function renderTree() {
    if (!report) {
      clear(treeEl, h('div', { class: 'empty' }, loading ? '掃描中…' : loadError ? `掃描失敗：${loadError}` : ''));
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
        t.missing ? h('span', { class: 'tag tag-danger', title: `${t.missing} 首找不到` }, `✕${t.missing}`) : null,
        node.todo ? h('span', { class: 'todo', title: `待分類 ${t.unsorted}、沒匯入 ${t.notImported}` }, node.todo.toLocaleString()) : node.done ? h('span', { class: 'done', title: '整理完了' }, '✓') : null,
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
      clear(detailHead, h('div', { class: 'empty' }, report ? '左邊選一個資料夾' : loading ? '掃描中…' : loadError ? `掃描失敗：${loadError}` : ''));
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
    if (node.ghost) notes.push(h('div', { class: 'fnote fnote-danger' }, '這個資料夾已經不存在了（可能搬走或改了名字），但 Serato 裡還有歌指向這裡。'));
    if (t.files && !todo && !t.missing)
      notes.push(h('div', { class: 'fnote fnote-ok' }, '✓ 整理完了：這裡每首歌都已經在分類 crate 裡', t.copy ? `（另有 ${t.copy} 個副本，Serato 用的是別的地方那一份）` : '', '。'));
    if (t.unsorted)
      notes.push(
        h(
          'div',
          { class: 'fnote fnote-warn' },
          h('span', {}, `${t.unsorted} 首已經在 Serato 裡，但還沒分類。`),
          h('button', { class: 'btn btn-sm btn-primary', onclick: () => sortHere(node) }, '到「分類新歌」整理 →'),
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
            h('strong', {}, `先篩再匯入：已篩 ${screened.toLocaleString()} / ${pool.toLocaleString()}`),
            `（留下 ${t.kept.toLocaleString()}、不要 ${t.rejected.toLocaleString()}）`,
            h('br'),
            h('span', { class: 'muted' }, '點一首歌開始：↑↓ 換歌、空白鍵播放、Q W E R 跳到 0/25/50/75%、X 不要、V 留下。篩完把不要的丟到垃圾桶，再把這個資料夾拖進 Serato 的 TBD crate。'),
          ),
        ),
      );
    }
    if (crates.length)
      notes.push(
        h('div', { class: 'fnote' }, `Serato 裡的「${crates.join('」、「')}」是把這個資料夾整個拖進去的 crate，所以它不算分類。整理完、確定裡面的歌都分好了，就可以刪掉這個 crate。`),
      );
    if (t.unreadable)
      notes.push(h('div', { class: 'fnote fnote-danger' }, `${t.unreadable} 個檔案 macOS 打不開，可能已經損壞，或副檔名和實際格式不符。用「只看低音質」可以一起列出來，試聽確認一下。`));
    if (t.low || t.unreadable)
      notes.push(
        h(
          'div',
          { class: 'fnote fnote-danger' },
          h('span', { title: LOW_QUALITY_TEXT }, t.low ? `${t.low} 首低音質（${LOW_QUALITY_TEXT}）。AAC 256 和 MP3 320 不算低音質。` : '音質都沒問題，只有上面打不開的檔案。'),
          h(
            'button',
            {
              class: `btn btn-sm ${lowOnly ? 'btn-primary' : ''}`,
              onclick: () => {
                lowOnly = !lowOnly;
                renderDetail();
              },
            },
            lowOnly ? '顯示全部' : '只看低音質',
          ),
        ),
      );
    if (t.missing)
      notes.push(
        h(
          'div',
          { class: 'fnote fnote-danger' },
          h('span', {}, `Serato 裡有 ${t.missing} 首歌指向這裡，但檔案不見了。`),
          h('button', { class: 'btn btn-sm', onclick: () => navigate('cleanup') }, '到「清理」處理 →'),
        ),
      );

    clear(
      detailHead,
      h(
        'div',
        { class: 'fdetail-title' },
        h('div', { class: 'grow' }, h('h2', {}, node.name), h('div', { class: 'path', title: node.path }, fmt.shortPath(node.path))),
        !node.ghost ? h('button', { class: 'btn btn-sm', onclick: () => reveal(node.path) }, '在 Finder 打開') : null,
      ),
      h('div', { class: 'fstats' }, STATUSES.map(stat)),
      notes,
    );

    const filterInput = h('input', {
      class: 'input input-sm',
      placeholder: '篩選檔名、歌名、歌手…',
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
              title: '取消狀態篩選',
              onclick: () => {
                statusFilter = 'all';
                renderDetail();
              },
            },
            h('span', { class: `swatch st-${statusFilter}` }),
            `只看${LABEL[statusFilter]}`,
            h('span', { class: 'chip-x' }, '×'),
          )
        : null,
      lowOnly
        ? h(
            'button',
            {
              class: 'chip',
              title: '取消低音質篩選',
              onclick: () => {
                lowOnly = false;
                renderDetail();
              },
            },
            '只看低音質',
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
            '包含子資料夾',
          )
        : null,
    );
    renderFiles();
  }

  function renderFiles() {
    const node = selected();
    if (!node) return;
    const rank = { unsorted: 0, notImported: 1, missing: 2, copy: 3, rejected: 4, classified: 5 };
    const files = subtreeFiles(node).filter((f) => (statusFilter === 'all' || f.status === statusFilter) && (!lowOnly || f.quality?.low || f.quality?.unreadable) && fileMatches(f, filter));
    // Work still to do first; within a status, keep the folder order from the tree.
    const order = new Map(files.map((f, i) => [f, i]));
    fileItems = files.slice().sort((a, b) => rank[a.status] - rank[b.status] || order.get(a) - order.get(b));
    vlist.setItems(fileItems, h('div', { class: 'empty' }, filter || lowOnly || statusFilter !== 'all' ? '沒有符合的檔案' : '這個資料夾沒有音檔'));
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
    return p ? (p.key ?? `t${p.id}`) : null;
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
      store.revertOps((op) => op.type === 'removeTrack' && op.deleteFile && op.asset === f.assetId);
      return;
    }
    if (f.status === 'rejected') {
      store.setScreenMark([f.path], null);
      return;
    }
    if (f.status === 'missing') return toast('這首的檔案已經不在了，到「清理」處理');
    if (f.assetId != null) {
      // In Serato: remove it there and trash the file when the plan is applied.
      store.commit(`不要：${store.trackLabel(f.assetId)}`, [store.opReject(f.assetId)], { silent: true });
    } else {
      store.setScreenMark([f.path], 'reject');
    }
    advanceFrom(f.path, next, wasPlaying);
  }

  function markKeep(f) {
    if (!f) return;
    if (f.assetId != null || f.status === 'missing') return toast('這首已經在 Serato 裡了，到「分類新歌」分類就好');
    const next = fileItems[fileIndex(f.path) + 1]?.path;
    const wasPlaying = isPlaying(f);
    if (f.kept) {
      store.setScreenMark([f.path], null);
      return;
    }
    store.setScreenMark([f.path], 'keep');
    advanceFrom(f.path, next, wasPlaying);
  }

  function cratesCell(f) {
    const eff = store.eff;
    if (f.status === 'notImported') return h('span', { class: 'muted' }, '—');
    if (f.status === 'rejected')
      return h('span', { class: 'muted' }, f.viaPlan ? '不要・等「套用到 Serato」時移除並丟到垃圾桶' : '不要・還沒丟到垃圾桶');
    if (f.status === 'copy') {
      const twin = store.base.tracks.get(f.twins[0]);
      const twinPath = twin ? effectivePath(eff, twin) : '';
      const ok = f.twins.some((id) => isClassified(eff, store.rules, id));
      return h('span', { class: 'muted', title: twinPath }, `副本・Serato 用的是 ${fmt.shortPath(dirOf(twinPath))}（${ok ? '已分類' : '待分類'}）`);
    }
    const ids = eff.cratesOf.get(f.assetId) || [];
    if (!ids.length) return h('span', { class: 'muted' }, '不在任何 crate');
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

  function playable(f) {
    if (f.status === 'missing') return null;
    if (f.assetId != null) return store.base.tracks.get(f.assetId);
    return { key: `f${f.path}`, src: `/api/audio-file?path=${encodeURIComponent(f.path)}`, title: stripExt(f.name), artist: '沒匯入的檔案' };
  }

  function renderFile(f) {
    const t = f.assetId != null ? store.base.tracks.get(f.assetId) : null;
    const node = selected();
    const rel = node && f.node !== node ? f.node.path.slice(node.path.length + 1) : '';
    const play = playable(f);
    const key = play ? (play.key ?? `t${play.id}`) : null;
    const title = t ? t.title || stripExt(f.name) : stripExt(f.name);
    const sub = [t ? t.artist : `${fmt.size(f.size)} · ${fmt.date(f.mtime)}`, rel && `📁 ${rel}`].filter(Boolean).join(' · ');
    const canKeep = f.assetId == null && f.status !== 'missing';
    return h(
      'div',
      {
        class: `fileRow is-${f.status} ${f.path === selectedFile ? 'is-selected' : ''} ${f.kept ? 'is-kept' : ''}`,
        onclick: () => selectFile(f.path, { scroll: false }),
        ondblclick: () => play && player.play(play),
      },
      h('span', { class: `swatch st-${f.status}`, title: `${LABEL[f.status]}：${HINT[f.status]}` }),
      play
        ? h(
            'button',
            {
              class: 'icon-btn',
              title: '試聽',
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
        h('div', { class: 'trow-title', title: f.path }, title, f.sameCopies && f.status !== 'copy' ? h('span', { class: 'tag tag-warn', title: '硬碟上有一模一樣的檔案' }, `重複 ×${f.sameCopies + 1}`) : null),
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
                title: f.status === 'rejected' ? '取消「不要」' : '不要（X）',
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
                title: f.kept ? '取消「留下」' : '留下（V）',
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
      toast(`無法打開：${e.message}`, { tone: 'danger' });
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
      title: `把 ${files.length.toLocaleString()} 個檔案丟到垃圾桶？`,
      wide: true,
      body: h(
        'div',
        { class: 'trash-confirm' },
        h(
          'p',
          {},
          `共 ${fmt.size(bytes)}。檔案會移到 Mac 的垃圾桶，不會直接刪除。Backstage 會記下每個檔案原本的位置，清空垃圾桶之前都可以一鍵還原。這些檔案都不在 Serato 裡，丟掉不會影響 Serato。`,
        ),
        h(
          'div',
          { class: 'list trash-list' },
          [...groups].map(([dir, list]) => [
            h('div', { class: 'trash-dir' }, fmt.shortPath(dir), h('span', { class: 'muted small' }, ` ${list.length} 個`)),
            list.map((f) => h('div', { class: 'trash-file', title: f.path }, f.name, h('span', { class: 'muted small' }, ` ${fmt.size(f.size)}`))),
          ]),
        ),
      ),
      actions: (close) => [
        h('button', { class: 'btn', onclick: () => close(false) }, '取消'),
        h('button', { class: 'btn btn-danger', onclick: () => close(true) }, `丟到垃圾桶（${files.length.toLocaleString()} 個）`),
      ],
    });
    if (ok !== true) return;
    try {
      toast('正在移到垃圾桶…');
      const results = await store.trashFiles(files.map((f) => f.path));
      const done = results.filter((r) => r.ok);
      const failed = results.filter((r) => !r.ok);
      toast(`已丟到垃圾桶 ${done.length} 個檔案`, { action: () => restore(done.map((r) => r.path)), actionLabel: '還原', timeout: 10000 });
      if (failed.length) showFailures('有些檔案沒有丟掉', failed);
    } catch (e) {
      toast(`丟到垃圾桶失敗：${e.message}`, { tone: 'danger', timeout: 8000 });
    }
  }

  async function restore(paths) {
    try {
      const results = await store.restoreFiles(paths);
      const failed = results.filter((r) => !r.ok);
      toast(`已還原 ${results.length - failed.length} 個檔案到原本的位置`);
      if (failed.length) showFailures('有些檔案沒有還原', failed);
    } catch (e) {
      toast(`還原失敗：${e.message}`, { tone: 'danger', timeout: 8000 });
    }
  }

  function showFailures(title, failed) {
    modal({
      title,
      wide: true,
      body: h('div', { class: 'list trash-list' }, failed.map((r) => h('div', { class: 'trash-file', title: r.path }, fmt.shortPath(r.path), h('div', { class: 'muted small' }, r.error)))),
      actions: (close) => [h('button', { class: 'btn btn-primary', onclick: () => close() }, '知道了')],
    });
  }

  function sortHere(node) {
    prefs.set('inbox.source', { kind: 'folder', path: node.path });
    navigate('inbox');
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
    title: '資料夾',
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
