# Changelog

Each section is also used as the release notes for that version on GitHub (`tools/package_release.sh` copies it).

## Unreleased

- Interface text, the Guide and the README rewritten in a more formal, concise style in both English and Traditional Chinese. "Sounds fine" in Quality is now "Mark as genuine".

## 0.1.0

The first public version of Cratify, a Mac app for organising a Serato DJ 4 library.

- **Folders**: shows which songs in the music folders are sorted into crates, unsorted, not in Serato yet, copies or missing. Screen new music with the keyboard and move rejected files to the Trash (restorable).
- **Sort**: sort unsorted songs into crates, with suggested crates and pinned crates on number keys.
- **Cleanup**: relocate or merge missing files, merge duplicates, remove empty crates.
- **Quality**: the actual audio format of every file, and an optional transcode check (fake 320k or fake lossless; requires ffmpeg).
- **Crates**: rename, move, reorder, merge and delete crates.
- **Add songs to Serato** from Folders, the same way Serato's own import does.
- **Notes** about songs, with #tags and Markdown export.
- **Plan and Apply**: every change is added to a plan first. "Apply to Serato" writes it with Serato closed, after testing on a copy and backing up the database, and verifies the result.
- English and Traditional Chinese.

**Requirements**: macOS 12 or later on Apple silicon, Serato DJ Pro 4.0 (database version 202), [uv](https://docs.astral.sh/uv/) with Python 3.12 or later, and optionally ffmpeg. See "Install" in the README.

**Not signed by Apple yet**: macOS blocks the first launch. Open System Settings → Privacy & Security and press "Open Anyway" next to Cratify, or run `xattr -dr com.apple.quarantine /Applications/Cratify.app` in Terminal.

Cratify is not affiliated with Serato. It writes to Serato's library database and backs it up before every write; use it at your own risk.
