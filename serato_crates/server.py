"""Local HTTP server: JSON API + static UI + audio preview. Binds to 127.0.0.1 only."""

from __future__ import annotations

import json
import mimetypes
import os
import re
import shutil
import subprocess
import threading
import unicodedata
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from .apply import ApplyError, apply_changes, backup as backup_serato, files_in_use, restore as restore_serato, serato_processes, serato_running
from .audioinfo import AudioInfoProber
from .documents import Conflict, documents
from .spectrum import SpectrumProber
from .folders import scan_folders
from .library import load_library, scan_audio_files
from .snapshot import DEFAULT_SOURCE, SnapshotError, load_meta, source_signature, take_snapshot
from .trash import move_to_trash, restore_from_trash
from . import i18n, musicfolders
from .i18n import tr

STATIC_DIR = Path(__file__).resolve().parent.parent / "static"


def _version() -> str:
    """The app version from package.json (next to app.py, also in the Mac app's bundle)."""
    try:
        return str(json.loads((STATIC_DIR.parent / "package.json").read_text())["version"])
    except (OSError, ValueError, KeyError):
        return "dev"


VERSION = _version()
AUDIO_TYPES = {
    ".mp3": "audio/mpeg",
    ".m4a": "audio/mp4",
    ".mp4": "audio/mp4",
    ".aac": "audio/aac",
    ".wav": "audio/wav",
    ".flac": "audio/flac",
    ".aif": "audio/aiff",
    ".aiff": "audio/aiff",
    ".ogg": "audio/ogg",
}
SERATO_LIBRARY = DEFAULT_SOURCE.parent
BACKUPS_DIR = Path.home() / "Cratify Backups"
SERATO_BACKUPS = BACKUPS_DIR / "Serato Library"
BEFORE_APPLY = "before apply"  # suffix of the backup folder made before each apply
OLD_BEFORE_APPLY = "套用前"  # the same suffix before 2026-11-28; the restore button still finds those backups


def path_key(p: str) -> str:
    """Same file on macOS regardless of Unicode normalisation or letter case."""
    return unicodedata.normalize("NFC", p).casefold()


class AppState:
    def __init__(self, data_dir: Path):
        self.data_dir = data_dir
        self.lock = threading.Lock()
        self.library: dict | None = None
        self.meta: dict | None = None
        self.track_paths: dict[int, str] = {}
        self.extra_audio_paths: set[str] = set()
        self.folder_scan: dict | None = None
        self.folder_files: set[str] = set()  # audio files found by the folder scan (preview allowed)
        self.folder_dirs: set[str] = set()  # folders found by the folder scan (reveal allowed)
        self.audio_info = AudioInfoProber(data_dir / "audio_info.json")
        self.spectrum = SpectrumProber(data_dir / "spectrum.json")
        self.apply_lock = threading.Lock()
        self.documents = documents(data_dir)  # plan, screen, notes, rules, marks (see documents.py)

    def ensure_library(self, refresh: bool = False) -> dict:
        with self.lock:
            if refresh or load_meta(self.data_dir) is None:
                take_snapshot(self.data_dir)
                self.library = None
            if self.library is None:
                self.meta = load_meta(self.data_dir)
                self.library = load_library(self.data_dir / "snapshot.sqlite")
                self.track_paths = {t["id"]: t["path"] for t in self.library["tracks"]}
            return {"snapshot": self.meta, "readOnly": True, **self.library}

    def watch(self) -> dict:
        """Cheap status for the page's poll: is Serato open, and has its library changed since our snapshot?"""
        signature = source_signature(SERATO_LIBRARY / "master.sqlite")
        meta = load_meta(self.data_dir)
        return {
            "seratoRunning": serato_running(),
            "signature": signature,
            "libraryChanged": meta is not None and meta.get("sourceSignature") != signature,
        }

    # ---- apply the plan to Serato (Serato closed; rehearse on a copy, back up, write, verify) ----
    def apply_status(self) -> dict:
        found = (p for suffix in (BEFORE_APPLY, OLD_BEFORE_APPLY) for p in SERATO_BACKUPS.glob(f"*{suffix}") if (p / "master.sqlite").exists())
        backups = sorted(found, key=lambda p: p.name, reverse=True)  # names start with the time
        procs = serato_processes()
        return {
            "seratoRunning": bool(procs),
            "seratoProcesses": procs,
            "inUse": files_in_use(SERATO_LIBRARY),
            "backupsDir": str(SERATO_BACKUPS),
            "lastBackup": str(backups[0]) if backups else None,
        }

    def apply(self, changes: list, expected: dict, expected_order: dict | None = None) -> dict:
        if not self.apply_lock.acquire(blocking=False):
            raise ApplyError(tr("server.alreadyApplying"))
        try:
            if serato_running():
                raise ApplyError(tr("server.seratoOpen"))
            busy = files_in_use(SERATO_LIBRARY)
            if busy:
                raise ApplyError(tr("server.databaseInUse", files=", ".join(busy)))
            # 1) Rehearse on a private copy: any problem stops here, before Serato is touched.
            rehearsal = self.data_dir / "apply-rehearsal"
            shutil.rmtree(rehearsal, ignore_errors=True)
            rehearsal.mkdir()
            for name in ("master.sqlite", "master.sqlite-wal", "master.sqlite-shm", "root.sqlite"):
                if (SERATO_LIBRARY / name).exists():
                    shutil.copy2(SERATO_LIBRARY / name, rehearsal / name)
            apply_changes(rehearsal, changes, expected, expected_order=expected_order)
            shutil.rmtree(rehearsal, ignore_errors=True)
            # 2) Back up the real databases, 3) write them (one transaction, verified before commit).
            dest = backup_serato(SERATO_LIBRARY, SERATO_BACKUPS, BEFORE_APPLY)
            result = apply_changes(SERATO_LIBRARY, changes, expected, expected_order=expected_order)
            result["backup"] = str(dest)
        finally:
            self.apply_lock.release()
        # 4) Only now, with the database committed, move rejected songs' files to the Trash.
        # trash() takes a fresh snapshot and refuses any file Serato still uses.
        doomed = [r["path"] for r in result.get("removed", []) if r.get("deleteFile")]
        if doomed:
            try:
                result["trashed"] = self.trash(doomed)["results"]
            except Exception as e:  # the Serato write already succeeded; report, don't fail it
                result["trashed"] = [{"path": p, "ok": False, "error": str(e)} for p in doomed]
        else:
            self.ensure_library(refresh=True)
        return result

    def restore_serato(self, backup_dir: str) -> dict:
        target = Path(backup_dir).resolve()
        if not target.is_relative_to(SERATO_BACKUPS.resolve()):
            raise ApplyError(tr("server.notABackup"))
        busy = files_in_use(SERATO_LIBRARY)
        if busy:
            raise ApplyError(tr("server.databaseInUse", files=", ".join(busy)))
        restore_serato(SERATO_LIBRARY, target)
        self.ensure_library(refresh=True)
        return {"ok": True, "restoredFrom": str(target)}

    # ---- move rejected files to the Trash (only files Serato does not use) ----
    def trash(self, paths: list) -> dict:
        # Fresh snapshot first: a file imported into Serato since the last one must never be trashed.
        lib = self.ensure_library(refresh=True)
        self.folders()
        serato = {path_key(t["path"]) for t in lib["tracks"]}
        with self.lock:
            scanned = set(self.folder_files)
        todo: list[str] = []
        sizes: dict[str, int] = {}
        refused: list[dict] = []
        for p in dict.fromkeys(str(x) for x in paths):
            if p not in scanned:
                refused.append({"path": p, "ok": False, "error": tr("server.notScanned")})
            elif path_key(p) in serato:
                refused.append({"path": p, "ok": False, "error": tr("server.inSerato")})
            elif not os.path.isfile(p):
                refused.append({"path": p, "ok": False, "error": tr("server.fileGone")})
            else:
                sizes[p] = os.path.getsize(p)
                todo.append(p)
        results = move_to_trash(todo, self.data_dir / "trash_log.jsonl", sizes) + refused
        with self.lock:
            self.folder_scan = None  # files changed: rescan on the next request
        return {"results": results}

    def untrash(self, paths: list) -> dict:
        results = restore_from_trash([str(p) for p in paths], self.data_dir / "trash_log.jsonl")
        with self.lock:
            self.folder_scan = None
        return {"results": results}

    def relocate_candidates(self) -> dict:
        lib = self.ensure_library()
        roots = musicfolders.relocate_roots(self.music_folders())
        index = scan_audio_files(roots)
        result: dict[str, list[dict]] = {}
        allowed: set[str] = set()
        for t in lib["tracks"]:
            if t["exists"]:
                continue
            found = [c for c in index.get(t["fileName"].lower(), []) if c["path"] != t["path"]]
            result[str(t["id"])] = found
            allowed.update(c["path"] for c in found)
        with self.lock:
            self.extra_audio_paths = allowed
        return {"roots": [str(r) for r in roots], "candidates": result}

    # ---- music folders: what the Folders view scans (settings.json; suggested until confirmed) ----
    def music_folders(self) -> list[Path]:
        chosen = musicfolders.saved(self.data_dir)
        return chosen if chosen is not None else self.suggested_music_folders()

    def suggested_music_folders(self) -> list[Path]:
        lib = self.ensure_library()
        return musicfolders.suggest([t["path"] for t in lib["tracks"] if t["exists"]])

    def music_folder_settings(self) -> dict:
        chosen = musicfolders.saved(self.data_dir)
        suggested = self.suggested_music_folders()
        folders = chosen if chosen is not None else suggested
        return {
            "folders": [str(p) for p in folders],
            "saved": chosen is not None,
            "suggested": [str(p) for p in suggested],
            "missing": [str(p) for p in folders if not p.is_dir()],  # e.g. a drive that is not connected
        }

    def save_music_folders(self, values) -> dict:
        musicfolders.save(self.data_dir, musicfolders.clean(values))
        with self.lock:
            self.folder_scan = None  # rescan on the next request
        return self.music_folder_settings()

    def folders(self, refresh: bool = False) -> dict:
        lib = self.ensure_library()
        with self.lock:
            if self.folder_scan is not None and not refresh:
                return self.folder_scan
        scan = scan_folders(self.music_folders(), [t["path"] for t in lib["tracks"] if t["exists"]])
        # Folders that Serato still points at but that no longer exist (moved or renamed).
        scan["goneDirs"] = sorted(d for d in {os.path.dirname(t["path"]) for t in lib["tracks"] if not t["exists"]} if not os.path.isdir(d))
        dirs = scan["dirs"]
        roots = set(scan["roots"])
        folder_dirs = set(roots)
        for d in dirs:  # every folder from a root down to each folder with audio
            while d not in folder_dirs and d not in ("/", ""):
                folder_dirs.add(d)
                d = os.path.dirname(d)
        with self.lock:
            self.folder_scan = scan
            self.folder_files = {os.path.join(dirs[f[0]], f[1]) for f in scan["files"]}
            self.folder_dirs = folder_dirs
        return scan

    def start_audio_info(self) -> dict:
        """Probe codec / bit rate of every scanned file and every track Serato reads (in the background)."""
        lib = self.ensure_library()
        self.folders()
        with self.lock:
            paths = sorted(self.folder_files | {t["path"] for t in lib["tracks"] if t["exists"]})
        self.audio_info.start(paths)
        return self.audio_info.status()

    def spectrum_paths(self) -> list[str]:
        """The files the transcode check covers: the same set as the format reading."""
        lib = self.ensure_library()
        self.folders()
        with self.lock:
            return sorted(self.folder_files | {t["path"] for t in lib["tracks"] if t["exists"]})

    def spectrum_status(self, items: bool = False) -> dict:
        paths = self.spectrum_paths()
        self.spectrum.use_paths(paths)
        payload = {**self.spectrum.status(), **self.spectrum.coverage(paths)}
        if items:
            payload["items"] = self.spectrum.items()
        return payload

    def spectrum_action(self, body: dict) -> dict:
        """Start (only new or changed files) or stop the transcode check. It never runs on its own."""
        if body.get("action") == "stop":
            self.spectrum.stop()
        elif body.get("action") == "start":
            self.spectrum.start(self.spectrum_paths(), str(body.get("speed", "normal")))
        return self.spectrum_status()

    def can_read(self, path: str) -> bool:
        """Scanned files and library songs (for spectrum pictures)."""
        with self.lock:
            return path in self.folder_files or path in self.extra_audio_paths or path in self.track_paths.values()

    def can_preview(self, path: str) -> bool:
        with self.lock:
            return path in self.extra_audio_paths or path in self.folder_files

    def reveal(self, path: str) -> None:
        """Show a scanned folder or file in Finder (macOS `open`; nothing is modified)."""
        with self.lock:
            is_dir = path in self.folder_dirs
            is_file = path in self.folder_files or path in self.track_paths.values()
        if not (is_dir or is_file) or not os.path.exists(path):
            raise ValueError(tr("server.openScannedOnly"))
        cmd = ["open", "-a", "Finder", path] if is_dir else ["open", "-R", path]
        subprocess.run(cmd, check=False, timeout=10)


def make_handler(state: AppState, port: int):
    allowed_hosts = {f"127.0.0.1:{port}", f"localhost:{port}"}

    class Handler(BaseHTTPRequestHandler):
        server_version = f"Cratify/{VERSION}"

        def log_message(self, fmt, *args):  # quieter console
            if not self.path.startswith("/api/audio"):
                super().log_message(fmt, *args)

        # ---------- helpers ----------
        def _host_ok(self) -> bool:
            # Blocks DNS-rebinding: only answer requests addressed to this local server.
            return self.headers.get("Host", "") in allowed_hosts

        def _json(self, payload, status=HTTPStatus.OK):
            body = json.dumps(payload, ensure_ascii=False).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)

        def _error(self, status, message):
            self._json({"error": message}, status)

        def _read_json(self):
            if not self.headers.get("Content-Type", "").startswith("application/json"):
                # Requiring JSON forces a CORS preflight, which we never approve.
                raise ValueError("Content-Type must be application/json")
            length = int(self.headers.get("Content-Length", "0"))
            return json.loads(self.rfile.read(length) or b"{}")

        def _send_file(self, path: str, content_type: str):
            try:
                size = os.path.getsize(path)
            except OSError:
                return self._error(HTTPStatus.NOT_FOUND, tr("server.fileNotFound"))
            start, end, status = 0, size - 1, HTTPStatus.OK
            rng = self.headers.get("Range")
            if rng:
                m = re.match(r"bytes=(\d*)-(\d*)", rng)
                if m:
                    s, e = m.groups()
                    if s == "" and e:
                        start = max(0, size - int(e))
                    elif s:
                        start = int(s)
                        end = min(int(e), size - 1) if e else size - 1
                    if start > end or start >= size:
                        self.send_response(HTTPStatus.REQUESTED_RANGE_NOT_SATISFIABLE)
                        self.send_header("Content-Range", f"bytes */{size}")
                        self.end_headers()
                        return
                    status = HTTPStatus.PARTIAL_CONTENT
            self.send_response(status)
            self.send_header("Content-Type", content_type)
            self.send_header("Accept-Ranges", "bytes")
            self.send_header("Content-Length", str(end - start + 1))
            if status == HTTPStatus.PARTIAL_CONTENT:
                self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
            self.end_headers()
            try:
                with open(path, "rb") as f:
                    f.seek(start)
                    remaining = end - start + 1
                    while remaining > 0:
                        chunk = f.read(min(256 * 1024, remaining))
                        if not chunk:
                            break
                        self.wfile.write(chunk)
                        remaining -= len(chunk)
            except (BrokenPipeError, ConnectionResetError):
                pass

        def _send_bytes(self, body: bytes, content_type: str):
            self.send_response(HTTPStatus.OK)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)

        def _send_audio(self, path: str | None):
            if not path:
                return self._error(HTTPStatus.NOT_FOUND, tr("server.notInLibrary"))
            ext = os.path.splitext(path)[1].lower()
            self._send_file(path, AUDIO_TYPES.get(ext, "application/octet-stream"))

        def _send_static(self, rel: str):
            target = (STATIC_DIR / rel).resolve()
            if not target.is_relative_to(STATIC_DIR) or not target.is_file():
                return self._error(HTTPStatus.NOT_FOUND, "not found")
            ctype = mimetypes.guess_type(target.name)[0] or "application/octet-stream"
            if ctype.startswith("text/") or ctype.endswith("javascript"):
                ctype += "; charset=utf-8"
            body = target.read_bytes()
            self.send_response(HTTPStatus.OK)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)

        # ---------- routes ----------
        def do_GET(self):
            if not self._host_ok():
                return self._error(HTTPStatus.FORBIDDEN, "bad host")
            url = urlparse(self.path)
            p = url.path
            try:
                if p == "/":
                    return self._send_static("index.html")
                if p.startswith("/static/"):
                    return self._send_static(p[len("/static/"):])
                if p == "/api/library":
                    return self._json(state.ensure_library())
                if p == "/api/watch":
                    return self._json(state.watch())
                if p == "/api/settings":
                    return self._json({"lang": i18n.lang(), "langSaved": i18n.saved(), "version": VERSION})
                if p == "/api/music-folders":
                    return self._json(state.music_folder_settings())
                if p.startswith("/api/") and p[len("/api/"):] in state.documents:
                    return self._json(state.documents[p[len("/api/"):]].read())
                if p == "/api/apply/status":
                    return self._json(state.apply_status())
                if p == "/api/relocate-candidates":
                    return self._json(state.relocate_candidates())
                if p == "/api/audio-info":
                    payload = state.audio_info.status()
                    if parse_qs(url.query).get("items", ["0"])[0] == "1":
                        payload["items"] = state.audio_info.items()
                    return self._json(payload)
                if p == "/api/spectrum":
                    return self._json(state.spectrum_status(items=parse_qs(url.query).get("items", ["0"])[0] == "1"))
                if p == "/api/spectrogram":
                    wanted = parse_qs(url.query).get("path", [""])[0]
                    if not state.can_read(wanted) or not os.path.isfile(wanted):
                        return self._error(HTTPStatus.NOT_FOUND, tr("server.notInLibrary"))
                    try:
                        png = state.spectrum.spectrogram(wanted)
                    except (ValueError, OSError, subprocess.TimeoutExpired) as e:
                        return self._error(HTTPStatus.SERVICE_UNAVAILABLE, str(e))
                    return self._send_bytes(png, "image/png")
                if p == "/api/folders":
                    refresh = parse_qs(url.query).get("refresh", ["0"])[0] == "1"
                    return self._json(state.folders(refresh=refresh))
                m = re.fullmatch(r"/api/audio/(\d+)", p)
                if m:
                    return self._send_audio(state.track_paths.get(int(m.group(1))))
                if p == "/api/audio-file":
                    wanted = parse_qs(url.query).get("path", [""])[0]
                    return self._send_audio(wanted if state.can_preview(wanted) else None)
                return self._error(HTTPStatus.NOT_FOUND, "not found")
            except SnapshotError as e:
                return self._error(HTTPStatus.SERVICE_UNAVAILABLE, str(e))

        def do_POST(self):
            if not self._host_ok():
                return self._error(HTTPStatus.FORBIDDEN, "bad host")
            try:
                body = self._read_json()
                if self.path == "/api/snapshot":
                    return self._json(state.ensure_library(refresh=True))
                if self.path == "/api/settings":
                    i18n.save(state.data_dir, str(body.get("lang")))
                    return self._json({"lang": i18n.lang(), "langSaved": i18n.saved(), "version": VERSION})
                if self.path == "/api/music-folders/choose":
                    return self._json({"path": musicfolders.choose_folder()})
                if self.path == "/api/audio-info":
                    return self._json(state.start_audio_info())
                if self.path == "/api/spectrum":
                    return self._json(state.spectrum_action(body))
                if self.path == "/api/apply":
                    order = body.get("expectedOrder")
                    if not isinstance(body.get("changes"), list) or not isinstance(body.get("expected"), dict) or not isinstance(order, (dict, type(None))):
                        raise ValueError(tr("request.invalidApply"))
                    try:
                        return self._json(state.apply(body["changes"], body["expected"], order))
                    except ApplyError as e:
                        return self._json({"ok": False, "error": str(e)})
                if self.path == "/api/apply/restore":
                    try:
                        return self._json(state.restore_serato(str(body.get("backup", ""))))
                    except ApplyError as e:
                        return self._json({"ok": False, "error": str(e)})
                if self.path == "/api/trash":
                    if not isinstance(body.get("paths"), list):
                        raise ValueError(tr("request.invalidPaths"))
                    return self._json(state.trash(body["paths"]))
                if self.path == "/api/untrash":
                    if not isinstance(body.get("paths"), list):
                        raise ValueError(tr("request.invalidPaths"))
                    return self._json(state.untrash(body["paths"]))
                if self.path == "/api/reveal":
                    state.reveal(str(body.get("path", "")))
                    return self._json({"ok": True})
                return self._error(HTTPStatus.NOT_FOUND, "not found")
            except SnapshotError as e:
                return self._error(HTTPStatus.SERVICE_UNAVAILABLE, str(e))
            except ValueError as e:
                return self._error(HTTPStatus.BAD_REQUEST, str(e))

        def do_PUT(self):
            if not self._host_ok():
                return self._error(HTTPStatus.FORBIDDEN, "bad host")
            try:
                body = self._read_json()
                name = self.path[len("/api/"):] if self.path.startswith("/api/") else ""
                if name in state.documents:
                    return self._json({"rev": state.documents[name].write(body)})
                if self.path == "/api/music-folders":
                    return self._json(state.save_music_folders(body.get("folders") if isinstance(body, dict) else None))
                return self._error(HTTPStatus.NOT_FOUND, "not found")
            except Conflict as e:
                return self._json({"error": str(e), "rev": e.rev}, HTTPStatus.CONFLICT)
            except SnapshotError as e:
                return self._error(HTTPStatus.SERVICE_UNAVAILABLE, str(e))
            except ValueError as e:
                return self._error(HTTPStatus.BAD_REQUEST, str(e))

    return Handler


def serve(data_dir: Path, port: int) -> ThreadingHTTPServer:
    i18n.load(data_dir)  # language for server messages, as last chosen in the page
    state = AppState(data_dir)
    httpd = ThreadingHTTPServer(("127.0.0.1", port), make_handler(state, port))
    httpd.daemon_threads = True
    return httpd
