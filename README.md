# Cratify

A local app for organising a Serato DJ 4 library: see which folders are already sorted into crates, screen new music, sort songs into crates quickly, clean up missing files and duplicates, reshape the crate tree, and write the result back to Serato in one verified step.

The interface is in English or Traditional Chinese (the language button at the top right switches it).

Cratify is an independent project, not made by or affiliated with Serato. It writes to Serato DJ's own library database; read [Disclaimer](#disclaimer) before using it on your library.

## Install

Requirements:

- macOS 12 or later. The release builds are for Apple silicon.
- Serato DJ Pro 4.0. "Apply to Serato" writes only to the database version Cratify was verified with (version 202) and refuses others.
- [uv](https://docs.astral.sh/uv/), which provides the Python that runs Cratify's local server. In Terminal: `brew install uv`, then `uv python install 3.14` (any Python 3.12 or later that uv manages works). Without it the app shows what to install instead of starting.
- Optional: ffmpeg for the transcode check in Quality (`brew install ffmpeg`). Everything else works without it.

Then:

1. Download `Cratify-<version>-mac-arm64.zip` from the GitHub Releases page, unzip it and move `Cratify.app` to Applications.
2. The app is not signed by Apple yet, so the first time macOS blocks it ("Apple could not verify…"). Open System Settings → Privacy & Security, scroll down and press "Open Anyway" next to Cratify. Or run `xattr -dr com.apple.quarantine /Applications/Cratify.app` in Terminal once.
3. On the first start Cratify asks which folders hold your DJ music (see Music folders).

Quit Serato DJ before pressing "Apply to Serato"; everything else works with Serato open.

## Building the Mac app

```bash
pnpm install          # first time: installs the Tauri CLI
pnpm app:build        # builds src-tauri/target/release/bundle/macos/Cratify.app
```

The Mac app is a Tauri window. On launch it starts the same Python server in the background (fixed at `127.0.0.1:47615`) and stops it when the app quits. If something else already uses that port, the app says what: the old Backstage app, another copy of Cratify, or another program.

Python comes from [uv](https://docs.astral.sh/uv/): the app runs the uv-managed interpreter that `uv python find --managed-python ">=3.12"` returns, never the system Python. If none is installed, run `uv python install 3.14`.

Data lives in `~/Library/Application Support/Cratify/`:

- the Serato snapshot
- the plan
- screening marks
- notes (`notes.json`; `notes.prev.json` keeps the version before the last save)
- unsorted-crate rules
- settings (`settings.json`: interface language and music folders)
- the audio-format cache and the transcode-check cache (`spectrum.json`)
- the trash log
- `app.log` and `server.log`

### Releasing

The version number lives in `package.json`. The Mac app takes it from there (`"version": "../package.json"` in `tauri.conf.json`), the server reads the bundled copy and the Guide shows it. `src-tauri/Cargo.toml` keeps the same number.

1. Write the release notes as a `## <version>` section at the top of `CHANGELOG.md`.
2. Set the version in `package.json` and `src-tauri/Cargo.toml`.
3. `pnpm app:release` (`tools/package_release.sh`): checks that both versions match and the notes exist, builds the app, zips it with `ditto` into `dist/Cratify-<version>-mac-arm64.zip` (keeps the signature and attributes), writes `dist/release-notes.md`, and prints the checksum and the `gh release create` command. It publishes nothing by itself.
4. Try the zip: unzip it, open the app and check the version in the Guide (ideally on a Mac or user account that never ran Cratify, to see the first start).
5. Commit, tag `v<version>`, and run the printed `gh release create` command.

The build is for the Mac it runs on (Apple silicon here). For Intel Macs too: `rustup target add x86_64-apple-darwin`, then build with `pnpm tauri build --bundles app --target universal-apple-darwin`. Signing with a Developer ID and notarizing (Apple Developer Program) would remove the "Open Anyway" step: set `signingIdentity` in `tauri.conf.json` and `APPLE_ID`, `APPLE_PASSWORD` and `APPLE_TEAM_ID` when building.

## Running in a browser

```bash
uv run --no-project app.py            # opens http://127.0.0.1:8765 (same data folder as the Mac app)
uv run --no-project app.py --port 9000 --no-browser
```

The server uses only the Python standard library and the front end is plain JavaScript; there are no packages to install. Do not run the browser version and the Mac app at the same time: both write the same plan.

## Watching Serato

While the page is open it asks the server every few seconds whether Serato DJ is running and whether its library changed since the last snapshot (size and modification time of `master.sqlite` and its WAL; Serato's files are never opened). After a change it reloads the snapshot once the database has been quiet for 2 seconds (15 seconds while Serato is open, so a set is not interrupted by reloads). When Serato DJ closes and the plan has changes that can be applied, it offers to apply them.

## Music folders

The Folders view scans the music folders, and finding missing files searches them and `~/Music`. On the first start Cratify suggests folders from where the songs in the Serato library are (in each area, such as `~/Music` or a drive under `/Volumes`, the deepest folder that holds 80% of its songs) and asks once to confirm them. Change them later with "Music folders" at the top right of Folders: pick a folder with the macOS dialog or paste a path. They are saved in `settings.json`. A folder on a drive that is not connected is shown as not found and skipped.

## Language

The interface is in English and Traditional Chinese. Until you choose, it follows the Mac's language: Traditional Chinese when Chinese comes first in System Settings → General → Language & Region, English otherwise. The button at the top right switches. The choice is saved in the page and in `settings.json` in the data folder, so server messages and the Mac app's startup messages follow it.

Strings are written in English in the code and wrapped in `_()` / `_n()` (front end, `static/js/i18n.js`) or `tr()` / `trn()` (server, `serato_crates/i18n.py`). Chinese translations live in `static/js/locales/zh-Hant.js`, `serato_crates/locale_zh.py` and `src-tauri/src/locale_zh.rs`, keyed by the English text.

## Views

| View | What it does |
|---|---|
| Overview | The start page: songs left to sort, files left to screen per folder, staged changes (with Apply when Serato is closed), and library health (missing files, duplicates, empty crates, low quality, suspected transcodes). Every card opens the view that handles it |
| Folders | Scans the music folders (see Music folders) and labels every song: sorted, unsorted, not imported, copy, rejected or missing. Shows which folders are done, real audio format and quality, lets you screen files, add songs to Serato (see Adding songs to Serato) and open folders in Finder |
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

These defaults follow one way of working: new music lands in crates under `Inbox` (for example "Inbox / 2026-12 Beatport", or a folder dragged into Serato), and is then sorted into genre or set crates. "Tidy up into Inbox…" moves every unsorted crate under `Inbox` and collects the songs in the music folders that are in no crate into "Inbox / Unsorted songs" (named in the interface language; an existing one in either language is reused). If you work differently, mark or unmark crates as unsorted instead: nothing is moved unless you press "Tidy up into Inbox…", and every change still goes through the plan.

Crates named by a BPM range (like "Open Format / 120-129 / All") are understood too: when suggesting crates in Sort, the song's BPM decides which range fits.

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

### Adding songs to Serato

In Folders, songs that are not in Serato can be added from Cratify: the button in a folder's screening note, or right-click a folder or a file → "Add to Serato…". Pick where they go: a new crate "Inbox / folder name" (like dragging the folder into Serato), another crate, or only the library. Songs that look like ones Serato already has (same artist and title) are skipped unless you untick that. The songs go into the plan ("Adding to Serato" in Folders, "+ N songs" in Crates) and are added when the plan is applied.

Applying writes what Serato's own import writes, which was worked out by comparing Serato's database before and after it imported single files and folders: one song row and one "Serato Library" row in each of `master.sqlite` and `root.sqlite`, plus the crate rows. Cratify fills only what describes the file (file name, size, bit rate, sample rate and length from macOS `afinfo`, the same numbers Serato stores) and the title tag; every other column gets the database default, which is what Serato stores itself. Serato's database computes a few columns with functions that only exist inside Serato DJ (search text and key number); Cratify registers equivalents under the same names, equal to Serato's for 99.998 % of a real library's values, and Serato recomputes them with its own the next time it updates the song. Both files allow only one song per file path, so a song can never be added twice, also not by dragging it into Serato later.

Afterwards, select the songs in Serato DJ (for example their crate) and choose "Analyze Files": Serato reads the other tags (artist, album, key…) and works out BPM, beatgrid and waveform. The Apply result says so too. Tried on the real library: the song shows in its crate and in all songs, search finds it, it plays, and Serato read its tags and BPM when it was loaded on a deck.

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
3. It backs up `master.sqlite` and `root.sqlite` to `~/Cratify Backups/` (a timestamped folder per apply).
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
- add songs from disk to the library, optionally into a crate (see Adding songs to Serato)
- remove songs from the library, the way Serato's own ⌘⌫ does: their crate memberships go, play history is kept. For rejected songs, the files go to the Trash only after the database write has been committed.

`serato_crates/apply.py` documents the Serato 4 database layout.

## Safety

- Serato DJ 4 keeps its library in `~/Library/Application Support/Serato/Library/`: `master.sqlite`, with `root.sqlite` for the local drive. The legacy `~/Music/_Serato_` files are no longer read by Serato 4.
- **Reading**: the app never opens Serato's live files for reading. Even a read-only SQLite connection writes to `-shm`. It copies the bytes of `master.sqlite` and its `-wal`, checks nothing changed while copying, and works on that snapshot. This is safe while Serato is open.
- **Writing**: Serato is written only by "Apply to Serato" (Serato closed, rehearsed, backed up, verified) and by `tools/serato_move_paths.py`. `tools/serato_import_poc.py` is a proof of concept that adds one song the way Serato's import does (title and file details only; Serato's analysis fills the rest), with the same safety steps; it only rehearses on a copy unless given `--apply`. `tools/serato_apply_ops.py` applies a list of plan actions from a JSON file the same way (used to clean up after testing); it never moves music files. The tool rewrites file paths after music folders were moved; it also requires Serato to be closed and only does a dry run without `--apply`.
- **The server**: it listens on `127.0.0.1` only and checks the Host header. Writes must be JSON. Audio preview only serves files that are in the library or found by the folder scan.

## Disclaimer

Cratify is an independent project. It is not made by, affiliated with or endorsed by Serato, and it does not use Serato's logos. Serato and Serato DJ are trademarks of their owner.

Serato DJ's library database is private and undocumented. What Cratify knows about it was worked out by comparing the database before and after Serato's own actions, and `serato_crates/apply.py` documents it. Cratify writes to it only when you press "Apply to Serato", with Serato closed, after rehearsing the changes on a copy and backing the database up to `~/Cratify Backups/`; it checks the result before committing, and refuses database versions it has not been verified with. Even so, a Serato update or an untested library could behave differently. Keep your own backups too, and use Cratify at your own risk. The software is provided as is, without warranty.

## Limitations

- The Folders report only scans the music folders; finding missing files searches them and `~/Music`. Choosing a folder in `~/Downloads`, `~/Documents` or `~/Desktop` makes macOS ask for permission the first time it is scanned.
- Songs added by Cratify are not analysed: select them in Serato and choose "Analyze Files" (loading one on a deck analyses it too). Dragging files into Serato analyses them on import.
- In a browser, Chrome cannot play AIFF. Safari and the Mac app can.
- Only the local Serato Library is handled; streaming playlists do not appear.
