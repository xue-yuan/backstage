"""Read each audio file's real codec and bit rate with macOS `afinfo` (read-only).

Serato's database only stores the file extension ("m4a", "mp3"), which cannot
tell AAC from lossless ALAC, and it leaves the bit rate empty for many tracks.
`afinfo` reads the file header. Results are cached in data/audio_info.json,
keyed by path and checked against size and mtime, so later runs only probe new
or changed files.
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import threading
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

FORMAT_RE = re.compile(r"Data format:\s+(\d+) ch,\s+([\d.]+) Hz, '?([^\s(']+)")
BITS_RE = re.compile(r"(\d+)-bit")
PCM_RE = re.compile(r"(?:Int|Float)(\d+)")  # some WAVs print "Int16, interleaved" instead of "lpcm"
CACHE_VERSION = 2
RATE_RE = re.compile(r"bit rate: (\d+) bits per second")
WORKERS = 8


def probe(path: str) -> list | None:
    """[codec, bitsPerSecond, sampleRate, bitDepth] from the file header.

    codec is "" when macOS cannot open the file at all (often a broken or mislabelled file);
    None is returned only when afinfo itself could not run.
    """
    try:
        out = subprocess.run(["afinfo", path], capture_output=True, text=True, timeout=15).stdout
    except (OSError, subprocess.TimeoutExpired):
        return None
    fm = FORMAT_RE.search(out)
    if not fm:
        return ["", None, None, None]
    codec = fm.group(3).strip(".,")
    line = out[fm.start():].split("\n", 1)[0]
    bits = BITS_RE.search(line)
    pcm = PCM_RE.fullmatch(codec)
    if pcm:
        codec, bits_val = "lpcm", int(pcm.group(1))
    else:
        bits_val = int(bits.group(1)) if bits else None
    rate = RATE_RE.search(out)
    return [codec, int(rate.group(1)) if rate else None, int(float(fm.group(2))), bits_val]


class AudioInfoProber:
    """Background prober with a size/mtime-checked JSON cache. Subclasses swap probe, version and workers."""

    version = CACHE_VERSION
    workers = WORKERS
    probe = staticmethod(probe)

    def __init__(self, cache_path: Path):
        self.cache_path = cache_path
        self.lock = threading.Lock()
        self.cache: dict[str, list] = {}  # path -> [size, mtime, codec, bps, sampleRate, bitDepth]
        self.paths: list[str] = []
        self.running = False
        self.done = 0
        self.total = 0
        self.error: str | None = None
        self.stopping = False  # stop() asks a run to finish early; unfinished files stay uncached
        try:
            stored = json.loads(cache_path.read_text())
            if stored.get("version") == self.version:
                self.cache = stored["files"]
        except (OSError, ValueError, AttributeError, KeyError):
            self.cache = {}

    def _todo(self, paths: list[str]) -> list[tuple[str, int, int]]:
        """Files not in the cache yet, or changed since (size / mtime). Call with the lock held."""
        todo = []
        for p in paths:
            try:
                st = os.stat(p)
            except OSError:
                continue
            hit = self.cache.get(p)
            if not hit or hit[0] != st.st_size or hit[1] != int(st.st_mtime):
                todo.append((p, st.st_size, int(st.st_mtime)))
        return todo

    def use_paths(self, paths: list[str]) -> None:
        """Set the files items() reports on, without probing anything."""
        with self.lock:
            if not self.running:
                self.paths = paths

    def coverage(self, paths: list[str]) -> dict:
        """How many of these files are already probed, and how many still need it."""
        on_disk = [p for p in paths if os.path.exists(p)]
        with self.lock:
            pending = len(self._todo(on_disk))
        return {"checked": len(on_disk) - pending, "pending": pending}

    def start(self, paths: list[str]) -> None:
        with self.lock:
            if self.running:
                return
            self.paths = paths
            todo = self._todo(paths)
            self.total = len(todo)
            self.done = 0
            self.error = None
            self.stopping = False
            if not todo:
                return
            self.running = True
        threading.Thread(target=self._run, args=(todo,), daemon=True).start()

    def stop(self) -> None:
        with self.lock:
            if self.running:
                self.stopping = True

    def _run(self, todo: list[tuple[str, int, int]]) -> None:
        try:
            with ThreadPoolExecutor(max_workers=self.workers) as pool:
                results = pool.map(lambda t: None if self.stopping else self.probe(t[0]), todo)
                for n, ((path, size, mtime), info) in enumerate(zip(todo, results), 1):
                    with self.lock:
                        if info is not None:  # failed to run (or stopped): leave uncached, retry next time
                            self.cache[path] = [size, mtime, *info]
                            self.done += 1
                    if n % 100 == 0:
                        self._save()  # long runs keep their progress if the app quits
            self._save()
        except Exception as e:  # keep the app usable; the UI falls back to Serato's data
            self.error = str(e)
        finally:
            with self.lock:
                self.running = False

    def _save(self) -> None:
        with self.lock:
            data = json.dumps({"version": self.version, "files": self.cache}, ensure_ascii=False)
        tmp = self.cache_path.with_suffix(".json.tmp")
        tmp.write_text(data)
        os.replace(tmp, self.cache_path)

    def status(self) -> dict:
        with self.lock:
            return {"running": self.running, "stopping": self.stopping, "done": self.done, "total": self.total, "error": self.error}

    def items(self) -> dict[str, list]:
        """path -> [codec, bitsPerSecond, sampleRate, bitDepth] for the current set of files."""
        with self.lock:
            return {p: self.cache[p][2:] for p in self.paths if p in self.cache}
