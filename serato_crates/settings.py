"""settings.json in the data folder: the interface language ("lang") and the music folders ("musicFolders")."""

from __future__ import annotations

import json
import os
import threading
from pathlib import Path

_lock = threading.Lock()


def read_settings(data_dir: Path) -> dict:
    try:
        data = json.loads((data_dir / "settings.json").read_text())
    except (OSError, ValueError):
        return {}
    return data if isinstance(data, dict) else {}


def update_settings(data_dir: Path, **values) -> None:
    """Set some keys and keep the others (written atomically)."""
    with _lock:
        path = data_dir / "settings.json"
        settings = read_settings(data_dir)
        settings.update(values)
        tmp = path.with_suffix(".json.tmp")
        tmp.write_text(json.dumps(settings, ensure_ascii=False, indent=2))
        os.replace(tmp, path)
