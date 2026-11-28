"""Server-side messages: English in the code, Traditional Chinese when the page is set to Chinese.

The page tells the server its language (POST /api/settings). It is stored in settings.json in the
data folder, so the next server start and the Mac app's startup dialogs use it too. Until a language
is chosen, it follows the Mac's first preferred language (Chinese → Traditional Chinese, else English).
The translation function is tr(), not _(), because several modules use _ as a throwaway variable.
"""

from __future__ import annotations

import re
import subprocess
from pathlib import Path

from .locale_zh import ZH
from .settings import read_settings, update_settings

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


def tr(text: str, **params) -> str:
    """Translate `text` and fill {placeholders} from `params`."""
    out = ZH.get(text, text) if _lang == "zh" else text
    return out.format(**params) if params else out


def trn(n: int, one: str, other: str, **params) -> str:
    """Count-aware tr(): {n} is filled in. Chinese has one form, keyed by the plural English text."""
    return tr(other if n != 1 or _lang == "zh" else one, n=n, **params)
