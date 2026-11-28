# Cratify

Cratify is a Mac app for organising a Serato DJ 4 library. It shows which music folders are sorted into crates, screens new music, sorts songs into crates, cleans up missing files and duplicates, restructures the crate tree, and writes the result back to Serato in one verified step.

The interface is available in English and Traditional Chinese.

Website: https://xueyuan.dev/cratify/ · Download: [GitHub Releases](https://github.com/xue-yuan/cratify/releases/latest)

Cratify is an independent project and is not affiliated with Serato. It writes to Serato DJ's library database; read the [Disclaimer](#disclaimer) before using it.

## Install

Requirements:

- macOS 12 or later. Release builds are for Apple silicon.
- Serato DJ Pro 4.0. "Apply to Serato" writes only to the database version Cratify has been verified with (version 202) and refuses other versions.
- Optional: ffmpeg, for the transcode check in Quality (`brew install ffmpeg`).

The app includes the Python it runs on; nothing else needs to be installed.

Steps:

1. Download `Cratify-<version>-mac-arm64.zip` from GitHub Releases, unzip it and move `Cratify.app` to Applications.
2. The app is not signed by Apple yet, so macOS blocks the first launch. Open System Settings → Privacy & Security and press "Open Anyway" next to Cratify, or run `xattr -dr com.apple.quarantine /Applications/Cratify.app` once in Terminal.
3. On first launch, Cratify asks which folders contain DJ music (see [Music folders](#music-folders)).

Serato DJ can stay open while Cratify is in use. Quit it only before "Apply to Serato".

## Website

The product page is `docs/index.html` (plain HTML, no build step), published with GitHub Pages from the `docs` folder of `main`. Update the version and install steps there with each release.

## Building the Mac app

```bash
pnpm install          # first time only: installs the Tauri CLI
pnpm app:build        # builds src-tauri/target/release/bundle/macos/Cratify.app
```

Building requires [uv](https://docs.astral.sh/uv/) and a uv-managed Python 3.12 or later (`brew install uv`, then `uv python install 3.14`). `pnpm app:build` first runs `tools/bundle_python.sh`, which copies that Python (a python-build-standalone runtime) into `src-tauri/python`, leaving out what the server does not use (pip, Tk, IDLE, headers); the app bundles it as `Contents/Resources/python`. A build without it (for example `pnpm tauri build` on its own) falls back to the uv-managed Python on the user's Mac.

The Mac app is a Tauri window. On launch it starts the Python server in the background on `127.0.0.1:47615` and stops it on quit. The server runs with `-B -E -s`: it writes no bytecode into the app bundle and ignores `PYTHON*` variables and user site-packages. If the port is in use, the app reports whether the old Backstage app, another copy of Cratify or another program holds it.

Data is stored in `~/Library/Application Support/Cratify/`:

- the Serato snapshot and the plan (`plan.json`)
- screening marks (`screen.json`)
- notes (`notes.json`; `notes.prev.json` holds the version before the last save)
- unsorted-crate rules (`rules.json`)
- marks (`marks.json`): files marked genuine in Quality, duplicate groups marked as not duplicates, crates pinned in Sort
- settings (`settings.json`: interface language and music folders)
- the audio format cache (`audio_info.json`) and transcode-check cache (`spectrum.json`)
- the Trash log (`trash_log.jsonl`)
- `app.log` and `server.log`

The page edits `plan.json`, `screen.json`, `notes.json`, `rules.json` and `marks.json` as whole documents (`serato_crates/documents.py`). Each carries a revision number, and a write must name the revision it was based on. If another window changed the file in the meantime, the write is refused and the page asks to be reloaded, so two windows cannot overwrite each other's changes. The plan stores only data (op types, ids, names and i18n keys); its text is made when shown (`static/js/planText.js`), so it follows the interface language and current crate names.

### Tests

```bash
pnpm test             # server (unittest), front end (node --test) and Mac app (cargo test); no packages to install
```

- `tests/cases/plan_cases.json` lists plan cases (crate edits, songs, refused edits) that run against both the page's model (`tests/js/plan_cases.test.mjs`) and Apply to Serato (`tests/test_plan_cases.py`), so the preview and the real write agree.
- Apply is tested on a fresh, empty library built with the schema of the Serato DJ on the Mac. Serato's schema is not stored in this repository; it is read from byte copies of the local library, whose live files are never opened. These tests are skipped on a Mac without Serato DJ 4.
- `tools/check_i18n.py` (also run by the tests) checks the translation files against the code.
- The Mac app's tests (`src-tauri/src/main.rs`) cover its texts (both tables embedded, every key it uses present), the language choice, the port-in-use message, the bundled Python, the saved window size, the Dock badge count and the Backstage data move (on a temporary home folder).

### Releasing

The version number is set in `package.json`. The Mac app reads it through `"version": "../package.json"` in `tauri.conf.json`, the server reads the bundled copy, and the Guide displays it. `src-tauri/Cargo.toml` must carry the same number.

1. Add the release notes as a `## <version>` section at the top of `CHANGELOG.md`.
2. Set the version in `package.json` and `src-tauri/Cargo.toml`.
3. Run `pnpm app:release` (`tools/package_release.sh`). It checks that the versions match and the notes exist, runs the tests, builds the app, zips it with `ditto` into `dist/Cratify-<version>-mac-arm64.zip` (preserving the signature and attributes), writes `dist/release-notes.md`, and prints the checksum and the `gh release create` command. It does not publish anything.
4. Test the zip: unzip it, open the app and check the version in the Guide, preferably on a Mac or user account that has never run Cratify.
5. Commit, tag `v<version>` and run the printed `gh release create` command.

Signing with a Developer ID and notarizing (Apple Developer Program) removes the "Open Anyway" step: set `signingIdentity` in `tauri.conf.json` and `APPLE_ID`, `APPLE_PASSWORD` and `APPLE_TEAM_ID` when building.

## Running in a browser

```bash
uv run --no-project app.py            # opens http://127.0.0.1:8765 (uses the Mac app's data folder)
uv run --no-project app.py --port 9000 --no-browser
```

The server uses only the Python standard library, and the front end is plain JavaScript, so there is nothing to install. The browser version and the Mac app share the data folder; when both are open, a change saved in one makes the other ask to be reloaded before it saves again.

## Watching Serato

While the page is open, it checks every few seconds whether Serato DJ is running and whether the library has changed since the last snapshot, using the size and modification time of `master.sqlite` and its WAL. Serato's files are never opened. After a change, the snapshot is reloaded once the database has been idle for 2 seconds (15 seconds while Serato is running, so a set is not interrupted). When Serato DJ quits and the plan has changes that can be applied, Cratify offers to apply them.

## Music folders

Folders scans the music folders, and the search for missing files covers them and `~/Music`. On first launch, Cratify suggests folders based on where the songs in the Serato library are (in each area, such as `~/Music` or a drive under `/Volumes`, the deepest folder that holds 80% of its songs) and asks for confirmation. To change them later, use "Music folders" at the top right of Folders. The setting is saved in `settings.json`. Folders on disconnected drives are marked as not found and skipped.

## Language

Until a language is chosen, the interface follows the Mac: Traditional Chinese when Chinese is the first language in System Settings → General → Language & Region, English otherwise. The button at the top right switches languages. The choice is saved in the page and in `settings.json`, so server messages and the Mac app's startup messages use it too.

All interface text is in two files with the same keys, `static/locales/en.json` and `static/locales/zh-Hant.json`, shared by the three parts. Code refers to text by key, `<area>.<name>`:

- front end (`static/js/i18n.js`, which loads both files at startup): `_('folders.trashConfirm')`, `_n(count, 'plan.actionCount')`
- server (`serato_crates/i18n.py`, which reads them at startup): `tr("check.cratesPassed")`, `trn(n, "check.imported")`
- Mac app (`src-tauri/src/main.rs`, which embeds them at build time): `tr("startup.portInUse", …)`; rebuild the app after changing its texts

Counted English texts have the forms `one` and `other`; Chinese has a single form. Changing wording only touches the two files. `uv run --no-project tools/check_i18n.py` checks that every key the code uses exists, that both tables have the same keys and placeholders, and that no key is unused; `pnpm app:release` runs it before building.

## Views

| View | Purpose |
|---|---|
| Overview | Start page: songs left to sort, files left to screen per folder, pending changes (with Apply when Serato is closed), and library health (missing files, duplicates, empty crates, low quality, suspected transcodes). Each card opens the corresponding view |
| Folders | Scans the music folders and labels each song as sorted, unsorted, not imported, copy, rejected or missing. Shows progress per folder and the actual audio format, and supports screening, adding songs to Serato and opening folders in Finder |
| Sort | Sorts unsorted songs from a crate under Inbox, a folder, songs in no crate, or recently added songs. Keys 1–9 add to pinned crates, ⇧+number adds to a suggested crate, `/` searches or creates a crate, `X` rejects |
| Cleanup | Missing files (relocate, or merge into the record that already points to the moved file), duplicates (keep one copy and merge crates), empty crates |
| Quality | Runs the transcode check and lists suspect files for listening, spectrum review, marking as genuine or rejecting (see [Audio quality](#audio-quality)) |
| Crates | Edits the crate tree: drag to move or reorder (⌥↑ ⌥↓ and the right-click menu also reorder), rename, merge, delete, add or move selected songs, and mark crates as unsorted |
| Plan | All pending changes, undo, export, and Apply to Serato |
| Notes | Notes about songs and songs to find, optionally linked to a library song, with #tags, search and Markdown export |
| Guide | Usage instructions and the suggested workflow, in the interface language |

Press `?` for the full list of keyboard shortcuts.

### Unsorted crates and Inbox

A song counts as sorted when it is in at least one crate that is not marked unsorted. Unsorted crates are:

- `Inbox` and all crates under it
- top-level crates named TBD, Temp or Inbox
- crates created by dragging a whole folder into Serato (same name as the folder, holding at least 60% of its songs)
- crates marked manually

The unsorted-crate editor, available from Folders and Crates, adds or removes unsorted crates, creates crates under Inbox, and consolidates everything unsorted into Inbox. Each crate in Crates also has an "unsorted" checkbox. The settings are saved in `rules.json`.

These defaults assume one workflow: new music goes into crates under `Inbox` (for example "Inbox / 2026-12 Beatport", or a folder dragged into Serato) and is then sorted into genre or set crates. "Consolidate into Inbox…" moves every unsorted crate under `Inbox` and collects songs in the music folders that are in no crate into "Inbox / Unsorted songs" (named in the interface language; an existing crate in either language is reused). For other workflows, mark or unmark crates as unsorted instead. Nothing is moved unless "Consolidate into Inbox…" is used, and every change goes through the plan.

Crates named by a BPM range (for example "Open Format / 120-129 / All") are recognised: Sort suggests the range that matches the song's BPM.

### Screening and the Trash

In Folders, select a song and screen with the keyboard:

- `↑` `↓`: previous / next song
- Space: play
- `Q` `W` `E` `R`: jump to 0 / 25 / 50 / 75%
- `X`: reject
- `V`: keep

Marks are saved in `screen.json`. Rejected songs are handled according to whether they are in Serato:

- **Files Serato does not use** can be moved to the macOS Trash after a confirmation list. Cratify takes a fresh Serato snapshot first and refuses any file Serato uses. Each move is logged in `trash_log.jsonl` with the original path and size, so Cratify can restore the file until the Trash is emptied. Finder's "Put Back" may not recognise these items.
- **Songs in Serato** are added to the plan. Applying the plan removes them from Serato and then moves their files to the Trash, with the same check and log. `⇧X` in Sort removes a song from the library but keeps the file (samples, demo tracks).

### Audio quality

Serato stores only the file extension, which does not distinguish AAC from lossless ALAC, and leaves many bit rates empty. Cratify reads each file's header with macOS `afinfo` and caches the result in `audio_info.json`.

- **Labels**: `AAC 256`, `MP3 320`, `WAV 24-bit`, `ALAC`. Lossless formats are shown in green.
- **Low quality** (red): MP3 below 256k, AAC below 192k, or a sample rate below 44.1 kHz. AAC 256 is roughly equivalent to MP3 320 and is not flagged.
- **Unreadable**: files macOS cannot open are flagged separately.
- **Suspect** (orange; requires ffmpeg): transcodes, such as an MP3 320 made from a 128k file or a WAV made from an MP3. See below.
- **Duplicates**: the same information decides which copy to keep.

#### Transcode check

Encoders remove the highest frequencies (about 16.5 kHz at 128k, 19 kHz at 192k, 20 kHz at 320k; lossless reaches 22 kHz), and conversion cannot restore them. `serato_crates/spectrum.py` decodes three 10-second excerpts of each file with ffmpeg, measures 250 Hz bands from 14 to 22 kHz against an 8–12 kHz reference, and flags a sharp cut-off well below what the format can carry: 19 kHz or lower for MP3 320 / AAC 256, below 17.3 kHz for 192k, and 20.6 kHz or lower for lossless. Levels are measured in floating point (ffmpeg `astats`); `volumedetect` works in 16 bits and cannot measure below about −90 dB, which hid transcodes in quiet songs.

- **When it runs**: only when started from Quality, to save power. It runs at background priority (`taskpolicy -c background`) with 1, 3 or 6 files at a time, and can be stopped.
- **Caching**: results are stored in `spectrum.json`, so each run checks only new or changed files. Serato writes analysis and cue points into music files, which changes their size and date but not the audio, so each result also stores an audio fingerprint (MD5 of the audio packets at 0–10 s and 60–70 s, read without decoding, about 0.04 s per file). A changed file with the same fingerprint keeps its result. Results from before fingerprints were introduced receive one in a single low-priority pass; results from the earlier 16-bit meter are kept where the verdict cannot change, and the rest are listed as unchecked.
- **Review**: Quality lists the suspect files. Keys: `↑` `↓`, Space, `Enter` for the spectrum, `F` to mark as genuine and move to the next file, `X` to reject. Right-click → Spectrum is available in every view.

The result is an estimate. Songs mastered with little high-frequency content can be flagged too; mark them as genuine.

### Adding songs to Serato

In Folders, songs that are not in Serato can be added with the button in a folder's screening note, or with right-click → "Add to Serato…". The songs can go into a new crate "Inbox / folder name" (the same result as dragging the folder into Serato), another crate, or the library only. Songs that appear to be in Serato already (same artist and title) are skipped unless that option is cleared. The songs are added to the plan and written when it is applied.

Applying writes the same rows as Serato's own import, determined by comparing Serato's database before and after importing single files and folders: one song row and one "Serato Library" row in both `master.sqlite` and `root.sqlite`, plus the crate rows. Cratify fills in the file details (file name, size, bit rate, sample rate and length from macOS `afinfo`, matching what Serato stores) and the title tag; every other column takes the database default, as Serato's import does. A few columns are computed by functions that exist only inside Serato DJ (search text and key number). Cratify registers equivalents under the same names, which match Serato's output for 99.998% of the values in a real library, and Serato recomputes them the next time it updates the song. Both database files allow only one song per file path, so a song cannot be added twice, including by dragging it into Serato later.

Afterwards, select the songs in Serato DJ (for example through their crate) and choose "Analyze Files". Serato then reads the remaining tags (artist, album, key and so on) and detects BPM, beatgrid and waveform. This was verified on a real library: the song appears in its crate and in All, search finds it, it plays, and Serato read its tags and BPM when it was loaded on a deck.

### Notes

Notes hold comments about songs ("good opener", "mix out at the second drop") and songs to find (heard in a set, to buy). They are stored only in `notes.json` and are never written to Serato.

- **Writing**: type in the box at the top and press ⌘↵. `N` focuses the box, `/` searches.
- **Linking a song**: "Link a song…" searches the library (an empty search shows the playing song and the newest songs), or one click links the song that is playing. A note stores the song's Serato ID and file path, plus title and artist for display if the song later leaves the library.
- **From other views**: right-click a song in Sort, Crates, Folders or Quality → "Add a note…", or press `M` in Sort. Sort shows the selected song's newest notes in its detail panel, and songs with notes show 📝 before their title in those lists.
- **Files not imported yet**: a note about a file in Folders is linked by path and attaches to the song once the file is imported in Serato.
- **Songs to find**: an unlinked note such as "Artist - Title" can be linked later; the search starts with the note's first line.
- **#tags** (`#opener`, `#開場`) appear as filters above the list. Deleting a note can be undone, and Export downloads all notes as Markdown.

If `notes.json` cannot be read, saving is disabled so the file is not overwritten.

## Apply to Serato

"Apply to Serato" in Plan writes the pending crate changes into Serato DJ 4's database:

1. It checks that Serato DJ is not running (by executable name) and that no process has the databases open.
2. It applies the whole plan to a private copy of the databases. Any error stops the process before Serato is touched.
3. It backs up `master.sqlite` and `root.sqlite` to a timestamped folder in `~/Cratify Backups/`.
4. It writes both databases in one transaction, with root attached as `db1` as Serato does. Before committing, it verifies:
   - integrity and foreign keys
   - that master and root mirror each other
   - that every crate holds exactly the expected songs

   If any check fails, nothing is written.

If crates were changed in Serato after the last snapshot, the result does not match the expectation and the apply is refused. Reload the snapshot and apply again.

If something looks wrong afterwards, quit Serato and use "Restore the backup from before the last apply" in Plan.

Supported actions:

- create, rename, move, delete and merge crates
- reorder crates within a level. As when a crate is dragged in Serato, each database file renumbers that level 1…N independently (master holds a few crates that root does not); after writing, Cratify checks that both files list the level in the planned order. New crates are placed at the end of their level
- add songs to crates and remove them from crates
- point a song to a new file location
- add songs from disk to the library, optionally into a crate (see [Adding songs to Serato](#adding-songs-to-serato))
- remove songs from the library, as Serato's ⌘⌫ does: crate memberships are removed and play history is kept. Files of rejected songs are moved to the Trash only after the database write is committed

`serato_crates/apply.py` documents the Serato 4 database layout.

## Safety

- Serato DJ 4 keeps its library in `~/Library/Application Support/Serato/Library/`: `master.sqlite`, plus `root.sqlite` for the local drive. Serato 4 no longer reads the legacy `~/Music/_Serato_` files.
- **Reading**: Cratify never opens Serato's live files, because even a read-only SQLite connection writes to `-shm`. It copies the bytes of `master.sqlite` and its `-wal`, verifies that nothing changed during the copy, and works on that snapshot. This is safe while Serato is running.
- **Writing**: Serato's database is written only by "Apply to Serato" (Serato closed; tested on a copy, backed up and verified) and by the tools in `tools/`, which follow the same steps and only do a dry run unless given `--apply`:
  - `serato_move_paths.py` rewrites file paths after music folders were moved.
  - `serato_apply_ops.py` applies a list of plan actions from a JSON file; it never moves music files.
  - `serato_import_poc.py` is the proof of concept for adding one song the way Serato's import does.
- **The server** listens only on `127.0.0.1` and checks the Host header. Writes must be JSON. Audio preview serves only files that are in the library or found by the folder scan.

## Disclaimer

Cratify is an independent project. It is not made by, affiliated with or endorsed by Serato, and it does not use Serato's logos. Serato and Serato DJ are trademarks of their owner.

Serato DJ's library database is private and undocumented. Cratify's knowledge of it comes from comparing the database before and after Serato's own actions, and is documented in `serato_crates/apply.py`. Cratify writes to it only through "Apply to Serato", with Serato closed, after testing the changes on a copy and backing the database up to `~/Cratify Backups/`. It verifies the result before committing and refuses database versions it has not been verified with. A Serato update or an untested library may still behave differently. Keep separate backups and use Cratify at your own risk. The software is provided as is, without warranty (see [License](#license)).

## Limitations

- Folders scans only the music folders; the search for missing files covers them and `~/Music`. Folders in `~/Downloads`, `~/Documents` or `~/Desktop` trigger a macOS permission prompt on the first scan.
- Songs added by Cratify are not analysed. Select them in Serato and choose "Analyze Files"; loading a song on a deck also analyses it.
- In a browser, Chrome cannot play AIFF. Safari and the Mac app can.
- Only the local Serato Library is supported; streaming playlists are not shown.

## License

[MIT](LICENSE). Cratify may be used, copied, modified and distributed, including commercially, provided the copyright and license notice are retained. It is provided without warranty.
