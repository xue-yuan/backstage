"""Take a consistent, private copy of Serato's library database.

Safety model
------------
Serato DJ 4.x keeps its library in ``master.sqlite`` (WAL mode). Even a
"read-only" SQLite connection writes read-marks into the ``-shm`` file, so we
never open Serato's files with SQLite at all. We only copy the bytes of the
database and its write-ahead log, verify nothing changed while copying, and
then do all SQLite work on our own copy.
"""

from __future__ import annotations

import json
import os
import shutil
import sqlite3
import time
from datetime import datetime, timezone
from pathlib import Path
from .i18n import tr

DEFAULT_SOURCE = Path.home() / "Library/Application Support/Serato/Library/master.sqlite"


class SnapshotError(RuntimeError):
    pass


def _signature(paths: list[Path]) -> tuple:
    sig = []
    for p in paths:
        try:
            st = p.stat()
            sig.append((st.st_size, st.st_mtime_ns))
        except FileNotFoundError:
            sig.append(None)
    return tuple(sig)


def take_snapshot(data_dir: Path, source: Path = DEFAULT_SOURCE, attempts: int = 6) -> dict:
    if not source.exists():
        raise SnapshotError(tr("Serato database not found: {path}", path=source))

    src_wal = source.with_name(source.name + "-wal")
    work = data_dir / "snapshot.tmp"
    data_dir.mkdir(parents=True, exist_ok=True)

    last_problem = "unknown"
    for attempt in range(attempts):
        if work.exists():
            shutil.rmtree(work)
        work.mkdir()
        copy_db = work / "master.sqlite"

        before = _signature([source, src_wal])
        shutil.copyfile(source, copy_db)
        if src_wal.exists():
            shutil.copyfile(src_wal, work / "master.sqlite-wal")
        after = _signature([source, src_wal])

        if before != after:
            last_problem = tr("Serato wrote to the database while it was being copied")
            time.sleep(0.4 * (attempt + 1))
            continue

        # Everything below touches only our private copy in `work`.
        con = sqlite3.connect(copy_db)
        try:
            con.execute("PRAGMA wal_checkpoint(TRUNCATE)")
            con.execute("PRAGMA journal_mode=DELETE")
            check = con.execute("PRAGMA quick_check").fetchone()[0]
        finally:
            con.close()
        if check != "ok":
            last_problem = tr("integrity check failed: {result}", result=check)
            time.sleep(0.4 * (attempt + 1))
            continue

        os.replace(copy_db, data_dir / "snapshot.sqlite")
        shutil.rmtree(work, ignore_errors=True)
        src_stat = source.stat()
        meta = {
            "takenAt": datetime.now(timezone.utc).isoformat(),
            "source": str(source),
            "sourceModifiedAt": datetime.fromtimestamp(src_stat.st_mtime, timezone.utc).isoformat(),
            "attempts": attempt + 1,
        }
        (data_dir / "snapshot.json").write_text(json.dumps(meta, ensure_ascii=False, indent=2))
        return meta

    shutil.rmtree(work, ignore_errors=True)
    raise SnapshotError(tr("Could not get a consistent snapshot ({problem}). Please try again in a moment", problem=last_problem))


def load_meta(data_dir: Path) -> dict | None:
    meta_path = data_dir / "snapshot.json"
    if not meta_path.exists() or not (data_dir / "snapshot.sqlite").exists():
        return None
    return json.loads(meta_path.read_text())
