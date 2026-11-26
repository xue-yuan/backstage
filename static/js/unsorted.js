// Unsorted crates: which crates hold songs that still need sorting, and tidying them all under "Inbox".
// A song counts as sorted once it sits in any crate that is not unsorted (see classificationRules in model.js).
import { pickCrateDialog } from './cratePicker.js';
import { effectivePath, liveTracks, norm, pathKey } from './model.js';
import { store } from './store.js';
import { clear, confirmDialog, h, modal, promptDialog, toast } from './ui.js';

export const INBOX = 'Inbox';
export const LOOSE = '未分類單曲';

export function inboxCrateId(eff = store.eff) {
  return (eff.children.get(eff.rootId) || []).find((id) => norm(eff.crates.get(id).name) === norm(INBOX)) ?? null;
}

function isUnder(eff, id, ancestor) {
  for (let cur = id; cur != null && eff.crates.has(cur); cur = eff.crates.get(cur).parent) if (cur === ancestor) return true;
  return false;
}

/** Top-most unsorted crates (their sub-crates are unsorted too), Inbox first. */
export function unsortedRoots(eff = store.eff, rules = store.rules) {
  const inbox = inboxCrateId(eff);
  return [...rules.skip]
    .filter((id) => eff.crates.has(id) && !rules.skip.has(eff.crates.get(id).parent))
    .sort((a, b) => (a === inbox ? -1 : b === inbox ? 1 : eff.pathOf(a).localeCompare(eff.pathOf(b))));
}

/** Why a crate counts as unsorted: 'inbox' | 'folder' | 'manual' | 'inherited' | null. */
export function unsortedReason(id, eff = store.eff, rules = store.rules) {
  if (!rules.skip.has(id)) return null;
  if (rules.overrides[String(id)] === 'skip') return 'manual';
  const auto = rules.auto.get(id);
  if (auto) return auto.kind;
  return 'inherited';
}

const subtreeSongs = (eff, id) => {
  const seen = new Set();
  const walk = (c) => {
    (eff.members.get(c) || []).forEach((a) => seen.add(a));
    (eff.children.get(c) || []).forEach(walk);
  };
  walk(id);
  return seen.size;
};

/**
 * Ops that put every unsorted crate under Inbox (TBD / Temp style containers are emptied into it
 * and removed) and collect songs that are in no crate into the loose-songs crate under Inbox (LOOSE).
 */
export function consolidateOps() {
  const eff = store.eff;
  const rules = store.rules;
  const ops = [];
  let inbox = inboxCrateId(eff);
  if (inbox == null) {
    const op = store.opCreate(INBOX, eff.rootId);
    ops.push(op);
    inbox = op.id;
  }
  const taken = new Map((eff.children.get(inbox) || []).map((id) => [norm(eff.crates.get(id).name), id]));
  const moveIn = (id) => {
    const key = norm(eff.crates.get(id).name);
    if (taken.has(key)) ops.push(store.opMerge(id, taken.get(key)));
    else {
      ops.push({ ...store.opMove(id, inbox), text: `把「${eff.pathOf(id)}」移到「${INBOX}」底下` });
      taken.set(key, id);
    }
  };
  const roots = unsortedRoots(eff, rules).filter((id) => id !== inbox && !isUnder(eff, id, inbox));
  const emptied = [];
  let moved = 0;
  for (const id of roots) {
    const kids = eff.children.get(id) || [];
    if (rules.auto.get(id)?.kind === 'inbox' && !(eff.members.get(id) || []).length && kids.length) {
      kids.forEach(moveIn); // TBD / Temp: lift their crates into Inbox, then drop the empty container
      moved += kids.length;
      emptied.push(id);
    } else {
      moveIn(id);
      moved++;
    }
  }
  for (const id of emptied) ops.push(store.opDelete(id));

  // Only real songs from the DJ library (~/Music/DJ): not rekordbox samples, demo tracks or Desktop files.
  const libRoots = (store.folderScan?.roots || []).map((r) => `${pathKey(r)}/`);
  const inLibrary = (t) => {
    const p = pathKey(effectivePath(eff, t));
    return libRoots.length ? libRoots.some((r) => p.startsWith(r)) : p.includes("/music/dj/");
  };
  const loose = liveTracks(eff).filter((t) => !(eff.cratesOf.get(t.id) || []).length && (t.exists || eff.relocated.has(t.id)) && inLibrary(t));
  if (loose.length) {
    let target = taken.get(norm(LOOSE));
    if (target == null) {
      const op = { ...store.opCreate(LOOSE, inbox), text: `在「${INBOX}」底下建立 crate「${LOOSE}」` };
      ops.push(op);
      target = op.id;
    }
    for (const t of loose) ops.push({ type: 'add', crate: target, asset: t.id, text: `加入「${INBOX} / ${LOOSE}」：${store.trackLabel(t.id)}` });
  }
  return { ops, moved, removed: emptied.map((id) => eff.pathOf(id)), loose: loose.length };
}

export async function consolidate() {
  const { ops, moved, removed, loose } = consolidateOps();
  if (!moved && !loose) {
    toast('未分類的 crate 都已經在 Inbox 底下了');
    return false;
  }
  const ok = await confirmDialog({
    title: '把未分類的都整理到 Inbox？',
    message: [
      moved ? `${moved} 個未分類 crate 會移到「${INBOX}」底下` : null,
      removed.length ? `清空後刪掉「${removed.join('」、「')}」` : null,
      loose ? `${loose} 首沒有任何 crate 的歌放進「${INBOX} / ${LOOSE}」` : null,
    ]
      .filter(Boolean)
      .join('；') + '。只會排進變更計畫，套用到 Serato 之前都可以在「變更計畫」或「Crate 結構」調整、復原。',
    okText: '排進變更計畫',
  });
  if (!ok) return false;
  return !!store.commit(`把未分類的 crate 和歌整理到 ${INBOX}`, ops);
}

async function createUnder() {
  const eff = store.eff;
  const inbox = inboxCrateId(eff);
  const siblings = inbox == null ? [] : (eff.children.get(inbox) || []).map((id) => norm(eff.crates.get(id).name));
  const name = await promptDialog({
    title: `在「${INBOX}」底下新增未分類 crate`,
    placeholder: '例如：2026-12 Beatport',
    okText: '新增',
    validate: (v) => (siblings.includes(norm(v)) ? `「${INBOX}」底下已經有這個名稱` : null),
  });
  if (!name) return;
  const ops = [];
  let parent = inbox;
  if (parent == null) {
    const op = store.opCreate(INBOX, eff.rootId);
    ops.push(op);
    parent = op.id;
  }
  ops.push({ ...store.opCreate(name, parent), text: `在「${INBOX}」底下建立 crate「${name}」` });
  store.commit(`新增未分類 crate「${INBOX} / ${name}」`, ops);
}

const REASON = { inbox: '收件匣', folder: '整個資料夾拖進來的', manual: '你設定的' };

/** The editor: list / add / remove unsorted crates, create new ones under Inbox, tidy into Inbox. */
export function openUnsortedEditor() {
  const bodyEl = h('div', { class: 'rules' });
  const render = () => {
    const eff = store.eff;
    const rules = store.rules;
    const inbox = inboxCrateId(eff);
    const roots = unsortedRoots(eff, rules);
    const { moved, loose } = consolidateOps();
    const row = (id) => {
      const reason = unsortedReason(id, eff, rules);
      const auto = rules.auto.get(id);
      const kids = (eff.children.get(id) || []).length;
      return h(
        'div',
        { class: 'list-row' },
        h(
          'span',
          { class: 'grow' },
          eff.pathOf(id),
          h('span', { class: 'tag tag-unsorted' }, REASON[reason] || '未分類'),
          h(
            'div',
            { class: 'muted small' },
            `${subtreeSongs(eff, id).toLocaleString()} 首`,
            kids ? `・${kids} 個子 crate` : '',
            auto?.kind === 'folder' ? `・${auto.n} / ${auto.total} 首來自 ${auto.dir.replace(/^\/Users\/[^/]+/, '~')}` : '',
          ),
        ),
        h(
          'button',
          {
            class: 'btn btn-sm btn-ghost',
            title: '這個 crate 裡的歌改算「已分類」',
            onclick: () => {
              store.setClassifyOverride(id, auto ? 'count' : null);
              render();
            },
          },
          '移除',
        ),
      );
    };
    clear(
      bodyEl,
      h('p', { class: 'muted' }, `放在這些 crate（包含底下所有子 crate）裡的歌算「待分類」。只要同一首歌也在其他 crate 裡，就算「已分類」。之後新的未分類 crate 放在「${INBOX}」底下就會自動算進來。`),
      moved || loose
        ? h(
            'div',
            { class: 'fnote fnote-warn' },
            h('span', {}, [moved ? `有 ${moved} 個未分類 crate 不在「${INBOX}」底下` : null, loose ? `${loose} 首歌沒有任何 crate` : null].filter(Boolean).join('，') + '。'),
            h(
              'button',
              {
                class: 'btn btn-sm btn-primary',
                onclick: async () => {
                  if (await consolidate()) render();
                },
              },
              `整理到 ${INBOX}…`,
            ),
          )
        : null,
      h('div', { class: 'section-label' }, `未分類 crate（${roots.length}）`),
      h('div', { class: 'list rules-scroll' }, roots.length ? roots.map(row) : h('div', { class: 'empty' }, '沒有未分類 crate')),
      h(
        'div',
        { class: 'toolbar rules-actions' },
        h(
          'button',
          {
            class: 'btn btn-sm',
            onclick: async () => {
              await createUnder();
              render();
            },
          },
          `＋ 在 ${INBOX} 底下新增 crate`,
        ),
        h(
          'button',
          {
            class: 'btn btn-sm',
            onclick: async () => {
              const id = await pickCrateDialog({ title: '哪個 crate 算未分類？', allowCreate: false, exclude: store.rules.skip });
              if (id != null) store.setClassifyOverride(id, rules.auto.has(id) ? null : 'skip');
              render();
            },
          },
          '＋ 把現有 crate 設為未分類',
        ),
        Object.keys(rules.overrides).length
          ? h(
              'button',
              {
                class: 'btn btn-sm btn-ghost',
                onclick: () => {
                  store.saveClassifyOverrides({});
                  render();
                },
              },
              '還原預設',
            )
          : null,
      ),
      inbox == null ? h('p', { class: 'muted small' }, `目前沒有「${INBOX}」crate，新增或整理時會自動建立。`) : null,
    );
  };
  render();
  return modal({
    title: '未分類 crate',
    wide: true,
    body: bodyEl,
    actions: (close) => [h('button', { class: 'btn btn-primary', onclick: () => close() }, '完成')],
  });
}
