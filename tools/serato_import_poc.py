"""Proof of concept: add one song to Serato DJ from Backstage, the way Serato's own import does.

    uv run --no-project tools/serato_import_poc.py FILE --crate "Crate 2"            # rehearse on a copy only
    uv run --no-project tools/serato_import_poc.py FILE --crate "Crate 2" --apply    # write (Serato closed)

Backstage fills only what describes the file (file name, size, bit rate, sample rate and length from
macOS `afinfo`, the same numbers Serato stores) plus the title tag. Artist, BPM, key, beatgrid and
waveform are left to Serato's own analysis: the song is stored as "not analysed" (analysis_flags 0).

Without --apply it copies Serato's database (byte copy, safe while Serato is open), adds the song to
the copy and prints what was written. --apply uses the same safety as "Apply to Serato": Serato must be
closed and nothing else may use the database; it rehearses on a private copy, backs up master.sqlite and
root.sqlite to ~/Backstage Backups (the Plan view's "Restore the backup from before the last apply"
restores it), copies the music file into that backup too, and checks integrity, foreign keys and that
master and root match before committing. The music file itself is never written by Backstage.
"""

from __future__ import annotations

import argparse
import re
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from serato_crates.apply import ApplyError, apply_changes, backup as backup_serato, files_in_use, serato_running  # noqa: E402
from serato_crates.server import BEFORE_APPLY, SERATO_BACKUPS, SERATO_LIBRARY  # noqa: E402
from serato_crates.snapshot import take_snapshot  # noqa: E402
from serato_crates.spectrum import find_ffmpeg  # noqa: E402


def file_info(path: Path) -> dict:
    """What Serato's import stores about the file itself (afinfo gives the same numbers), plus the title tag."""
    out = subprocess.run(["afinfo", str(path)], capture_output=True, text=True, timeout=15).stdout
    rate = re.search(r"bit rate: (\d+) bits per second", out)
    sample = re.search(r"Data format:\s+\d+ ch,\s+([\d.]+) Hz", out)
    length = re.search(r"estimated duration: ([\d.]+) sec", out)
    if not sample or not length:
        raise SystemExit(f"macOS cannot read this file as audio: {path}")
    title = ""
    ffmpeg = find_ffmpeg()
    if ffmpeg:
        probe = Path(ffmpeg).with_name("ffprobe")
        if probe.exists():
            title = subprocess.run(
                [str(probe), "-v", "error", "-show_entries", "format_tags=title", "-of", "default=nw=1:nk=1", str(path)],
                capture_output=True, text=True, timeout=15,
            ).stdout.strip().splitlines()[0:1]
            title = title[0] if title else ""
    st = path.stat()
    return {
        "fileSize": st.st_size,
        "mtime": int(st.st_mtime),
        "bitRate": int(rate.group(1)) if rate else None,
        "sampleRate": float(sample.group(1)),
        "lengthMs": int(float(length.group(1)) * 1000),  # Serato truncates: 284.105986 s -> 284105
        "name": title or path.stem,
    }


def crate_id(db: Path, name: str) -> int:
    """Master id of a Serato Library crate by name ("Parent / Child" for nested ones)."""
    con = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
    space = con.execute("SELECT id FROM space WHERE name = 'Serato Library'").fetchone()
    if not space:
        raise SystemExit("Serato Library space not found")
    cur = con.execute("SELECT id FROM container WHERE space_id = ? AND type = 0", (space[0],)).fetchone()[0]  # the library's root, as apply.py finds it
    for part in [p.strip() for p in name.split(" / ")]:
        row = con.execute("SELECT id FROM container WHERE space_id = ? AND type = 1 AND name = ? AND parent_id = ?", (space[0], part, cur)).fetchone()
        if not row:
            raise SystemExit(f'Crate not found: "{name}"')
        cur = row[0]
    return cur


def copy_library(dest: Path) -> Path:
    """A consistent private copy of master.sqlite + root.sqlite (byte copies, verified unchanged while copying)."""
    for name in ("master", "root"):
        take_snapshot(dest / name, SERATO_LIBRARY / f"{name}.sqlite")
    lib = dest / "lib"
    lib.mkdir()
    shutil.move(dest / "master" / "snapshot.sqlite", lib / "master.sqlite")
    shutil.move(dest / "root" / "snapshot.sqlite", lib / "root.sqlite")
    return lib


def show(lib: Path, asset: int) -> None:
    con = sqlite3.connect(lib / "master.sqlite")
    con.row_factory = sqlite3.Row
    con.execute("ATTACH DATABASE ? AS db1", (str(lib / "root.sqlite"),))
    m = con.execute("SELECT * FROM main.asset WHERE id = ?", (asset,)).fetchone()
    r = con.execute("SELECT * FROM db1.asset WHERE id = ?", (m["external_id"],)).fetchone()
    keep = lambda row: {k: row[k] for k in row.keys() if row[k] not in (None, "", 0)}
    print("  master.asset:", keep(m))
    print("  root.asset:  ", keep(r))
    crates = con.execute(
        "SELECT c.name FROM main.container_asset ca JOIN main.location_container lc ON lc.id = ca.location_container_id "
        "JOIN main.container c ON c.id = lc.container_id WHERE ca.asset_id = ?",
        (asset,),
    ).fetchall()
    print("  in crates:   ", [c[0] for c in crates])


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("file", type=Path)
    ap.add_argument("--crate", help='crate to put it in, e.g. "Crate 2" or "Inbox / 0425"')
    ap.add_argument("--apply", action="store_true", help="write to Serato (Serato must be closed)")
    args = ap.parse_args()
    path = args.file.expanduser().resolve()
    if not path.is_file():
        raise SystemExit(f"Not a file: {path}")

    info = file_info(path)
    with tempfile.TemporaryDirectory(prefix="backstage-import-") as tmp:
        rehearsal = copy_library(Path(tmp))
        op = {"type": "importTrack", "id": "poc", "path": str(path), **info}
        if args.crate:
            op["crate"] = crate_id(rehearsal / "master.sqlite", args.crate)
        changes = [{"ops": [op]}]
        try:
            result = apply_changes(rehearsal, changes, None)
        except ApplyError as e:
            raise SystemExit(f"Rehearsal failed, nothing written: {e}")
        print(f"Rehearsal on a private copy: OK ({'; '.join(result['checks'])})")
        show(rehearsal, result["imported"]["poc"])

    if not args.apply:
        print("\nNothing was written. Quit Serato DJ and add --apply to write it.")
        return
    if serato_running():
        raise SystemExit("Serato DJ is still open. Quit it first; nothing was written.")
    busy = files_in_use(SERATO_LIBRARY)
    if busy:
        raise SystemExit(f"Another program is using the Serato database ({', '.join(busy)}); nothing was written.")
    # Same order as "Apply to Serato": rehearse on the real (closed) files, back up, then write.
    with tempfile.TemporaryDirectory(prefix="backstage-import-") as tmp:
        lib = Path(tmp)
        for name in ("master.sqlite", "master.sqlite-wal", "master.sqlite-shm", "root.sqlite"):
            if (SERATO_LIBRARY / name).exists():
                shutil.copy2(SERATO_LIBRARY / name, lib / name)
        apply_changes(lib, changes, None)
    dest = backup_serato(SERATO_LIBRARY, SERATO_BACKUPS, BEFORE_APPLY)
    music = dest / "music"
    music.mkdir()
    shutil.copy2(path, music / path.name)
    if (music / path.name).stat().st_size != path.stat().st_size:
        raise SystemExit("The music file backup does not match; nothing was written.")
    result = apply_changes(SERATO_LIBRARY, changes, None)
    print(f"\nWritten to Serato at {time.strftime('%H:%M:%S')}: {'; '.join(result['checks'])}")
    print(f"Backup (database + this music file): {dest}")
    print("Open Serato DJ and check the song; if anything is wrong, quit Serato and restore the backup in the Plan view.")


if __name__ == "__main__":
    main()
