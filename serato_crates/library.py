"""Read the user's crates and local tracks out of a snapshot (never the live DB)."""

from __future__ import annotations

import os
import sqlite3
from pathlib import Path
from .i18n import tr

LIBRARY_SPACE = "Serato Library"
CRATE_TYPE = 1
AUDIO_EXTENSIONS = {".mp3", ".m4a", ".aac", ".mp4", ".wav", ".aif", ".aiff", ".flac", ".ogg", ".alac"}


def _connect(snapshot: Path) -> sqlite3.Connection:
    con = sqlite3.connect(f"file:{snapshot}?mode=ro&immutable=1", uri=True)
    con.row_factory = sqlite3.Row
    return con


def load_library(snapshot: Path) -> dict:
    con = _connect(snapshot)
    try:
        space = con.execute("SELECT id FROM space WHERE name = ?", (LIBRARY_SPACE,)).fetchone()
        if space is None:
            raise RuntimeError(tr("snapshot.noLibrary"))
        space_id = space["id"]
        root = con.execute(
            "SELECT id FROM container WHERE space_id = ? AND type = 0", (space_id,)
        ).fetchone()
        root_id = root["id"]

        locations = {r["id"]: (r["path"] or "/") for r in con.execute("SELECT id, path FROM location")}

        crates = [
            {
                "id": r["id"],
                "parent": r["parent_id"],
                "name": r["name"],
                "order": r["list_order"],
                "color": r["color"],
                "addedAt": r["time_added"],
            }
            for r in con.execute(
                """
                SELECT c.id, c.parent_id, c.name, c.list_order, c.color, c.time_added
                FROM container c
                WHERE c.space_id = ? AND c.type = ?
                  AND c.id NOT IN (SELECT container_id FROM smart_crate_rules)
                ORDER BY c.parent_id, c.list_order
                """,
                (space_id, CRATE_TYPE),
            )
        ]
        crate_ids = {c["id"] for c in crates}

        plays = {
            r["asset_id"]: (r["n"], r["last"])
            for r in con.execute(
                """
                SELECT asset_id, COUNT(*) AS n, MAX(start_time) AS last
                FROM history_entry WHERE played = 1 AND asset_id > 0
                GROUP BY asset_id
                """
            )
        }

        tracks = []
        for r in con.execute(
            """
            SELECT a.* FROM asset a
            JOIN space_asset sa ON sa.asset_id = a.id
            WHERE sa.space_id = ?
            """,
            (space_id,),
        ):
            path = os.path.join(locations.get(r["location_id"], "/"), r["portable_id"])
            n_plays, last_play = plays.get(r["id"], (0, None))
            tracks.append(
                {
                    "id": r["id"],
                    "path": path,
                    "fileName": r["file_name"] or os.path.basename(path),
                    "format": r["format"],
                    "size": r["file_size"],
                    "bitRate": r["file_bit_rate"],
                    "sampleRate": r["file_sample_rate"],
                    "title": r["name"],
                    "artist": r["artist"],
                    "remixer": r["remixer"],
                    "album": r["album"],
                    "genre": r["genre"],
                    "key": r["key"],
                    "bpm": r["bpm"],
                    "lengthMs": r["length_ms"] or ((r["length_sec"] or 0) * 1000) or None,
                    "addedAt": r["time_added"],
                    "comments": r["comments"],
                    "grouping": r["grouping"],
                    "label": r["label"],
                    "year": r["year"],
                    "plays": n_plays,
                    "lastPlayed": last_play,
                    "exists": os.path.exists(path),
                }
            )

        memberships = [
            [r["container_id"], r["asset_id"]]
            for r in con.execute(
                """
                SELECT lc.container_id, ca.asset_id
                FROM container_asset ca
                JOIN location_container lc ON lc.id = ca.location_container_id
                ORDER BY lc.container_id, ca.list_order
                """
            )
            if r["container_id"] in crate_ids
        ]

        return {"rootId": root_id, "crates": crates, "tracks": tracks, "memberships": memberships}
    finally:
        con.close()


def scan_audio_files(roots: list[Path]) -> dict[str, list[dict]]:
    """Index audio files by lower-cased file name, for relocating missing tracks."""
    index: dict[str, list[dict]] = {}
    for root in roots:
        if not root.is_dir():
            continue
        for dirpath, dirnames, filenames in os.walk(root):
            dirnames[:] = [d for d in dirnames if not d.startswith(".") and d != "_Serato_"]
            for name in filenames:
                if os.path.splitext(name)[1].lower() not in AUDIO_EXTENSIONS:
                    continue
                full = os.path.join(dirpath, name)
                try:
                    st = os.stat(full)
                except OSError:
                    continue
                index.setdefault(name.lower(), []).append(
                    {"path": full, "size": st.st_size, "modifiedAt": int(st.st_mtime)}
                )
    return index
