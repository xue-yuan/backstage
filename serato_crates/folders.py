"""Scan music folders on disk for the folder status report.

Read-only: walks the folders, stats audio files and, only for files that share
an exact byte size with another file, reads the first and last 64 KB to tell
real copies apart. Nothing is written anywhere.
"""

from __future__ import annotations

import hashlib
import os
import time
from collections import defaultdict
from pathlib import Path

from .library import AUDIO_EXTENSIONS

PROBE_BYTES = 64 * 1024


def _skip_dir(name: str) -> bool:
    # _Serato_ / _Serato_Backup hold Serato's own files; never descend into them.
    return name.startswith(".") or name.startswith("_Serato_")


def _probe(path: str, size: int) -> str | None:
    """Hash of the first and last 64 KB: cheap, and enough to confirm two same-sized files are copies."""
    try:
        with open(path, "rb") as f:
            head = f.read(PROBE_BYTES)
            if size > PROBE_BYTES:
                f.seek(max(PROBE_BYTES, size - PROBE_BYTES))
                head += f.read(PROBE_BYTES)
    except OSError:
        return None
    return hashlib.blake2b(head, digest_size=16).hexdigest()


def scan_folders(roots: list[Path], library_paths: list[str]) -> dict:
    """List audio files under `roots` and group byte-identical copies.

    `library_paths` are Serato's existing files; those outside `roots` join the
    copy detection so a file in ~/Music can be recognised as a copy of one that
    Serato reads from elsewhere.
    """
    started = time.time()
    dirs: list[str] = []
    dir_index: dict[str, int] = {}
    files: list[list] = []  # [dirIndex, name, size, mtime]
    scanned_roots: list[str] = []

    for root in roots:
        if not root.is_dir():
            continue
        scanned_roots.append(str(root))
        for dirpath, dirnames, filenames in os.walk(root):
            dirnames[:] = sorted(d for d in dirnames if not _skip_dir(d))
            audio = [n for n in filenames if os.path.splitext(n)[1].lower() in AUDIO_EXTENSIONS and not n.startswith("._")]
            if not audio:
                continue
            idx = dir_index.setdefault(dirpath, len(dirs))
            if idx == len(dirs):
                dirs.append(dirpath)
            for name in sorted(audio):
                try:
                    st = os.stat(os.path.join(dirpath, name))
                except OSError:
                    continue
                files.append([idx, name, st.st_size, int(st.st_mtime)])

    root_prefixes = tuple(r.rstrip("/") + "/" for r in scanned_roots)
    outside: list[tuple[str, int]] = []
    for p in library_paths:
        if p.startswith(root_prefixes):
            continue
        try:
            outside.append((p, os.path.getsize(p)))
        except OSError:
            continue

    # Copy detection: same size first, then confirm with the head/tail probe.
    by_size: dict[int, list[tuple[str, int]]] = defaultdict(list)  # size -> [(path, ref)], ref >= 0 file idx, < 0 outside idx
    for i, (d, name, size, _) in enumerate(files):
        if size:
            by_size[size].append((os.path.join(dirs[d], name), i))
    for j, (p, size) in enumerate(outside):
        if size:
            by_size[size].append((p, -1 - j))

    groups = 0
    file_group: dict[int, int] = {}
    outside_groups: list[list] = []
    for size, entries in by_size.items():
        if len(entries) < 2:
            continue
        by_hash: dict[str, list[int]] = defaultdict(list)
        for path, ref in entries:
            digest = _probe(path, size)
            if digest:
                by_hash[digest].append(ref)
        for refs in by_hash.values():
            if len(refs) < 2:
                continue
            for ref in refs:
                if ref >= 0:
                    file_group[ref] = groups
                else:
                    outside_groups.append([outside[-1 - ref][0], groups])
            groups += 1

    for i, row in enumerate(files):
        row.append(file_group.get(i))

    return {
        "roots": scanned_roots,
        "scannedAt": time.time(),
        "seconds": round(time.time() - started, 2),
        "dirs": dirs,
        "files": files,  # [dirIndex, name, size, mtime, copyGroup | null]
        "outside": outside_groups,  # [[path, copyGroup]] library files outside the roots that have copies
    }
