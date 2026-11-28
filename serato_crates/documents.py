"""JSON files in the data folder that the page edits as a whole: the plan, screening marks, notes,
unsorted-crate rules and marks (files marked genuine, dismissed duplicate groups, pinned crates).

Each file carries a revision number. A write must name the revision it was based on; if the file
changed in the meantime (another window, or the browser version next to the Mac app), the write is
refused with a Conflict instead of silently overwriting changes the writer has not seen.
"""

from __future__ import annotations

import copy
import json
import os
import shutil
import threading
from collections.abc import Callable
from pathlib import Path

from .i18n import tr


class Conflict(Exception):
    """The document changed since the writer read it."""

    def __init__(self, rev: int):
        super().__init__(tr("request.conflict"))
        self.rev = rev


class JsonDocument:
    def __init__(self, path: Path, default: dict, clean: Callable[[dict], dict], keep_previous: bool = False):
        """clean(body) validates a written body and returns what to store (ValueError if invalid).
        keep_previous: copy the file to <name>.prev.json before each write, in case of a mistake."""
        self.path = path
        self.default = default
        self.clean = clean
        self.keep_previous = keep_previous
        self.lock = threading.Lock()

    def read(self) -> dict:
        data = json.loads(self.path.read_text()) if self.path.exists() else copy.deepcopy(self.default)
        data.setdefault("rev", 0)
        return data

    def write(self, body: dict) -> int:
        """Store `body` if its "rev" is the current revision; returns the new revision."""
        if not isinstance(body, dict):
            raise ValueError(tr("request.invalidBody"))
        with self.lock:
            current = self.read()["rev"]
            if body.get("rev") != current:
                raise Conflict(current)
            data = self.clean({k: v for k, v in body.items() if k != "rev"})
            data["rev"] = current + 1
            if self.keep_previous and self.path.exists():
                shutil.copy2(self.path, self.path.with_name(f"{self.path.stem}.prev.json"))
            tmp = self.path.with_suffix(".json.tmp")
            tmp.write_text(json.dumps(data, ensure_ascii=False, indent=1))
            os.replace(tmp, self.path)
            return data["rev"]


# ---- what each document may contain ----


def clean_plan(body: dict) -> dict:
    if not isinstance(body.get("changes"), list):
        raise ValueError(tr("request.invalidPlan"))
    return body


def clean_screen(body: dict) -> dict:
    if not all(isinstance(body.get(k), list) for k in ("reject", "keep")):
        raise ValueError(tr("request.invalidScreen"))
    return {"reject": body["reject"], "keep": body["keep"]}


def clean_notes(body: dict) -> dict:
    notes = body.get("notes")
    if not isinstance(notes, list) or not all(isinstance(n, dict) and isinstance(n.get("id"), str) and isinstance(n.get("text"), str) for n in notes):
        raise ValueError(tr("request.invalidNotes"))
    return {"version": 1, "notes": notes}


def clean_rules(body: dict) -> dict:
    overrides = body.get("overrides")
    if not isinstance(overrides, dict) or any(v not in ("count", "skip") for v in overrides.values()):
        raise ValueError(tr("request.invalidRules"))
    return {"overrides": overrides, "saved": True}


def clean_marks(body: dict) -> dict:
    genuine, dismissed, pinned = body.get("genuine"), body.get("dismissedDuplicates"), body.get("pinnedCrates")
    if not (
        isinstance(genuine, list)
        and all(isinstance(x, str) for x in genuine)
        and isinstance(dismissed, list)
        and all(isinstance(x, str) for x in dismissed)
        and isinstance(pinned, list)
        and all(isinstance(x, (int, str)) and not isinstance(x, bool) for x in pinned)
    ):
        raise ValueError(tr("request.invalidMarks"))
    return {"genuine": genuine, "dismissedDuplicates": dismissed, "pinnedCrates": pinned}


def documents(data_dir: Path) -> dict[str, JsonDocument]:
    """The documents by the name used in their URL (/api/<name>)."""
    return {
        "plan": JsonDocument(data_dir / "plan.json", {"version": 1, "changes": []}, clean_plan),
        "screen": JsonDocument(data_dir / "screen.json", {"reject": [], "keep": []}, clean_screen),
        "notes": JsonDocument(data_dir / "notes.json", {"version": 1, "notes": []}, clean_notes, keep_previous=True),
        "rules": JsonDocument(data_dir / "rules.json", {"overrides": {}, "saved": False}, clean_rules),
        "marks": JsonDocument(data_dir / "marks.json", {"genuine": [], "dismissedDuplicates": [], "pinnedCrates": []}, clean_marks),
    }
