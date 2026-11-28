"""Server-side messages by key: tr("area.name", **params) and trn(n, "area.name", **params).

The text for each key is in static/locales/en.json and zh-Hant.json, shared with the page and the
Mac app. The page tells the server its language
(POST /api/settings). It is stored in settings.json in the data folder, so the next server start and
the Mac app's startup dialogs use it too. Until a language is chosen, it follows the Mac's first
preferred language (Chinese → Traditional Chinese, else English). The translation function is tr(),
not _(), because several modules use _ as a throwaway variable.
"""

from __future__ import annotations

import json
import re
import subprocess
from pathlib import Path

from .settings import read_settings, update_settings

# Next to serato_crates/ both in the repository and in the Mac app's bundle (server/static/locales).
LOCALES = Path(__file__).resolve().parent.parent / "static" / "locales"
EN = json.loads((LOCALES / "en.json").read_text(encoding="utf-8"))
ZH = json.loads((LOCALES / "zh-Hant.json").read_text(encoding="utf-8"))

LANGS = ("en", "zh")
_lang = "en"
_saved = False


def lang() -> str:
    return _lang


def saved() -> bool:
    """Whether the language was chosen (False: it follows the Mac's language)."""
    return _saved


def system_lang() -> str:
    """'zh' when Chinese is the Mac's first preferred language, else 'en'."""
    try:
        out = subprocess.run(["defaults", "read", "-g", "AppleLanguages"], capture_output=True, text=True, timeout=3).stdout
    except (OSError, subprocess.TimeoutExpired):
        return "en"
    first = re.findall(r"[A-Za-z]{2,3}(?:-[A-Za-z0-9]+)*", out)  # e.g. ( "zh-Hant-TW", "en-TW" )
    return "zh" if first and first[0].lower().startswith("zh") else "en"


def load(data_dir: Path) -> None:
    global _lang, _saved
    value = read_settings(data_dir).get("lang")
    _saved = value in LANGS
    _lang = value if _saved else system_lang()


def save(data_dir: Path, value: str) -> None:
    global _lang, _saved
    if value not in LANGS:
        raise ValueError(f"unknown language: {value}")
    update_settings(data_dir, lang=value)
    _lang, _saved = value, True


def _entry(key: str):
    """The text for `key` in the current language, else English, else the key itself."""
    table = ZH if _lang == "zh" else EN
    return table.get(key, EN.get(key, key))


def tr(key: str, **params) -> str:
    """Text for `key` with {placeholders} filled from `params`. A counted entry gives its "other" form."""
    out = _entry(key)
    if isinstance(out, dict):
        out = out["other"]
    return out.format(**params) if params else out


def trn(n: int, key: str, **params) -> str:
    """Count-aware tr(); {n} is filled in."""
    out = _entry(key)
    if isinstance(out, dict):
        out = out["one"] if n == 1 and "one" in out else out["other"]
    return out.format(n=n, **params)
