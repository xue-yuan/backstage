"""A fresh, empty Serato DJ 4 library for tests, with the schema of the Serato DJ on this Mac.

Serato's schema (tables, indexes and triggers) is Serato's work and is not stored in this repository.
It is read from byte copies of the local library (the live files are never opened), and an empty
library with only the rows every library starts with is built from it. Tests that need it are
skipped on a Mac without Serato DJ 4.
"""

from __future__ import annotations

import os
import shutil
import sqlite3
import tempfile
import unittest
import wave
from pathlib import Path

SERATO_LIBRARY = Path.home() / "Library/Application Support/Serato/Library"
SPACE = "Serato Library"
_schema: dict[str, tuple[int, list[tuple[str, str, str, str]]]] | None = None


def _read_schema() -> dict[str, tuple[int, list[tuple[str, str, str, str]]]]:
    """{"master"|"root": (user_version, [(type, name, tbl_name, sql)] in creation order: tables, indexes, views, triggers)}."""
    global _schema
    if _schema is not None:
        return _schema
    if not (SERATO_LIBRARY / "master.sqlite").exists() or not (SERATO_LIBRARY / "root.sqlite").exists():
        raise unittest.SkipTest("Serato DJ 4 is not installed on this Mac")
    order = {"table": 0, "index": 1, "view": 2, "trigger": 3}
    out = {}
    with tempfile.TemporaryDirectory() as tmp:
        for name in ("master", "root"):
            for suffix in ("", "-wal"):
                src = SERATO_LIBRARY / f"{name}.sqlite{suffix}"
                if src.exists():
                    shutil.copyfile(src, Path(tmp) / src.name)
            con = sqlite3.connect(Path(tmp) / f"{name}.sqlite")
            try:
                version = con.execute("PRAGMA user_version").fetchone()[0]
                rows = con.execute("SELECT type, name, tbl_name, sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%'").fetchall()
            finally:
                con.close()
            out[name] = (version, sorted(rows, key=lambda r: (order[r[0]], r[1])))
    _schema = out
    return out


def make_library(lib_dir: Path) -> None:
    """Write an empty master.sqlite and root.sqlite into lib_dir (Serato Library space, local drive, no crates)."""
    schema = _read_schema()
    lib_dir.mkdir(parents=True, exist_ok=True)
    for name in ("root", "master"):  # master's triggers need root.sqlite attached as db1
        version, statements = schema[name]
        con = sqlite3.connect(lib_dir / f"{name}.sqlite", isolation_level=None)
        try:
            for kind, _, _, sql in statements:
                if kind in ("table", "index"):
                    con.execute(sql)
            # Master's views and triggers refer to root.sqlite (attached as db1), which CREATE refuses;
            # they are written into the schema table directly, as they are stored in Serato's own files.
            con.execute("PRAGMA writable_schema = ON")
            for kind, obj, table, sql in statements:
                if kind in ("view", "trigger"):
                    con.execute("INSERT INTO sqlite_master (type, name, tbl_name, rootpage, sql) VALUES (?, ?, ?, 0, ?)", (kind, obj, table, sql))
            con.execute("PRAGMA writable_schema = OFF")
            con.execute(f"PRAGMA user_version = {int(version)}")
        finally:
            con.close()
        # Reopen so the views and triggers are loaded, then add the rows every library starts with.
        con = sqlite3.connect(lib_dir / f"{name}.sqlite", isolation_level=None)
        try:
            if name == "master":
                con.execute("ATTACH DATABASE ? AS db1", (str(lib_dir / "root.sqlite"),))
            if name == "root":
                con.execute("INSERT INTO serato (time_created, revision) VALUES (1, 1)")
                con.execute("INSERT INTO space (id, name, revision) VALUES (2, ?, 1)", (SPACE,))
                con.execute("INSERT INTO container (id, revision, parent_id, name, type, list_order, space_id) VALUES (0, 1, NULL, 'root', 0, 0, NULL)")
                con.execute("INSERT INTO container (id, revision, parent_id, name, type, list_order, space_id) VALUES (3, 1, 0, ?, 0, 1, 2)", (f"{SPACE} root",))
            else:
                con.execute("INSERT INTO serato (time_created) VALUES (1)")
                con.execute("INSERT INTO space (id, name) VALUES (5, ?)", (SPACE,))
                con.execute("INSERT INTO location (id, path, uuid) VALUES (1, '', randomblob(16))")
                con.execute("INSERT INTO container (id, parent_id, name, type, list_order, space_id) VALUES (0, NULL, 'root', 0, 0, NULL)")
                con.execute("INSERT INTO container (id, parent_id, name, type, list_order, space_id) VALUES (5, 0, ?, 0, 1, 5)", (f"{SPACE} root",))
                con.execute("INSERT INTO location_container (container_id, location_id, external_container_id) VALUES (5, 1, 3)")
        finally:
            con.close()


def write_wav(path: Path, seconds: float = 1.0) -> Path:
    """A short silent 16-bit stereo WAV file (macOS afinfo reads it like any song)."""
    path.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(path), "wb") as w:
        w.setnchannels(2)
        w.setsampwidth(2)
        w.setframerate(44100)
        w.writeframes(b"\0\0\0\0" * int(44100 * seconds))
    os.utime(path, (1_700_000_000, 1_700_000_000))
    return path
