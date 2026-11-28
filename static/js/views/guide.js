// Guide: how Cratify works and the suggested workflow. Long prose is written per language (below)
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
      title: 'Cratify 是什麼',
      blocks: [
        'Cratify 幫你整理 Serato DJ 的曲庫：篩選新歌、把歌分到 crate、清理重複和找不到的檔案、整理 crate 結構。',
        `**平常只讀資料。** Cratify 讀的是 Serato 資料庫的複本，Serato 開著也可以用。你做的每個修改都先放進${q('Plan')}，**只有按${q('Apply to Serato…')}才會真的寫進 Serato**。`,
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
            `**${_('Folders')}**：篩選還沒匯入 Serato 的新歌。X 不要、V 留下，再按${q('Review and move to Trash…')}把不要的丟掉。留下的歌按${q('Add to Serato…')}放進變更計畫（例如新增「Inbox / 資料夾名稱」），套用後在 Serato 對它們按「分析檔案」；也可以照舊在 Serato 裡把資料夾拖進 Inbox 底下的 crate。`,
            `**${_('Sort')}**：把 Inbox 裡的歌一首一首分到正式的 crate。`,
            `**${_('Cleanup')}**：處理${q('Missing files')}、${q('Duplicates')}、${q('Empty crates')}。`,
            `**${_('Quality')}**：檢查新歌有沒有假 320k、假無損（要手動按，見下面「假音質」）。`,
            `**${_('Crates')}**：改名、移動、合併、刪除 crate，也可以調整順序（拖到兩個 crate 中間，或選好後按 ⌥↑ ⌥↓）。`,
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
      id: 'fake',
      title: '假音質（假 320k、假無損）',
      blocks: [
        '有些檔案標的是 MP3 320 或 WAV，其實是從比較差的檔案轉出來的，例如把 128k 的 MP3 轉存成 320k。檔案變大了，聲音不會變好。',
        '**怎麼看出來**：編碼器會把高頻切掉，位元率越低切得越多：128k 大約切在 16.5 kHz、192k 在 19 kHz、320k 在 20 kHz，真的無損會到 22 kHz。轉檔救不回被切掉的部分，所以標 320 卻在 16.5 kHz 以上完全沒聲音，就是 128k 轉的。',
        `**用${q('Quality')}分頁檢查**：為了省電，檢查**不會自動跑**，要在${q('Quality')}分頁按「檢查 N 個新檔案」才會開始。檢查過的檔案會記住，之後每次只檢查新加入或改過的檔案。Serato 分析或加 cue 點時會把資料寫進音樂檔，但聲音沒變，Cratify 會比對聲音指紋認出來，不會再檢查一次。速度可以選（省電一次 1 個檔案），都用低優先權跑，不會搶 Serato 的資源，也可以隨時停止。看起來像轉檔的，音質旁邊會標橘色的${q('Suspect')}；${q('Quality')}分頁會列出全部，可以試聽、看頻譜、標記「聽起來沒問題」或「不要」。合併重複曲目時也會優先保留不可疑的那份。`,
        { tip: '「可疑」只是工具自動判斷的參考，不是定論。刪除或換掉檔案之前，一定要用頻譜工具看過、用耳朵聽過再決定。有些歌本來就沒什麼高頻（老錄音、lo-fi、部分爵士），也可能被標到；反過來，沒被標到也不保證是真的。下載新歌之後，記得到「音質檢查」分頁按一次檢查（它不會自己跑），有疑問就照下面的步驟手動檢查。看過覺得沒問題的，按「聽起來沒問題」就不會再標可疑。' },
        '**手動檢查的步驟**：',
        {
          steps: [
            `在歌上按右鍵 → ${q('Spectrum')}（分類新歌的右邊、重複曲目的每一行也有${q('Spectrum')}按鈕）。也可以用免費的 Spek，或 Audacity 的頻譜圖模式。`,
            '看彩色區域的**上緣**：真的 MP3 320 會到 20 kHz 左右。整首歌在 16 kHz 有一條**平的天花板**，就是 128k 轉的；在 19 kHz 左右是 192k。',
            '看**整首歌**，不要只看一段：前奏和安靜的段落本來就少高頻。轉檔的上限是一條貫穿整首、很直的線；自然的高頻會跟著音樂起伏。',
            'WAV、AIFF 也一樣：在 16–20 kHz 有平的天花板，就是 MP3 轉成的「假無損」。Mashup pack 常常拼了不同來源，前後段的天花板可能不一樣。',
            '用好一點的耳機聽鈸、hi-hat 和人聲的齒音：轉檔的常常聽起來比較悶，或有「水水的、刷刷的」怪聲。',
            '還是不確定，就拿可靠來源的版本（Beatport、Bandcamp 的試聽或買來的檔案）來比。',
          ],
        },
        `**確認是假的之後**：從可靠的來源重新買或下載，在 Serato 匯入後到${q('Cleanup')} › ${q('Duplicates')}合併，保留新的那份（crate 會一起帶過去），舊的可以一起丟到垃圾桶。`,
        '這個功能需要 ffmpeg（終端機執行 `brew install ffmpeg`）。沒有安裝的話，「可疑」標記和「頻譜」按鈕不會出現。',
        { go: 'quality' },
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
            '先**關掉 Serato DJ**。Cratify 會檢查，開著就不能套用。',
            `在${q('Plan')}按${q('Apply to Serato…')}。`,
            'Cratify 會先在複本上預演、自動備份 Serato 的資料庫，寫入後再檢查一次。**任何一步失敗，就什麼都不會寫入。**',
            `打開 Serato DJ 確認。如果有問題，關掉 Serato，到${q('Plan')}按${q('Restore the backup from before the last apply')}。`,
          ],
        },
        '每次套用前的備份放在 `~/Cratify Backups/Serato Library/`。「不要」的歌，檔案要等套用成功後才會丟到垃圾桶。',
      ],
    },
    {
      id: 'notes',
      title: _('Notes'),
      blocks: [
        '想到什麼就記下來：這首歌適合開場、從第二段 drop 接出去、在誰的 set 聽到想找的歌……筆記只存在 Cratify（`notes.json`），**不會寫進 Serato**。',
        {
          list: [
            `**連結歌曲**：寫筆記時按${q('Link a song…')}，或一鍵連結正在播放的歌。也可以在${q('Sort')}按 M，或在歌上按右鍵 →${q('Add a note…')}。`,
            `**還沒匯入的歌**：在${q('Folders')}對還沒匯入的檔案寫筆記，等你在 Serato 匯入之後，筆記會自動連到那首歌（用檔案位置對）。`,
            `**想找的歌**：不用連結，直接寫「演出者 - 歌名」。之後買到、匯入了，按${q('Link a song…')}，搜尋框會自動帶入第一行，按 Enter 就連好。`,
            '**#標籤**：在內容裡寫 #開場、#轉場、#想買，上方就會出現標籤，點一下只看那一類。',
          ],
        },
        `在${q('Sort')}選到有筆記的歌，右邊會顯示最近的筆記。刪掉的筆記可以按${q('Undo')}救回來，也可以按${q('Export')}存成 Markdown 檔。`,
        { go: 'notes' },
      ],
    },
    { id: 'keys', title: _('Keyboard shortcuts'), blocks: ['**右鍵選單**：在歌、crate、資料夾上按右鍵（或 control + 點一下），常用的動作都在選單裡，例如加到 crate、在 Finder 中顯示、展開底下全部。', { shortcuts: true }] },
    {
      id: 'data',
      title: '資料存在哪裡',
      blocks: [
        {
          list: [
            '變更計畫、篩選標記、筆記、設定：`~/Library/Application Support/Cratify/`',
            '套用前的備份：`~/Cratify Backups/`',
          ],
        },
        'Cratify 不會修改音樂檔本身，只會在你按「丟到垃圾桶」或套用「不要」的歌時，把檔案移到垃圾桶。',
        `**音樂資料夾**：${q('Folders')}只掃描你選的資料夾，找不到的檔案也在這些資料夾和 ~/Music 裡找。第一次打開時會依 Serato 資料庫裡的歌放在哪裡建議，之後在${q('Folders')}右上角的「音樂資料夾」可以改。`,
      ],
    },
  ];
}

function enContent() {
  return [
    {
      id: 'about',
      title: 'What Cratify does',
      blocks: [
        'Cratify helps you organise your Serato DJ library: screen new songs, sort songs into crates, clean up duplicates and missing files, and tidy the crate structure.',
        `**It only reads, normally.** Cratify works on a copy of the Serato database, so Serato can stay open. Every edit goes into the ${qe('Plan')} first, and **only ${qe('Apply to Serato…')} writes to Serato**.`,
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
            `**${_('Folders')}**: screen new songs that are not in Serato yet. X rejects, V keeps; then ${qe('Review and move to Trash…')}. Then ${qe('Add to Serato…')} puts the kept songs in the plan (for example into a new "Inbox / folder name" crate); after applying, choose "Analyze Files" for them in Serato. Dragging the folder into a crate under Inbox in Serato still works too.`,
            `**${_('Sort')}**: sort the songs in Inbox into your real crates, one by one.`,
            `**${_('Cleanup')}**: ${qe('Missing files')}, ${qe('Duplicates')} and ${qe('Empty crates')}.`,
            `**${_('Quality')}**: check new songs for fake 320k and fake lossless (run it by hand; see "Fake quality" below).`,
            `**${_('Crates')}**: rename, move, merge and delete crates, and change their order (drag between two crates, or select one and press ⌥↑ ⌥↓).`,
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
      id: 'fake',
      title: 'Fake quality (fake 320k, fake lossless)',
      blocks: [
        'Some files say MP3 320 or WAV but were converted from something worse, for example a 128k MP3 saved again as 320k. The file gets bigger; the sound does not get better.',
        '**How it shows**: encoders cut the highest frequencies, more at lower bit rates: about 16.5 kHz at 128k, 19 kHz at 192k, 20 kHz at 320k, while real lossless reaches 22 kHz. Converting cannot bring the cut part back, so an "MP3 320" with nothing above 16.5 kHz was made from a 128k file.',
        `**Check them in the ${qe('Quality')} tab**: to save power the check **never runs on its own**; press "Check N new files" in ${qe('Quality')}. Checked files are remembered, so each run only looks at new or changed files. Serato writes its analysis and cue points into the music file without changing the sound; Cratify compares an audio fingerprint, so those files are not checked again. You can pick the speed (power saving does 1 file at a time); every speed runs at low priority so Serato is not affected, and you can stop at any time. Files that look converted get an orange ${qe('Suspect')} mark next to their quality; the ${qe('Quality')} tab lists them all so you can listen, look at the spectrum, and mark each one "Sounds fine" or reject it. Merging duplicates prefers the copy that is not suspect.`,
        { tip: '"Suspect" is an automatic guess, not proof. Before you delete or replace a file, always look at its spectrum and listen to it. Songs with little high end (old or lo-fi recordings, some jazz) can be marked too, and a file without the mark is not guaranteed to be real. After downloading new songs, remember to run the check in the Quality tab (it does not run by itself), and check by hand when in doubt. Files you checked and found fine can be marked "Sounds fine" so they are no longer flagged.' },
        '**Checking by hand**:',
        {
          steps: [
            `Right-click a song → ${qe('Spectrum')} (Sort and each duplicate row also have a ${qe('Spectrum')} button). The free app Spek, or Audacity's spectrogram view, work too.`,
            'Look at the **top edge** of the coloured area. A real MP3 320 reaches about 20 kHz. A **flat ceiling** across the whole song at about 16 kHz means a 128k source; about 19 kHz means 192k.',
            'Look at the **whole song**, not one part: intros and quiet parts have little high end anyway. A transcode\'s limit is a straight line through the whole song; natural high end moves with the music.',
            'The same goes for WAV and AIFF: a flat ceiling between 16 and 20 kHz means a "fake lossless" file made from an MP3. Mashup packs often mix sources, so the ceiling can change between parts.',
            'Listen on good headphones to cymbals, hi-hats and vocal "s" sounds: transcodes often sound dull, swirly or watery.',
            'Still unsure? Compare with a copy from a trusted source (a Beatport or Bandcamp preview or purchase).',
          ],
        },
        `**Once it is confirmed**: buy or download it again from a trusted source, import it in Serato, then merge in ${qe('Cleanup')} › ${qe('Duplicates')} keeping the new copy (its crates move over); the old file can go to the Trash at the same time.`,
        'This needs ffmpeg (run `brew install ffmpeg` in Terminal). Without it, the Suspect marks and Spectrum buttons do not appear.',
        { go: 'quality' },
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
            '**Quit Serato DJ.** Cratify checks and will not apply while it is open.',
            `In ${qe('Plan')}, press ${qe('Apply to Serato…')}.`,
            'Cratify rehearses on a copy, backs up the Serato database, writes, then checks everything again. **If any step fails, nothing is written.**',
            `Open Serato DJ and check. If something is wrong, quit Serato and press ${qe('Restore the backup from before the last apply')} in ${qe('Plan')}.`,
          ],
        },
        'Backups from before each apply are in `~/Cratify Backups/Serato Library/`. Files of rejected songs go to the Trash only after the apply succeeds.',
      ],
    },
    {
      id: 'notes',
      title: _('Notes'),
      blocks: [
        'Write down anything: a song that makes a good opener, where to mix out, a song you heard in someone\'s set and want to find. Notes are kept by Cratify only (`notes.json`) and **never written to Serato**.',
        {
          list: [
            `**Linking a song**: press ${qe('Link a song…')} while writing, or link the song that is playing in one click. You can also press M in ${qe('Sort')}, or right-click a song → ${qe('Add a note…')}.`,
            `**Songs not imported yet**: a note written about a file in ${qe('Folders')} links itself to the song once you import the file in Serato (matched by its location).`,
            `**Songs to find**: no link needed, just write "Artist - Title". Once you have it, press ${qe('Link a song…')}: the search starts with the note's first line, so Enter links it.`,
            '**#tags**: write #opener, #transition or #to-buy in the text; the tags appear above the list and a click shows only those notes.',
          ],
        },
        `In ${qe('Sort')}, the newest notes of the selected song show on the right. A deleted note comes back with ${qe('Undo')}, and ${qe('Export')} saves all notes as a Markdown file.`,
        { go: 'notes' },
      ],
    },
    { id: 'keys', title: _('Keyboard shortcuts'), blocks: ['**Right-click menus**: right-click (or control-click) a song, a crate or a folder for the common actions, such as adding to a crate, showing it in Finder or expanding everything below.', { shortcuts: true }] },
    {
      id: 'data',
      title: 'Where things are stored',
      blocks: [
        { list: ['Plan, screening marks, notes, settings: `~/Library/Application Support/Cratify/`', 'Backups from before applying: `~/Cratify Backups/`'] },
        'Cratify never edits your music files. It only moves files to the Trash when you ask it to, or when an applied plan rejects a song.',
        `**Music folders**: ${qe('Folders')} scans only the folders you choose, and missing files are looked for there and in ~/Music. On the first start Cratify suggests them from where the songs in your Serato library are; change them with "Music folders" at the top right of ${qe('Folders')}.`,
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

const VIEW_LABELS = { home: 'Overview', folders: 'Folders', inbox: 'Sort', quality: 'Quality', plan: 'Plan', notes: 'Notes' };

export function createGuideView({ navigate } = {}) {
  const sections = lang === 'zh' ? zhContent() : enContent();
  const version = h('div', { class: 'guide-version muted small' });
  fetch('/api/settings')
    .then((r) => r.json())
    .then((s) => (version.textContent = _('Cratify {version}', { version: s.version })))
    .catch(() => {});
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
    version,
  );
  const el = h('div', { class: 'view guide' }, h('div', { class: 'guide-inner' }, toc, body));
  return { el, title: _('Guide'), update() {}, onKey: () => false, destroy() {} };
}
