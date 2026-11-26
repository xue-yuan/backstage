"""Server-side messages: English in the code, Traditional Chinese when the page is set to Chinese.

The page tells the server its language (POST /api/settings). It is stored in settings.json in the
data folder, so the next server start and the Mac app's startup dialogs use it too.
The translation function is tr(), not _(), because several modules use _ as a throwaway variable.
"""

from __future__ import annotations

import json
import os
from pathlib import Path

from .locale_zh import ZH

LANGS = ("en", "zh")
_lang = "en"


def lang() -> str:
    return _lang


def _read(path: Path) -> dict:
    try:
        data = json.loads(path.read_text())
    except (OSError, ValueError):
        return {}
    return data if isinstance(data, dict) else {}


def load(data_dir: Path) -> None:
    global _lang
    value = _read(data_dir / "settings.json").get("lang")
    _lang = value if value in LANGS else "en"


def save(data_dir: Path, value: str) -> None:
    global _lang
    if value not in LANGS:
        raise ValueError(f"unknown language: {value}")
    path = data_dir / "settings.json"
    settings = _read(path)
    settings["lang"] = value
    tmp = path.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(settings, ensure_ascii=False, indent=2))
    os.replace(tmp, path)
    _lang = value


def tr(text: str, **params) -> str:
    """Translate `text` and fill {placeholders} from `params`."""
    out = ZH.get(text, text) if _lang == "zh" else text
    return out.format(**params) if params else out


def trn(n: int, one: str, other: str, **params) -> str:
    """Count-aware tr(): {n} is filled in. Chinese has one form, keyed by the plural English text."""
    return tr(other if n != 1 or _lang == "zh" else one, n=n, **params)
