"""The folders that hold the DJ music.

The Folders view scans them, and finding missing files searches them plus ~/Music. They are saved in
settings.json ("musicFolders") once the user confirms them; until then a suggestion worked out from
where the songs in the Serato library are is used.
"""

from __future__ import annotations

import os
import subprocess
from collections import Counter, defaultdict
from pathlib import Path

from .i18n import tr
from .settings import read_settings, update_settings

KEY = "musicFolders"
MAX_FOLDERS = 10


def saved(data_dir: Path) -> list[Path] | None:
    """The confirmed folders, or None when the user has not chosen yet."""
    value = read_settings(data_dir).get(KEY)
    if not isinstance(value, list):
        return None
    return [Path(p) for p in value if isinstance(p, str) and p]


def save(data_dir: Path, folders: list[Path]) -> None:
    update_settings(data_dir, **{KEY: [str(p) for p in folders]})


def clean(values) -> list[Path]:
    """Check folders sent by the page: full paths of existing folders (~ allowed), no repeats, none inside another."""
    if not isinstance(values, list) or not values:
        raise ValueError(tr("Choose at least one music folder"))
    found: set[Path] = set()
    for value in values:
        if not isinstance(value, str) or not value.strip():
            raise ValueError(tr("invalid folder"))
        p = Path(os.path.normpath(os.path.expanduser(value.strip())))
        if not p.is_absolute():
            raise ValueError(tr("Not a full path: {path}", path=value))
        if not p.is_dir():
            raise ValueError(tr("Folder not found: {path}", path=value))
        found.add(p)
    kept: list[Path] = []
    for p in sorted(found, key=lambda p: (len(p.parts), str(p))):
        if not any(p.is_relative_to(k) for k in kept):  # a folder inside another one is scanned already
            kept.append(p)
    if len(kept) > MAX_FOLDERS:
        raise ValueError(tr("No more than {n} music folders", n=MAX_FOLDERS))
    return sorted(kept, key=str)


def suggest(paths: list[str], home: Path | None = None) -> list[Path]:
    """Where the library's songs are.

    Songs are grouped by area: a folder in the home folder (~/Music, ~/Downloads…), a drive under
    /Volumes, or a top-level folder. In each area the suggestion goes down (at most two levels) to the
    deepest folder that still holds 80% of the area's songs (~/Music/DJ rather than ~/Music when that
    is where they are). Areas are taken biggest first until they hold 90% of the songs (at most 4; areas with
    under 3% of the songs are left out).
    """
    home = home or Path.home()
    hp = home.parts
    groups: dict[tuple[str, ...], list[tuple[str, ...]]] = defaultdict(list)
    for p in paths:
        parts = Path(p).parent.parts
        if parts[: len(hp)] == hp and len(parts) > len(hp):
            n = len(hp) + 1
        elif parts[:2] == ("/", "Volumes") and len(parts) > 2:
            n = 3
        else:
            n = min(len(parts), 2)
        groups[parts[:n]].append(parts)
    total = sum(len(g) for g in groups.values())
    picked: list[Path] = []
    covered = 0
    for anchor, members in sorted(groups.items(), key=lambda kv: -len(kv[1])):
        if covered >= 0.9 * total or len(picked) == 4 or len(members) < 0.03 * total:
            break
        node = anchor
        while len(node) < len(anchor) + 2:
            below = Counter(m[: len(node) + 1] for m in members if len(m) > len(node) and m[: len(node)] == node)
            if not below:
                break
            child, count = below.most_common(1)[0]
            if count < 0.8 * len(members):
                break
            node = child
        picked.append(Path(*node))
        covered += len(members)
    if picked:
        return sorted(picked, key=str)
    music = home / "Music"
    return [music if music.is_dir() else home]


def relocate_roots(folders: list[Path], home: Path | None = None) -> list[Path]:
    """Where to look for missing files: the music folders and ~/Music (where music is usually kept)."""
    music = (home or Path.home()) / "Music"
    if not music.is_dir() or any(music.is_relative_to(f) for f in folders):
        return list(folders)
    return [f for f in folders if not f.is_relative_to(music)] + [music]


def choose_folder() -> str | None:
    """Ask with the macOS folder dialog (osascript, so no extra permission). None when cancelled."""
    prompt = tr("Choose a folder that contains DJ music")
    quoted = '"' + prompt.replace("\\", "\\\\").replace('"', '\\"') + '"'
    script = f"POSIX path of (choose folder with prompt {quoted} default location (path to music folder))"
    try:
        # "activate" brings the dialog in front of the app window.
        done = subprocess.run(["osascript", "-e", "activate", "-e", script], capture_output=True, text=True, timeout=900)
    except (OSError, subprocess.TimeoutExpired):
        return None
    path = done.stdout.strip()
    if done.returncode != 0 or not path:
        return None
    return path.rstrip("/") or "/"
