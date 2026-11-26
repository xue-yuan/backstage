# Backstage

A local app for organising a Serato DJ 4 library: see which folders are already sorted into crates, screen new music, sort songs into crates quickly, clean up missing files and duplicates, reshape the crate tree, and write the result back to Serato in one verified step.

The interface is in Traditional Chinese.

## Mac app

```bash
pnpm install          # first time: installs the Tauri CLI
pnpm app:build        # builds src-tauri/target/release/bundle/macos/Backstage.app
```

The Mac app is a Tauri window. On launch it starts the same Python server in the background (fixed at `127.0.0.1:47615`) and stops it when the app quits.

Data lives in `~/Library/Application Support/Backstage/`:

- the Serato snapshot
- the plan
- screening marks
- unsorted-crate rules
- the audio-format cache
- the trash log
- `app.log` and `server.log`

## Running in a browser

```bash
python3 app.py            # opens http://127.0.0.1:8765 (same data folder as the Mac app)
python3 app.py --port 9000 --no-browser
```

The server uses only the Python standard library and the front end is plain JavaScript; nothing to install. Do not run the browser version and the Mac app at the same time: both write the same plan.

## Views

| View | What it does |
|---|---|
| Folders | Scans `~/Music/DJ` and labels every song: sorted, unsorted, not imported, copy, rejected or missing. Shows which folders are done, real audio format and quality, and lets you screen files and open folders in Finder |
| Sort | Go through unsorted songs (a crate under Inbox, a disk folder, songs in no crate, recently added) and sort them. Keys 1–9 add to pinned crates, ⇧+number adds a suggested crate, `/` searches or creates a crate, `X` rejects |
| Cleanup | Missing files (relocate, or merge into the record that already points at the moved file), duplicates (keep one, merge crates), empty crates |
| Crates | Tree editing (drag to move, auto-scrolls near the edges), rename, merge, delete, multi-select songs to add or move, mark crates as unsorted |
| Plan | Everything staged so far, undo, export, and Apply to Serato |

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
- **Songs that are in Serato**: they are staged in the plan instead, to be removed when the plan is applied. This is not supported yet; see Limitations.

### Audio quality

Serato only stores the file extension, which cannot tell AAC from lossless ALAC, and leaves many bit rates empty. The app reads every file's header with macOS `afinfo` and caches the result in `audio_info.json`.

- **Labels**: `AAC 256`, `MP3 320`, `WAV 24-bit`, `ALAC`. Lossless formats are shown in green.
- **Low quality** (shown in red): MP3 below 256k, AAC below 192k, or a sample rate below 44.1 kHz. AAC 256 is roughly MP3 320 and is not flagged.
- **Unreadable**: files macOS cannot open are flagged separately.
- **Duplicates**: the same information is used to pick which copy to keep.

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
- add songs to crates and remove them from crates
- point a song at a new file location

Removing songs from Serato is not supported yet. `serato_crates/apply.py` documents the Serato 4 database layout.

## Safety

- Serato DJ 4 keeps its library in `~/Library/Application Support/Serato/Library/`: `master.sqlite`, with `root.sqlite` for the local drive. The legacy `~/Music/_Serato_` files are no longer read by Serato 4.
- **Reading**: the app never opens Serato's live files for reading. Even a read-only SQLite connection writes to `-shm`. It copies the bytes of `master.sqlite` and its `-wal`, checks nothing changed while copying, and works on that snapshot. This is safe while Serato is open.
- **Writing**: Serato is written only by "Apply to Serato" (Serato closed, rehearsed, backed up, verified) and by `tools/serato_move_paths.py`. The tool rewrites file paths after music folders were moved; it also requires Serato to be closed and only does a dry run without `--apply`.
- **The server**: it listens on `127.0.0.1` only and checks the Host header. Writes must be JSON. Audio preview only serves files that are in the library or found by the folder scan.

## Limitations

- Apply to Serato cannot remove songs yet. Rejected Serato songs, and the removal half of merging missing files or duplicates, stay in the plan.
- The Folders report only scans `~/Music/DJ`. Finding missing files searches all of `~/Music`. `~/Downloads` is not scanned, because the Mac app would need an extra macOS permission for it.
- Importing new songs has to happen in Serato (drag them in). Serato fills search fields through internal SQL functions that other programs cannot call.
- In a browser, Chrome cannot play AIFF. Safari and the Mac app can.
- Only the local Serato Library is handled; streaming playlists do not appear.
- Crate ordering is not editable. New or moved crates go to the end of their level.
