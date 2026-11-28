"""Move files to the macOS Trash (never deletes outright), and bring them back.

Uses NSFileManager.trashItemAtURL through JavaScript for Automation (osascript): no Finder
automation permission is needed and no trash sound plays (the user may be DJing). Finder's
"Put Back" may not know about these items, so every move is logged to trash_log.jsonl with
its original path and size, and restore_from_trash() uses that log to move files back.
"""

from __future__ import annotations

import json
import os
import subprocess
import time
from pathlib import Path
from .i18n import tr

TRASH_DIR = Path.home() / ".Trash"

JXA = r"""
ObjC.import('Foundation');
function run(argv) {
  const fm = $.NSFileManager.defaultManager;
  const out = [];
  for (const p of argv) {
    // The resulting-URL out-parameter crashes osascript, so it is not requested.
    const err = $();
    const ok = fm.trashItemAtURLResultingItemURLError($.NSURL.fileURLWithPath(p), null, err);
    out.push(ok ? { path: p, ok: true } : { path: p, ok: false, error: err.isNil() ? 'unknown error' : ObjC.unwrap(err.localizedDescription) });
  }
  return JSON.stringify(out);
}
"""
BATCH = 100


def move_to_trash(paths: list[str], log_path: Path, sizes: dict[str, int]) -> list[dict]:
    results: list[dict] = []
    for i in range(0, len(paths), BATCH):
        batch = paths[i : i + BATCH]
        try:
            proc = subprocess.run(
                ["osascript", "-l", "JavaScript", "-e", JXA, *batch],
                capture_output=True,
                text=True,
                timeout=120,
            )
            batch_results = json.loads(proc.stdout) if proc.returncode == 0 else None
        except (OSError, subprocess.TimeoutExpired, ValueError) as e:
            batch_results = None
            proc_error = str(e)
        else:
            proc_error = (proc.stderr or "").strip() or f"osascript exit {proc.returncode}"
        if batch_results is None:
            batch_results = [{"path": p, "ok": False, "error": proc_error} for p in batch]
        results.extend(batch_results)

    for r in results:
        r["size"] = sizes.get(r["path"])
    _log(log_path, "trash", results)
    return results


def _log(log_path: Path, action: str, results: list[dict]) -> None:
    at = time.strftime("%Y-%m-%dT%H:%M:%S%z")
    with open(log_path, "a", encoding="utf-8") as log:
        for r in results:
            log.write(json.dumps({"at": at, "action": action, **r}, ensure_ascii=False) + "\n")


def _trashed_entries(log_path: Path) -> dict[str, dict]:
    """Latest successful trash entry per original path (dropped again once restored)."""
    latest: dict[str, dict] = {}
    try:
        lines = log_path.read_text(encoding="utf-8").splitlines()
    except OSError:
        return latest
    for line in lines:
        try:
            e = json.loads(line)
        except ValueError:
            continue
        if not e.get("ok"):
            continue
        if e.get("action", "trash") == "trash":
            latest[e["path"]] = e
        elif e.get("action") == "restore":
            latest.pop(e["path"], None)
    return latest


def _find_in_trash(path: str, size: int | None) -> Path | None:
    name = os.path.basename(path)
    exact = TRASH_DIR / name
    if exact.is_file() and (size is None or exact.stat().st_size == size):
        return exact
    # A same-named item was already in the Trash, so macOS renamed this one ("name 2.mp3", "name 18.30.12.mp3"...).
    stem, ext = os.path.splitext(name)
    candidates = [
        e for e in os.scandir(TRASH_DIR)
        if e.is_file() and e.name.startswith(stem) and e.name.endswith(ext) and (size is None or e.stat().st_size == size)
    ]
    candidates.sort(key=lambda e: e.stat().st_ctime, reverse=True)
    return Path(candidates[0].path) if candidates else None


def restore_from_trash(paths: list[str], log_path: Path) -> list[dict]:
    trashed = _trashed_entries(log_path)
    results: list[dict] = []
    for p in paths:
        entry = trashed.get(p)
        if not entry:
            results.append({"path": p, "ok": False, "error": tr("trash.noRecord")})
            continue
        if os.path.exists(p):
            results.append({"path": p, "ok": False, "error": tr("trash.nameTaken")})
            continue
        try:
            found = _find_in_trash(p, entry.get("size"))
        except PermissionError:
            results.append({"path": p, "ok": False, "error": tr("trash.noPermission")})
            continue
        if not found:
            results.append({"path": p, "ok": False, "error": tr("trash.notInTrash")})
            continue
        try:
            os.makedirs(os.path.dirname(p), exist_ok=True)
            os.rename(found, p)
            results.append({"path": p, "ok": True})
        except OSError as e:
            results.append({"path": p, "ok": False, "error": str(e)})
    _log(log_path, "restore", [r for r in results if r["ok"]])
    return results
