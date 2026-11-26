"""Rewrite Serato 4 file paths after moving music folders (Serato must be closed).

    uv run --no-project tools/serato_move_paths.py --library <dir with master.sqlite + root.sqlite> \
        --from Users/ares/Music/ --to Users/ares/Music/DJ/ --top 2025 --top 2026 --top Serato [--apply]

Serato keeps the local drive's tracks twice: root.sqlite (the drive's own database) and
master.sqlite (location_id = 1 mirrors root.sqlite, same ids). Paths are `portable_id`
(absolute path without the leading "/"). master.sqlite also stores them in history_entry.
Only `portable_id` changes; no Serato trigger listens to that column, and revision
counters are left alone because both databases are updated identically.

Without --apply it runs on in-memory copies and only reports what would change.
"""

from __future__ import annotations

import argparse
import sqlite3
import sys
from pathlib import Path

LOCAL_LOCATION = 1


def where(tops: list[str], src: str) -> tuple[str, list[str]]:
    clause = " OR ".join("portable_id GLOB ?" for _ in tops)
    # GLOB is case-sensitive and has no escape issues for these plain prefixes.
    return f"({clause})", [f"{src}{t}/*" for t in tops]


def plan(con: sqlite3.Connection, table: str, extra: str, tops: list[str], src: str) -> int:
    clause, args = where(tops, src)
    return con.execute(f"SELECT COUNT(*) FROM {table} WHERE {clause} {extra}", args).fetchone()[0]


def rewrite(con: sqlite3.Connection, table: str, extra: str, tops: list[str], src: str, dst: str) -> int:
    clause, args = where(tops, src)
    cur = con.execute(
        f"UPDATE {table} SET portable_id = ? || substr(portable_id, ?) WHERE {clause} {extra}",
        [dst, len(src) + 1, *args],
    )
    return cur.rowcount


def check(con: sqlite3.Connection, name: str) -> None:
    result = con.execute("PRAGMA integrity_check").fetchone()[0]
    if result != "ok":
        raise SystemExit(f"{name}: integrity_check failed: {result}")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--library", type=Path, required=True)
    ap.add_argument("--from", dest="src", required=True)
    ap.add_argument("--to", dest="dst", required=True)
    ap.add_argument("--top", action="append", required=True)
    ap.add_argument("--apply", action="store_true")
    a = ap.parse_args()

    root_db, master_db = a.library / "root.sqlite", a.library / "master.sqlite"
    if a.apply:
        root, master = sqlite3.connect(root_db), sqlite3.connect(master_db)
    else:  # dry run on in-memory copies
        root, master = sqlite3.connect(":memory:"), sqlite3.connect(":memory:")
        sqlite3.connect(f"file:{root_db}?mode=ro", uri=True).backup(root)
        sqlite3.connect(f"file:{master_db}?mode=ro", uri=True).backup(master)
    for con, name in ((root, "root"), (master, "master")):
        check(con, name)

    loc = f"AND location_id = {LOCAL_LOCATION}"
    expected = {
        "root.asset": plan(root, "asset", "", a.top, a.src),
        "master.asset": plan(master, "asset", loc, a.top, a.src),
        "master.history_entry": plan(master, "history_entry", loc, a.top, a.src),
    }
    print("rows to rewrite:", expected)
    if expected["root.asset"] != expected["master.asset"]:
        raise SystemExit("root.asset and master.asset disagree; refusing to continue")
    clash = root.execute(
        "SELECT COUNT(*) FROM asset WHERE portable_id GLOB ?", [f"{a.dst}*"]
    ).fetchone()[0]
    if clash:
        raise SystemExit(f"{clash} tracks already use {a.dst}; refusing to continue")

    done = {}
    with root:  # one transaction per database
        done["root.asset"] = rewrite(root, "asset", "", a.top, a.src, a.dst)
    with master:
        done["master.asset"] = rewrite(master, "asset", loc, a.top, a.src, a.dst)
        done["master.history_entry"] = rewrite(master, "history_entry", loc, a.top, a.src, a.dst)
    print("rows rewritten:", done)
    if done != expected:
        raise SystemExit("row counts differ from the plan; restore the backup")
    for con, name in ((root, "root"), (master, "master")):
        check(con, name)
    left = sum(plan(c, t, x, a.top, a.src) for c, t, x in ((root, "asset", ""), (master, "asset", loc), (master, "history_entry", loc)))
    mismatched = 0
    by_id = dict(root.execute("SELECT id, portable_id FROM asset"))
    for mid, pid in master.execute(f"SELECT external_id, portable_id FROM asset WHERE location_id = {LOCAL_LOCATION}"):
        if by_id.get(mid) != pid:
            mismatched += 1
    print(f"old paths left: {left}; master/root path mismatches: {mismatched}; integrity: ok")
    if left or mismatched:
        raise SystemExit("verification failed; restore the backup")
    root.close()
    master.close()
    print("APPLIED" if a.apply else "dry run only (nothing written)")


if __name__ == "__main__":
    sys.exit(main())
