// Guide: how Backstage works and the suggested workflow. Long prose is written per language (below)
// instead of string by string; UI names inside it come from _() so they always match the buttons.
import { _, lang } from '../i18n.js';
import { shortcutTable } from '../shortcuts.js';
import { h } from '../ui.js';

// Blocks: a string is a paragraph (**bold**, `code`); { list }, { steps }, { tip }, { go: view }, { shortcuts }.
const q = (label) => `「${_(label)}」`;
const qe = (label) => `"${_(label)}"`;

function zhContent() {
  return [
    {
      id: 'about',
      title: 'Backstage 是什麼',
      blocks: [
        'Backstage 幫你整理 Serato DJ 的曲庫：篩選新歌、把歌分到 crate、清理重複和找不到的檔案、整理 crate 結構。',
        `**平常只讀資料。** Backstage 讀的是 Serato 資料庫的複本，Serato 開著也可以用。你做的每個修改都先放進${q('Plan')}，**只有按${q('Apply to Serato…')}才會真的寫進 Serato**。`,
        '唯一會動到檔案的是「丟到垃圾桶」：檔案進 Mac 的垃圾桶，不會直接刪除，清空垃圾桶前都可以還原。',
      ],
    },
    {
      id: 'flow',
      title: '建議的整理流程',
      blocks: [
        {
          steps: [
            `**${_('Overview')}**：看還有哪些事要做，點卡片會直接跳到對應的畫面。`,
            `**${_('Folders')}**：篩選還沒匯入 Serato 的新歌。X 不要、V 留下，再按${q('Review and move to Trash…')}把不要的丟掉。留下的歌請**在 Serato 裡**把資料夾拖進 Inbox 底下的 crate（Backstage 不能幫你匯入新歌）。`,
            `**${_('Sort')}**：把 Inbox 裡的歌一首一首分到正式的 crate。`,
            `**${_('Cleanup')}**：處理${q('Missing files')}、${q('Duplicates')}、${q('Empty crates')}。`,
            `**${_('Crates')}**：改名、移動、合併、刪除 crate。`,
            `**${_('Plan')}**：檢查要改的內容，關掉 Serato DJ，按${q('Apply to Serato…')}。`,
          ],
        },
        { go: 'home' },
      ],
    },
    {
      id: 'sort',
      title: _('Sort'),
      blocks: [
        `左邊選來源：${q('In no crate')}、${q('Added in the last {n} days').replace('{n}', 'N')}、某個資料夾，或${q('Sort from a crate')}底下 Inbox 的 crate。數字是**還剩幾首**沒分類，分完會變成 ✓。`,
        `**什麼算「已分類」**：歌至少在一個正式的 crate 裡。Inbox 和它底下的 crate、還有「整個資料夾拖進來」的 crate 都算「未分類」。要調整哪些 crate 算未分類，在${q('Crates')}按${q('Unsorted…')}。`,
        {
          list: [
            `**1–9**：加到釘選的 crate，再按一次取消。用${q('+ Pin')}把常用的 crate 釘上去。`,
            '**⇧1–5**：加到建議的 crate。',
            '**/**：搜尋其他 crate；輸入「上層 / 新名稱」可以直接建立新的 crate。',
            '**X**：不要這首。套用時從 Serato 移除，檔案丟到垃圾桶。',
            '**⇧X**：只從 Serato 曲庫移除，保留檔案（取樣音效、Demo 歌曲這類）。',
            '**N**：跳到下一個還有歌的 crate。',
          ],
        },
        `${q('Remove from the source crate when adding')}：從 Inbox 的 crate 分歌時預設打開，分好的歌會離開 Inbox，Inbox 就會越來越少。`,
        '「把 N 首已分類的歌移出這個 crate」：有些歌已經在正式的 crate，卻還留在 Inbox，按一下就整批移出。',
        '歌曲清單上方可以選「全部」、「還沒分類」或「只看已分類」。',
        { go: 'inbox' },
      ],
    },
    {
      id: 'preview',
      title: '試聽',
      blocks: [
        '選一首歌按空白鍵。新的歌會**從 30% 開始播**（DJ 版前奏很長），播放列右邊可以改。',
        'Q 回到開頭，W E R 跳到 25% / 50% / 75%，← → 快轉 10 秒（按住 ⇧ 是 30 秒）。',
        { tip: '試聽用的是 Mac 的預設音訊輸出。如果 Serato 正在打歌，注意不要讓試聽的聲音跑到現場。' },
      ],
    },
    {
      id: 'no-crate',
      title: '不在任何 crate 的歌怎麼處理',
      blocks: [
        `在${q('Sort')}選${q('In no crate')}。通常是這三種：`,
        {
          list: [
            '**真的歌**：照平常一樣分到 crate。',
            '**不是音樂的檔案**（rekordbox 的取樣音效、Pioneer 的 Demo、桌面上的暫存檔）：按 ⇧X，只從 Serato 移除，檔案留著。',
            `**標著${q('Missing file')}的歌**：到${q('Cleanup')} › ${q('Missing files')}重新指定位置、合併到同一首歌的其他記錄，或從曲庫移除。`,
          ],
        },
      ],
    },
    {
      id: 'plan',
      title: '變更計畫和復原',
      blocks: [
        `${q('Summary')}把動作依內容分組，例如「Inbox / 0425 → 12 首分到 Future House / 延伸」。展開群組可以單獨復原每一項，也可以整組復原。`,
        `${q('History')}照你做的順序列出每個變更。⌘Z 復原最後一個變更。`,
        '分頁上的數字是還沒套用的變更數，Mac app 的 Dock 圖示也會顯示。計畫會自動存起來，關掉 app 也不會不見。',
        { go: 'plan' },
      ],
    },
    {
      id: 'apply',
      title: _('Apply to Serato'),
      blocks: [
        {
          steps: [
            '先**關掉 Serato DJ**。Backstage 會檢查，開著就不能套用。',
            `在${q('Plan')}按${q('Apply to Serato…')}。`,
            'Backstage 會先在複本上預演、自動備份 Serato 的資料庫，寫入後再檢查一次。**任何一步失敗，就什麼都不會寫入。**',
            `打開 Serato DJ 確認。如果有問題，關掉 Serato，到${q('Plan')}按${q('Restore the backup from before the last apply')}。`,
          ],
        },
        '每次套用前的備份放在 `~/Backstage Backups/Serato 資料庫/`。「不要」的歌，檔案要等套用成功後才會丟到垃圾桶。',
      ],
    },
    { id: 'keys', title: _('Keyboard shortcuts'), blocks: ['**右鍵選單**：在歌、crate、資料夾上按右鍵（或 control + 點一下），常用的動作都在選單裡，例如加到 crate、在 Finder 中顯示、展開底下全部。', { shortcuts: true }] },
    {
      id: 'data',
      title: '資料存在哪裡',
      blocks: [
        {
          list: [
            '變更計畫、篩選標記、設定：`~/Library/Application Support/Backstage/`',
            '套用前的備份：`~/Backstage Backups/`',
          ],
        },
        'Backstage 不會修改音樂檔本身，只會在你按「丟到垃圾桶」或套用「不要」的歌時，把檔案移到垃圾桶。',
      ],
    },
  ];
}

function enContent() {
  return [
    {
      id: 'about',
      title: 'What Backstage does',
      blocks: [
        'Backstage helps you organise your Serato DJ library: screen new songs, sort songs into crates, clean up duplicates and missing files, and tidy the crate structure.',
        `**It only reads, normally.** Backstage works on a copy of the Serato database, so Serato can stay open. Every edit goes into the ${qe('Plan')} first, and **only ${qe('Apply to Serato…')} writes to Serato**.`,
        'The only thing that touches files is moving them to the Trash: they go to the Mac Trash, are not deleted, and can be restored until you empty it.',
      ],
    },
    {
      id: 'flow',
      title: 'Suggested workflow',
      blocks: [
        {
          steps: [
            `**${_('Overview')}**: see what is left to do; each card opens the view that handles it.`,
            `**${_('Folders')}**: screen new songs that are not in Serato yet. X rejects, V keeps; then ${qe('Review and move to Trash…')}. Drag the kept folder into a crate under Inbox **in Serato** (Backstage cannot import songs).`,
            `**${_('Sort')}**: sort the songs in Inbox into your real crates, one by one.`,
            `**${_('Cleanup')}**: ${qe('Missing files')}, ${qe('Duplicates')} and ${qe('Empty crates')}.`,
            `**${_('Crates')}**: rename, move, merge and delete crates.`,
            `**${_('Plan')}**: check the changes, quit Serato DJ, press ${qe('Apply to Serato…')}.`,
          ],
        },
        { go: 'home' },
      ],
    },
    {
      id: 'sort',
      title: _('Sort'),
      blocks: [
        `Pick a source on the left: ${qe('In no crate')}, recently added songs, a folder, or one of the Inbox crates. The numbers show **how many songs are left**; a finished source shows ✓.`,
        `**"Sorted" means** the song sits in at least one real crate. Inbox and everything under it, and crates that are a whole folder dragged into Serato, count as unsorted. Change which crates count as unsorted with ${qe('Unsorted…')} in ${qe('Crates')}.`,
        {
          list: [
            `**1–9**: add to a pinned crate (press again to take it back). Pin crates with ${qe('+ Pin')}.`,
            '**⇧1–5**: add to a suggested crate.',
            '**/**: search other crates; type "Parent / New name" to create one.',
            '**X**: reject the song. Applying removes it from Serato and moves its file to the Trash.',
            '**⇧X**: only remove it from the Serato library and keep the file (samples, demo tracks).',
            '**N**: next crate with songs left.',
          ],
        },
        `${qe('Remove from the source crate when adding')} is on by default for Inbox crates, so sorted songs leave the Inbox and it shrinks.`,
        '"Take N sorted songs out of this crate" removes songs that already sit in a real crate but are still in the Inbox crate.',
        'Above the song list you can show all songs, only the ones not sorted yet, or only the sorted ones.',
        { go: 'inbox' },
      ],
    },
    {
      id: 'preview',
      title: 'Previewing songs',
      blocks: [
        'Select a song and press Space. New songs **start at 30%** (DJ edits have long intros); change it in the player bar.',
        'Q goes back to the start, W E R jump to 25% / 50% / 75%, ← → skip 10 s (30 s with ⇧).',
        { tip: 'Previews play through the Mac’s default audio output. If you are playing a set in Serato, make sure previews do not reach the speakers.' },
      ],
    },
    {
      id: 'no-crate',
      title: 'Songs in no crate',
      blocks: [
        `In ${qe('Sort')}, pick ${qe('In no crate')}. They are usually one of three kinds:`,
        {
          list: [
            '**Real songs**: sort them into crates as usual.',
            '**Not music** (rekordbox samples, Pioneer demo tracks, scratch files on the Desktop): press ⇧X to remove them from Serato and keep the files.',
            `**Songs marked ${qe('Missing file')}**: in ${qe('Cleanup')} › ${qe('Missing files')}, relocate them, merge them into another record of the same song, or remove them.`,
          ],
        },
      ],
    },
    {
      id: 'plan',
      title: 'The plan and undo',
      blocks: [
        `${qe('Summary')} groups the actions by what they do, e.g. "Inbox / 0425 → 12 songs into Future House / Build Up". Open a group to undo single items, or undo the whole group.`,
        `${qe('History')} lists every change in the order you made it. ⌘Z undoes the last change.`,
        'The number on the tab is how many changes are not applied yet; the Mac app shows it on its Dock icon too. The plan is saved automatically.',
        { go: 'plan' },
      ],
    },
    {
      id: 'apply',
      title: _('Apply to Serato'),
      blocks: [
        {
          steps: [
            '**Quit Serato DJ.** Backstage checks and will not apply while it is open.',
            `In ${qe('Plan')}, press ${qe('Apply to Serato…')}.`,
            'Backstage rehearses on a copy, backs up the Serato database, writes, then checks everything again. **If any step fails, nothing is written.**',
            `Open Serato DJ and check. If something is wrong, quit Serato and press ${qe('Restore the backup from before the last apply')} in ${qe('Plan')}.`,
          ],
        },
        'Backups from before each apply are in `~/Backstage Backups/Serato 資料庫/`. Files of rejected songs go to the Trash only after the apply succeeds.',
      ],
    },
    { id: 'keys', title: _('Keyboard shortcuts'), blocks: ['**Right-click menus**: right-click (or control-click) a song, a crate or a folder for the common actions, such as adding to a crate, showing it in Finder or expanding everything below.', { shortcuts: true }] },
    {
      id: 'data',
      title: 'Where things are stored',
      blocks: [
        { list: ['Plan, screening marks, settings: `~/Library/Application Support/Backstage/`', 'Backups from before applying: `~/Backstage Backups/`'] },
        'Backstage never edits your music files. It only moves files to the Trash when you ask it to, or when an applied plan rejects a song.',
      ],
    },
  ];
}

/** Paragraph text with **bold** and `code`. */
function rich(text) {
  return text.split(/(\*\*[^*]+\*\*|`[^`]+`)/).map((part) => {
    if (part.startsWith('**') && part.endsWith('**')) return h('strong', {}, part.slice(2, -2));
    if (part.startsWith('`') && part.endsWith('`')) return h('code', {}, part.slice(1, -1));
    return part;
  });
}

const VIEW_LABELS = { home: 'Overview', inbox: 'Sort', plan: 'Plan' };

export function createGuideView({ navigate } = {}) {
  const sections = lang === 'zh' ? zhContent() : enContent();
  const block = (b) => {
    if (typeof b === 'string') return h('p', {}, rich(b));
    if (b.list) return h('ul', {}, b.list.map((x) => h('li', {}, rich(x))));
    if (b.steps) return h('ol', {}, b.steps.map((x) => h('li', {}, rich(x))));
    if (b.tip) return h('div', { class: 'notice notice-warn' }, rich(b.tip));
    if (b.shortcuts) return shortcutTable();
    if (b.go && navigate) return h('button', { class: 'btn btn-sm', onclick: () => navigate(b.go) }, _('Open {view} →', { view: _(VIEW_LABELS[b.go]) }));
    return null;
  };
  const body = h(
    'div',
    { class: 'guide-body' },
    sections.map((s) => h('section', { class: 'guide-section', id: `guide-${s.id}` }, h('h2', {}, s.title), s.blocks.map(block))),
  );
  const toc = h(
    'nav',
    { class: 'guide-toc' },
    h('div', { class: 'section-label' }, _('Guide')),
    sections.map((s) => h('a', { href: `#guide-${s.id}`, onclick: (e) => (e.preventDefault(), body.querySelector(`#guide-${s.id}`).scrollIntoView({ behavior: 'smooth', block: 'start' })) }, s.title)),
  );
  const el = h('div', { class: 'view guide' }, h('div', { class: 'guide-inner' }, toc, body));
  return { el, title: _('Guide'), update() {}, onKey: () => false, destroy() {} };
}
