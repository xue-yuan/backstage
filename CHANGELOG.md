# Changelog

Each section is also the release notes of that version on GitHub (`tools/package_release.sh` copies it).

## 0.1.0

The first public version of Cratify, a Mac app for organising a Serato DJ 4 library.

- **Folders**: see which songs in your music folders are sorted into crates, unsorted, not in Serato yet, copies or missing. Screen new music with the keyboard and move rejected files to the Trash (restorable).
- **Sort**: go through unsorted songs and sort them into crates, with suggested crates and pinned crates on number keys.
- **Cleanup**: relocate or merge missing files, merge duplicates, remove empty crates.
- **Quality**: real audio format of every file, and an optional check for transcodes (fake 320k or fake lossless; needs ffmpeg).
- **Crates**: rename, move, reorder, merge and delete crates.
- **Add songs to Serato** from Folders, the way Serato's own import does.
- **Notes** about songs, with #tags and Markdown export.
- **Plan and Apply**: every change is staged first. "Apply to Serato" writes it with Serato closed, after rehearsing on a copy and backing up the database, and checks the result.
- English and Traditional Chinese.

**Requirements**: macOS 12 or later on Apple silicon, Serato DJ Pro 4.0 (database version 202), [uv](https://docs.astral.sh/uv/) with Python 3.12 or later, and optionally ffmpeg. See "Install" in the README.

**Not signed by Apple yet**: the first time, macOS blocks the app. Open System Settings → Privacy & Security and press "Open Anyway" next to Cratify, or run `xattr -dr com.apple.quarantine /Applications/Cratify.app` in Terminal.

Cratify is not affiliated with Serato. It writes to Serato's own library database; it backs it up before every write, but use it at your own risk.
