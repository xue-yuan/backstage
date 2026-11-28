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
      title: 'Cratify 簡介',
      blocks: [
        'Cratify 用於整理 Serato DJ 的曲庫：篩選新歌曲、將歌曲分類到 crate、清理重複與遺失的檔案，以及調整 crate 結構。',
        `**平時僅讀取資料。** Cratify 讀取的是 Serato 資料庫的複本，Serato 開啟時也可使用。所有修改都會先加入${q('Plan')}，**只有執行${q('Apply to Serato…')}才會寫入 Serato**。`,
        '唯一會移動檔案的操作是「丟到垃圾桶」：檔案會移到 Mac 的垃圾桶而非直接刪除，清空垃圾桶前皆可還原。',
      ],
    },
    {
      id: 'flow',
      title: '建議流程',
      blocks: [
        {
          steps: [
            `**${_('Overview')}**：查看待處理事項，點選卡片即可前往對應頁面。`,
            `**${_('Folders')}**：篩選尚未匯入 Serato 的新歌曲。按 X 淘汰、V 保留，再以${q('Review and move to Trash…')}將淘汰的檔案丟到垃圾桶。保留的歌曲可用${q('Add to Serato…')}加入變更計畫（例如新增「Inbox / 資料夾名稱」），套用後在 Serato 中執行「Analyze Files」；也可以在 Serato 中將資料夾拖到 Inbox 下的 crate。`,
            `**${_('Sort')}**：將 Inbox 中的歌曲逐一分類到正式的 crate。`,
            `**${_('Cleanup')}**：處理${q('Missing files')}、${q('Duplicates')}與${q('Empty crates')}。`,
            `**${_('Quality')}**：檢查新歌曲是否為假 320k 或假無損（需手動執行，詳見下方「假音質」）。`,
            `**${_('Crates')}**：重新命名、移動、合併、刪除 crate，或調整順序（拖到兩個 crate 之間，或選取後按 ⌥↑ ⌥↓）。`,
            `**${_('Plan')}**：確認變更內容，結束 Serato DJ 後執行${q('Apply to Serato…')}。`,
          ],
        },
        { go: 'home' },
      ],
    },
    {
      id: 'sort',
      title: _('Sort'),
      blocks: [
        `從左側選擇來源：${q('In no crate')}、${q('Added in the last {n} days').replace('{n}', 'N')}、資料夾，或${q('Sort from a crate')}中 Inbox 下的 crate。數字代表**尚未分類的歌曲數**，完成後顯示 ✓。`,
        `**「已分類」的定義**：歌曲至少位於一個正式的 crate 中。Inbox 及其下的 crate，以及整個資料夾拖入所建立的 crate，皆計為未分類。可在${q('Crates')}中透過${q('Unsorted…')}調整哪些 crate 計為未分類。`,
        {
          list: [
            `**1–9**：加入釘選的 crate，再按一次可取消。以${q('+ Pin')}釘選常用的 crate。`,
            '**⇧1–5**：加入建議的 crate。',
            '**/**：搜尋其他 crate；輸入「上層 / 新名稱」可直接建立新的 crate。',
            '**X**：淘汰此歌曲。套用時從 Serato 移除，並將檔案丟到垃圾桶。',
            '**⇧X**：僅從 Serato 曲庫移除並保留檔案（適用於取樣音效、Demo 歌曲等）。',
            '**N**：前往下一個仍有歌曲的 crate。',
          ],
        },
        `${q('Remove from the source crate when adding')}：從 Inbox 的 crate 分類時預設開啟，已分類的歌曲會移出 Inbox。`,
        `${q('Remove {n} sorted songs from this crate').replace('{n}', 'N')}：將已在正式 crate 中、但仍留在 Inbox 的歌曲一次移出。`,
        '歌曲列表上方可切換顯示「全部」、「尚未分類」或「只顯示已分類」。',
        { go: 'inbox' },
      ],
    },
    {
      id: 'preview',
      title: '試聽',
      blocks: [
        '選取歌曲後按空白鍵。新歌曲**從 30% 開始播放**（DJ 版本的前奏通常較長），可在播放列右側調整。',
        'Q 回到開頭，W E R 跳到 25% / 50% / 75%，← → 倒退或快轉 10 秒（按住 ⇧ 為 30 秒）。',
        { tip: '試聽使用 Mac 的預設音訊輸出。演出期間請確認試聽的聲音不會傳到現場音響。' },
      ],
    },
    {
      id: 'no-crate',
      title: '不在任何 crate 的歌曲',
      blocks: [
        `在${q('Sort')}中選擇${q('In no crate')}。這類歌曲通常分為三種：`,
        {
          list: [
            '**一般歌曲**：照常分類到 crate。',
            '**非音樂檔案**（rekordbox 的取樣音效、Pioneer 的 Demo、桌面上的暫存檔）：按 ⇧X 從 Serato 移除並保留檔案。',
            `**標示為${q('Missing file')}的歌曲**：在${q('Cleanup')} › ${q('Missing files')}中重新指定位置、合併到同一首歌曲的其他記錄，或從曲庫移除。`,
          ],
        },
      ],
    },
    {
      id: 'fake',
      title: '假音質（假 320k、假無損）',
      blocks: [
        '部分標示為 MP3 320 或 WAV 的檔案，實際上是由較低音質的檔案轉檔而來，例如將 128k 的 MP3 另存為 320k。檔案變大，音質並不會提升。',
        '**判斷原理**：編碼器會切除高頻，位元率越低切除越多：128k 約在 16.5 kHz、192k 約在 19 kHz、320k 約在 20 kHz，真正的無損可達 22 kHz。轉檔無法還原被切除的部分，因此標示為 320、但 16.5 kHz 以上完全沒有聲音的檔案，來源即為 128k。',
        `**使用${q('Quality')}檢查**：為節省電力，檢查**不會自動執行**，需在${q('Quality')}中按「檢查 N 個新檔案」。已檢查的檔案會保留結果，之後只檢查新增或變更的檔案。Serato 分析或新增 cue 點時會寫入音樂檔，但不改變聲音；Cratify 會比對音訊指紋，不會重新檢查這些檔案。速度可以調整（省電模式一次 1 個檔案），所有速度皆以低優先權執行，不影響 Serato，且可隨時停止。疑似轉檔的檔案會在音質旁標示橘色的${q('Suspect')}；${q('Quality')}會列出所有可疑檔案，可試聽、檢視頻譜，並標為正常或淘汰。合併重複曲目時會優先保留未標示可疑的版本。`,
        { tip: '「可疑」為自動判斷，僅供參考。刪除或替換檔案前，請務必檢視頻譜並試聽。高頻本來就較少的歌曲（老錄音、lo-fi、部分爵士樂）也可能被標示；未被標示也不保證音質正常。標為正常的檔案不會再顯示為可疑。' },
        '**手動檢查步驟**：',
        {
          steps: [
            `在歌曲上按右鍵 → ${q('Spectrum')}（「分類新歌」右側與重複曲目的每一列也有${q('Spectrum')}按鈕）。也可使用免費的 Spek，或 Audacity 的頻譜圖模式。`,
            '觀察彩色區域的**上緣**：真正的 MP3 320 約可達 20 kHz。若整首歌曲在 16 kHz 處有**平整的上限**，來源為 128k；約 19 kHz 則為 192k。',
            '請檢視**整首歌曲**，而非單一段落：前奏與安靜段落的高頻本來就較少。轉檔造成的上限是一條貫穿整首、平直的線；自然的高頻會隨音樂起伏。',
            'WAV、AIFF 亦同：若在 16–20 kHz 有平整的上限，即為由 MP3 轉成的「假無損」。Mashup pack 常混合不同來源，前後段的上限可能不同。',
            '以品質較好的耳機聆聽鈸、hi-hat 與人聲齒音：轉檔的檔案常聽起來較悶，或帶有類似水聲的失真。',
            '仍無法確定時，可與可靠來源的版本比對（Beatport、Bandcamp 的試聽或購買的檔案）。',
          ],
        },
        `**確認為轉檔後**：從可靠來源重新購買或下載，在 Serato 匯入後於${q('Cleanup')} › ${q('Duplicates')}合併並保留新的版本（crate 會一併轉移），舊檔案可同時丟到垃圾桶。`,
        '此功能需要 ffmpeg（在終端機執行 `brew install ffmpeg`）。未安裝時不會顯示「可疑」標示與「頻譜」按鈕。',
        { go: 'quality' },
      ],
    },
    {
      id: 'plan',
      title: '變更計畫與復原',
      blocks: [
        `${q('Summary')}依動作類型分組，例如「Inbox / 0425 → 12 首分到 Future House / 延伸」。展開群組可個別復原，也可整組復原。`,
        `${q('History')}依時間列出所有變更。⌘Z 可復原最後一個變更。`,
        '分頁上的數字為尚未套用的變更數，Mac app 的 Dock 圖示也會顯示。變更計畫會自動儲存，關閉 app 後仍會保留。',
        { go: 'plan' },
      ],
    },
    {
      id: 'apply',
      title: _('Apply to Serato'),
      blocks: [
        {
          steps: [
            '**結束 Serato DJ。** Serato 執行中時無法套用。',
            `在${q('Plan')}中執行${q('Apply to Serato…')}。`,
            'Cratify 會先在複本上測試、自動備份 Serato 資料庫，寫入後再次驗證。**任一步驟失敗即不寫入。**',
            `打開 Serato DJ 確認結果。如有問題，請結束 Serato，再到${q('Plan')}執行${q('Restore the backup from before the last apply')}。`,
          ],
        },
        '每次套用前的備份位於 `~/Cratify Backups/Serato Library/`。淘汰歌曲的檔案會在套用成功後才丟到垃圾桶。',
      ],
    },
    {
      id: 'notes',
      title: _('Notes'),
      blocks: [
        '可記錄任何與歌曲相關的內容，例如適合開場的歌曲、從第二段 drop 混出、在他人 set 中聽到並想尋找的歌曲。筆記只儲存在 Cratify（`notes.json`），**不會寫入 Serato**。',
        {
          list: [
            `**連結歌曲**：撰寫筆記時按${q('Link a song…')}，或一鍵連結正在播放的歌曲。也可在${q('Sort')}按 M，或在歌曲上按右鍵 →${q('Add a note…')}。`,
            `**尚未匯入的歌曲**：在${q('Folders')}中為尚未匯入的檔案撰寫筆記，於 Serato 匯入後，筆記會依檔案位置自動連結到該歌曲。`,
            `**想尋找的歌曲**：無須連結，直接寫下「歌手 - 歌名」。匯入後按${q('Link a song…')}，搜尋框會自動帶入筆記第一行，按 Enter 即可連結。`,
            '**#標籤**：在內容中寫入 #開場、#轉場、#待購 等標籤，列表上方會顯示對應的標籤，點選即可篩選。',
          ],
        },
        `在${q('Sort')}中選取有筆記的歌曲時，右側會顯示最近的筆記。刪除的筆記可按${q('Undo')}復原；${q('Export')}可將所有筆記存成 Markdown 檔。`,
        { go: 'notes' },
      ],
    },
    { id: 'keys', title: _('Keyboard shortcuts'), blocks: ['**右鍵選單**：在歌曲、crate 或資料夾上按右鍵（或 Control 加點按），即可使用常用動作，例如加入 crate、在 Finder 中顯示、展開所有子項目。', { shortcuts: true }] },
    {
      id: 'data',
      title: '資料儲存位置',
      blocks: [
        {
          list: [
            '變更計畫、篩選標記、筆記、設定：`~/Library/Application Support/Cratify/`',
            '套用前的備份：`~/Cratify Backups/`',
          ],
        },
        'Cratify 不會修改音樂檔本身，只會在執行「丟到垃圾桶」或套用淘汰歌曲時，將檔案移到垃圾桶。',
        `**音樂資料夾**：${q('Folders')}只掃描指定的資料夾，遺失的檔案也會在這些資料夾與 ~/Music 中搜尋。首次啟動時會依 Serato 曲庫中歌曲的位置建議資料夾，之後可在${q('Folders')}右上角的「音樂資料夾」修改。`,
      ],
    },
  ];
}

function enContent() {
  return [
    {
      id: 'about',
      title: 'About Cratify',
      blocks: [
        'Cratify organises a Serato DJ library: screening new songs, sorting songs into crates, cleaning up duplicates and missing files, and restructuring crates.',
        `**Read-only by default.** Cratify works on a copy of the Serato database, so Serato can stay open. Every edit goes into the ${qe('Plan')} first; **only ${qe('Apply to Serato…')} writes to Serato**.`,
        'The only action that moves files is moving them to the Trash. Files are not deleted and can be restored until the Trash is emptied.',
      ],
    },
    {
      id: 'flow',
      title: 'Suggested workflow',
      blocks: [
        {
          steps: [
            `**${_('Overview')}**: what is left to do. Each card opens the view that handles it.`,
            `**${_('Folders')}**: screen new songs that are not in Serato yet. Press X to reject and V to keep, then use ${qe('Review and move to Trash…')}. ${qe('Add to Serato…')} puts the kept songs in the plan (for example into a new "Inbox / folder name" crate); after applying, run "Analyze Files" on them in Serato. Dragging the folder into a crate under Inbox in Serato also works.`,
            `**${_('Sort')}**: sort the songs in Inbox into permanent crates.`,
            `**${_('Cleanup')}**: ${qe('Missing files')}, ${qe('Duplicates')} and ${qe('Empty crates')}.`,
            `**${_('Quality')}**: check new songs for fake 320k and fake lossless files. The check runs only when started; see "Fake quality" below.`,
            `**${_('Crates')}**: rename, move, merge, delete and reorder crates (drag between two crates, or select one and press ⌥↑ ⌥↓).`,
            `**${_('Plan')}**: review the changes, quit Serato DJ and press ${qe('Apply to Serato…')}.`,
          ],
        },
        { go: 'home' },
      ],
    },
    {
      id: 'sort',
      title: _('Sort'),
      blocks: [
        `Choose a source on the left: ${qe('In no crate')}, recently added songs, a folder, or one of the Inbox crates. The numbers show **how many songs are left**; a finished source shows ✓.`,
        `**Sorted** means the song is in at least one permanent crate. Inbox and everything under it, and crates created by dragging a whole folder into Serato, count as unsorted. To change which crates count as unsorted, use ${qe('Unsorted…')} in ${qe('Crates')}.`,
        {
          list: [
            `**1–9**: add to a pinned crate; press again to undo. Pin crates with ${qe('+ Pin')}.`,
            '**⇧1–5**: add to a suggested crate.',
            '**/**: search other crates; type "Parent / New name" to create one.',
            '**X**: reject the song. Applying the plan removes it from Serato and moves its file to the Trash.',
            '**⇧X**: remove the song from the Serato library only and keep the file (samples, demo tracks).',
            '**N**: next crate with songs left.',
          ],
        },
        `${qe('Remove from the source crate when adding')} is on by default for Inbox crates, so sorted songs leave Inbox.`,
        `${qe('Remove {n} sorted songs from this crate').replace('{n}', 'N')} removes songs that are already in a permanent crate but still in the Inbox crate.`,
        'The filter above the song list shows all songs, only unsorted songs, or only sorted songs.',
        { go: 'inbox' },
      ],
    },
    {
      id: 'preview',
      title: 'Previewing songs',
      blocks: [
        'Select a song and press Space. New songs **start at 30%** because DJ edits have long intros; change this in the player bar.',
        'Q returns to the start, W E R jump to 25% / 50% / 75%, and ← → skip 10 s (30 s with ⇧).',
        { tip: 'Previews play through the Mac’s default audio output. During a set, make sure previews do not reach the speakers.' },
      ],
    },
    {
      id: 'no-crate',
      title: 'Songs in no crate',
      blocks: [
        `In ${qe('Sort')}, choose ${qe('In no crate')}. These songs are usually one of three kinds:`,
        {
          list: [
            '**Regular songs**: sort them into crates as usual.',
            '**Files that are not music** (rekordbox samples, Pioneer demo tracks, temporary files on the Desktop): press ⇧X to remove them from Serato and keep the files.',
            `**Songs marked ${qe('Missing file')}**: in ${qe('Cleanup')} › ${qe('Missing files')}, relocate them, merge them into another record of the same song, or remove them.`,
          ],
        },
      ],
    },
    {
      id: 'fake',
      title: 'Fake quality (fake 320k, fake lossless)',
      blocks: [
        'Some files labelled MP3 320 or WAV were converted from a lower-quality source, for example a 128k MP3 saved again as 320k. The file becomes larger, but the sound does not improve.',
        '**How it is detected**: encoders cut the highest frequencies, and lower bit rates cut more: about 16.5 kHz at 128k, 19 kHz at 192k and 20 kHz at 320k, while genuine lossless audio reaches 22 kHz. Converting cannot restore what was cut, so an "MP3 320" with nothing above 16.5 kHz was made from a 128k file.',
        `**Checking in ${qe('Quality')}**: to save power, the check **does not run automatically**; press "Check N new files" in ${qe('Quality')}. Results are kept, so each run checks only new or changed files. Serato writes analysis and cue points into music files without changing the sound; Cratify compares an audio fingerprint and does not check those files again. The speed can be set (power saving checks one file at a time); every speed runs at low priority, does not affect Serato, and can be stopped at any time. Files that look converted get an orange ${qe('Suspect')} mark next to their quality. ${qe('Quality')} lists them all for listening, viewing the spectrum, and marking each one as genuine or rejecting it. When merging duplicates, the copy that is not suspect is preferred.`,
        { tip: '"Suspect" is an automatic estimate, not proof. Always check the spectrum and listen before deleting or replacing a file. Songs with little high-frequency content (old or lo-fi recordings, some jazz) can be marked as well, and an unmarked file is not guaranteed to be genuine. Files marked as genuine are no longer flagged.' },
        '**Checking by hand**:',
        {
          steps: [
            `Right-click a song → ${qe('Spectrum')} (Sort and each duplicate row also have a ${qe('Spectrum')} button). The free app Spek or the spectrogram view in Audacity also work.`,
            'Look at the **top edge** of the coloured area. A genuine MP3 320 reaches about 20 kHz. A **flat ceiling** across the whole song at about 16 kHz indicates a 128k source; about 19 kHz indicates 192k.',
            "Look at the **whole song**, not a single part: intros and quiet passages have little high-frequency content anyway. A transcode's limit is a straight line through the whole song; natural high frequencies move with the music.",
            'The same applies to WAV and AIFF: a flat ceiling between 16 and 20 kHz indicates a "fake lossless" file made from an MP3. Mashup packs often combine sources, so the ceiling can change between sections.',
            'Listen on good headphones to cymbals, hi-hats and sibilants: transcodes often sound dull or have a watery, swirling distortion.',
            'If still unsure, compare with a copy from a trusted source (a Beatport or Bandcamp preview or purchase).',
          ],
        },
        `**Once confirmed**: buy or download the song again from a trusted source, import it in Serato, then merge in ${qe('Cleanup')} › ${qe('Duplicates')} and keep the new copy (its crates move over). The old file can be moved to the Trash at the same time.`,
        'This feature requires ffmpeg (run `brew install ffmpeg` in Terminal). Without it, the Suspect marks and Spectrum buttons are hidden.',
        { go: 'quality' },
      ],
    },
    {
      id: 'plan',
      title: 'The plan and undo',
      blocks: [
        `${qe('Summary')} groups actions by type, for example "Inbox / 0425 → 12 songs into Future House / Build Up". Expand a group to undo single items, or undo the whole group.`,
        `${qe('History')} lists every change in order. ⌘Z undoes the last change.`,
        'The number on the tab is the count of changes not yet applied; the Mac app also shows it on its Dock icon. The plan is saved automatically.',
        { go: 'plan' },
      ],
    },
    {
      id: 'apply',
      title: _('Apply to Serato'),
      blocks: [
        {
          steps: [
            '**Quit Serato DJ.** Cratify does not apply while Serato is running.',
            `In ${qe('Plan')}, press ${qe('Apply to Serato…')}.`,
            'Cratify tests the changes on a copy, backs up the Serato database, writes, and verifies the result. **If any step fails, nothing is written.**',
            `Open Serato DJ and check the result. If something is wrong, quit Serato and press ${qe('Restore the backup from before the last apply')} in ${qe('Plan')}.`,
          ],
        },
        'Backups made before each apply are in `~/Cratify Backups/Serato Library/`. Files of rejected songs are moved to the Trash only after the apply succeeds.',
      ],
    },
    {
      id: 'notes',
      title: _('Notes'),
      blocks: [
        "Notes can hold anything about songs: a good opener, where to mix out, a song heard in someone else's set. Notes are stored by Cratify only (`notes.json`) and **are never written to Serato**.",
        {
          list: [
            `**Linking a song**: press ${qe('Link a song…')} while writing, or link the song that is playing with one click. Notes can also be added with M in ${qe('Sort')}, or by right-clicking a song → ${qe('Add a note…')}.`,
            `**Songs not imported yet**: a note about a file in ${qe('Folders')} links itself to the song once the file is imported in Serato (matched by file location).`,
            `**Songs to find**: no link is needed; write "Artist - Title". Once the song is imported, press ${qe('Link a song…')}: the search starts with the note's first line, so Enter links it.`,
            '**#tags**: write #opener, #transition or #to-buy in the text. Tags appear above the list; click one to show only those notes.',
          ],
        },
        `In ${qe('Sort')}, the newest notes of the selected song appear on the right. ${qe('Undo')} restores a deleted note, and ${qe('Export')} saves all notes as a Markdown file.`,
        { go: 'notes' },
      ],
    },
    { id: 'keys', title: _('Keyboard shortcuts'), blocks: ['**Right-click menus**: right-click (or Control-click) a song, crate or folder for common actions, such as adding to a crate, showing in Finder or expanding everything below.', { shortcuts: true }] },
    {
      id: 'data',
      title: 'Where data is stored',
      blocks: [
        { list: ['Plan, screening marks, notes and settings: `~/Library/Application Support/Cratify/`', 'Backups made before applying: `~/Cratify Backups/`'] },
        'Cratify never edits music files. It moves files to the Trash only on request, or when an applied plan rejects a song.',
        `**Music folders**: ${qe('Folders')} scans only the selected folders, and missing files are searched for there and in ~/Music. On first launch, Cratify suggests folders based on where the songs in the Serato library are; change them with "Music folders" at the top right of ${qe('Folders')}.`,
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
