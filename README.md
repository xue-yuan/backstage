# Backstage

A local app for organising a Serato DJ 4 library: see which folders are already sorted into crates, screen new music, sort songs into crates quickly, clean up missing files and duplicates, reshape the crate tree, and write the result back to Serato in one verified step.

The interface is in Traditional Chinese.

## Mac app

```bash
pnpm install          # first time: installs the Tauri CLI
pnpm app:build        # builds src-tauri/target/release/bundle/macos/Backstage.app
```

The Mac app is a Tauri window. On launch it starts the same Python server in the background (fixed at `127.0.0.1:47615`) and stops it when the app quits.

Python comes from [uv](https://docs.astral.sh/uv/): the app runs the uv-managed interpreter that `uv python find --managed-python ">=3.12"` returns, never the system Python. If none is installed, run `uv python install 3.14`.

Data lives in `~/Library/Application Support/Backstage/`:

- the Serato snapshot
- the plan
- screening marks
- notes (`notes.json`; `notes.prev.json` keeps the version before the last save)
- unsorted-crate rules
- the audio-format cache and the transcode-check cache (`spectrum.json`)
- the trash log
- `app.log` and `server.log`

## Running in a browser

```bash
uv run --no-project app.py            # opens http://127.0.0.1:8765 (same data folder as the Mac app)
uv run --no-project app.py --port 9000 --no-browser
```

The server uses only the Python standard library and the front end is plain JavaScript; there are no packages to install. Do not run the browser version and the Mac app at the same time: both write the same plan.

## Watching Serato

While the page is open it asks the server every few seconds whether Serato DJ is running and whether its library changed since the last snapshot (size and modification time of `master.sqlite` and its WAL; Serato's files are never opened). After a change it reloads the snapshot once the database has been quiet for 2 seconds (15 seconds while Serato is open, so a set is not interrupted by reloads). When Serato DJ closes and the plan has changes that can be applied, it offers to apply them.

## Language

The interface is in English by default; the button at the top right switches to Traditional Chinese and back. The choice is saved in the page and in `settings.json` in the data folder, so server messages and the Mac app's startup messages follow it.

Strings are written in English in the code and wrapped in `_()` / `_n()` (front end, `static/js/i18n.js`) or `tr()` / `trn()` (server, `serato_crates/i18n.py`). Chinese translations live in `static/js/locales/zh-Hant.js`, `serato_crates/locale_zh.py` and `src-tauri/src/locale_zh.rs`, keyed by the English text.

## Views

| View | What it does |
|---|---|
| Overview | The start page: songs left to sort, files left to screen per folder, staged changes (with Apply when Serato is closed), and library health (missing files, duplicates, empty crates, low quality, suspected transcodes). Every card opens the view that handles it |
| Folders | Scans `~/Music/DJ` and labels every song: sorted, unsorted, not imported, copy, rejected or missing. Shows which folders are done, real audio format and quality, and lets you screen files and open folders in Finder |
| Sort | Go through unsorted songs (a crate under Inbox, a disk folder, songs in no crate, recently added) and sort them. Keys 1–9 add to pinned crates, ⇧+number adds a suggested crate, `/` searches or creates a crate, `X` rejects |
| Cleanup | Missing files (relocate, or merge into the record that already points at the moved file), duplicates (keep one, merge crates), empty crates |
| Quality | Runs the transcode check by hand and lists the suspect files: listen, look at the spectrum, mark "Sounds fine", reject (see Audio quality) |
| Crates | Tree editing (drag onto a crate to move it inside, between two crates to change the order, auto-scrolls near the edges; ⌥↑ ⌥↓ and the right-click menu also reorder), rename, merge, delete, multi-select songs to add or move, mark crates as unsorted |
| Plan | Everything staged so far, undo, export, and Apply to Serato |
| Notes | Free notes about songs and songs to remember, optionally linked to a library song, with #tags, search and Markdown export (see Notes) |
| Guide | How everything works and the suggested workflow, in the interface language |

Press `?` for all keyboard shortcuts.

### Unsorted crates and Inbox

A song counts as sorted once it sits in any crate that is not "unsorted". Unsorted crates are:

- `Inbox` and everything under it (new music goes under Inbox)
- top-level crates named like TBD / Temp / Inbox
- crates that are a whole disk folder dragged into Serato (same name as the folder and holding at least 60% of its songs)
- crates you mark yourself

The unsorted-crate editor, opened from Folders or Crates, can:

- add or remove unsorted crates
- create new crates under Inbox
- tidy everything into Inbox in one step

Every crate in the Crates view also has an "unsorted" checkbox. The settings are saved in `rules.json`.

### Screening and the Trash

In Folders, click a song and screen with the keyboard:

- `↑` `↓`: next / previous song
- space: play
- `Q` `W` `E` `R`: jump to 0 / 25 / 50 / 75%
- `X`: reject
- `V`: keep

Marks are saved in `screen.json`.

What happens to rejected songs depends on whether they are in Serato:

- **Files Serato does not use**: they can be moved to the macOS Trash after a confirmation list. A fresh Serato snapshot is taken first, and any file Serato uses is refused. Each move is logged in `trash_log.jsonl` with its original path and size, so the app can restore it until the Trash is emptied. Finder's "Put Back" may not know about these items.
- **Songs that are in Serato**: they are staged in the plan instead. Applying the plan removes them from Serato and then moves their files to the Trash, with the same refusal check and log as above. `⇧X` in Sort removes a song from the library but keeps the file (samples, demo tracks).

### Audio quality

Serato only stores the file extension, which cannot tell AAC from lossless ALAC, and leaves many bit rates empty. The app reads every file's header with macOS `afinfo` and caches the result in `audio_info.json`.

- **Labels**: `AAC 256`, `MP3 320`, `WAV 24-bit`, `ALAC`. Lossless formats are shown in green.
- **Low quality** (shown in red): MP3 below 256k, AAC below 192k, or a sample rate below 44.1 kHz. AAC 256 is roughly MP3 320 and is not flagged.
- **Unreadable**: files macOS cannot open are flagged separately.
- **Suspect** (orange, optional, needs `brew install ffmpeg`): transcodes such as an MP3 320 made from a 128k file, or a WAV made from an MP3. Encoders cut the highest frequencies (about 16.5 kHz at 128k, 19 kHz at 192k, 20 kHz at 320k; lossless reaches 22 kHz), and converting cannot bring them back. `serato_crates/spectrum.py` decodes 3 × 10 s of each file with ffmpeg, measures 250 Hz bands from 14 to 22 kHz against an 8–12 kHz reference, and flags a sharp "wall" well below what the format can hold: at 19 kHz or lower for MP3 320 / AAC 256, below 17.3 kHz for 192k, at 20.6 kHz or lower for lossless. Levels are measured in floating point (ffmpeg `astats`), because `volumedetect` works in 16 bits and cannot see below about −90 dB, which hid transcodes in quiet songs. It never runs on its own (to save power): the Quality tab shows how many new or changed files are unchecked and runs the check when asked, at background priority (macOS `taskpolicy -c background`; 1, 3 or 6 files at a time) with a Stop button. Levels are cached in `spectrum.json`, so each run only checks new or changed files. Serato writes its analysis and cue points into the music file, which changes its size and date but not its sound, so each result also keeps an audio fingerprint (MD5 of the audio packets of 0–10 s and 60–70 s, read without decoding, about 0.04 s a file): a changed file with the same fingerprint keeps its result. Results from before fingerprints existed get one in a single low-priority pass the first time the Quality data is read; results from the old 16-bit meter are kept where the verdict cannot change and the rest show up as unchecked again. The Quality tab lists the suspects (listen, Spectrum, mark "Sounds fine", reject; keys `↑` `↓`, space, `Enter` for the spectrum, `F` for "Sounds fine", which moves on to the next file, and `X` to reject); right-click → Spectrum anywhere shows ffmpeg's picture of the file to check by eye. The mark is a guess: songs mastered without much high end can be flagged too, which is what "Sounds fine" is for.
- **Duplicates**: the same information is used to pick which copy to keep.

### Notes

The Notes tab is a place for thoughts about songs ("good opener", "mix out at the second drop") and for songs to remember (heard in a set, to buy). Notes are kept in `notes.json` only; they are never written to Serato.

- **Writing**: type in the box at the top and press ⌘↵. Press `N` to jump there, `/` to search.
- **Linking a song**: "Link a song…" searches the library (empty search shows the playing song and the newest songs), or one click links the song that is playing. A note keeps the song's Serato id and file path, plus title and artist to show if the song later leaves the library.
- **From other views**: right-click a song in Sort, Crates, Folders or Quality → "Add a note…", or press `M` in Sort. Sort shows the selected song's newest notes in its detail panel, and songs with notes show 📝 before their title in those lists (hover for the newest notes, click to add one).
- **Files not imported yet**: a note about a file in Folders is linked by path, so it attaches to the song once the file is imported in Serato.
- **Songs to find**: an unlinked note such as "Artist - Title" can be linked later; the search starts with the note's first line.
- **#tags** (`#opener`, `#開場`) become filter chips above the list. Delete has an Undo, and Export downloads every note as Markdown.

If `notes.json` cannot be read, the tab refuses to save rather than overwrite it.

## Apply to Serato

"Apply to Serato" in the Plan view writes the staged crate changes into Serato DJ 4's database:

1. It checks that Serato DJ is not running (by executable name) and that no process has the databases open.
2. It rehearses the whole plan on a private copy of the databases. Any problem stops it here, before Serato is touched.
3. It backs up `master.sqlite` and `root.sqlite` to `~/Backstage Backups/` (a timestamped folder per apply).
4. It writes both databases in one transaction. Root is attached as `db1`, the way Serato itself does it. Before committing it checks:
   - integrity and foreign keys
   - that master and root mirror each other
   - that every crate holds exactly the songs the app expected

   If any check fails, nothing is written.

If crates were changed in Serato after the last snapshot, the expected result will not match and the apply is refused. Press refresh and apply again.

If something looks wrong afterwards, quit Serato and use "restore the backup from before the last apply" in the Plan view.

Supported actions:

- create, rename, move, delete and merge crates
- change the order of crates within a level. Like Serato when you drag a crate, each database file renumbers that level 1…N on its own (master holds a few crates root does not); after writing, Apply checks that both files list the level in the planned order. New crates still go to the end of their level
- add songs to crates and remove them from crates
- point a song at a new file location
- remove songs from the library, the way Serato's own ⌘⌫ does: their crate memberships go, play history is kept. For rejected songs, the files go to the Trash only after the database write has been committed.

`serato_crates/apply.py` documents the Serato 4 database layout.

## Safety

- Serato DJ 4 keeps its library in `~/Library/Application Support/Serato/Library/`: `master.sqlite`, with `root.sqlite` for the local drive. The legacy `~/Music/_Serato_` files are no longer read by Serato 4.
- **Reading**: the app never opens Serato's live files for reading. Even a read-only SQLite connection writes to `-shm`. It copies the bytes of `master.sqlite` and its `-wal`, checks nothing changed while copying, and works on that snapshot. This is safe while Serato is open.
- **Writing**: Serato is written only by "Apply to Serato" (Serato closed, rehearsed, backed up, verified) and by `tools/serato_move_paths.py`. `tools/serato_import_poc.py` is a proof of concept that adds one song the way Serato's import does (title and file details only; Serato's analysis fills the rest), with the same safety steps; it only rehearses on a copy unless given `--apply`. The tool rewrites file paths after music folders were moved; it also requires Serato to be closed and only does a dry run without `--apply`.
- **The server**: it listens on `127.0.0.1` only and checks the Host header. Writes must be JSON. Audio preview only serves files that are in the library or found by the folder scan.

## Limitations

- The Folders report only scans `~/Music/DJ`. Finding missing files searches all of `~/Music`. `~/Downloads` is not scanned, because the Mac app would need an extra macOS permission for it.
- Backstage cannot import new songs yet: drag them into Serato. Serato fills some columns (search text, musical key) with its own SQL functions, so an import from Backstage would have to reproduce them; it has not been built.
- In a browser, Chrome cannot play AIFF. Safari and the Mac app can.
- Only the local Serato Library is handled; streaming playlists do not appear.
