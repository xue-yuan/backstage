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
    def __init__(self, cache_path: Path):
        self.cache_path = cache_path
        self.lock = threading.Lock()
        self.cache: dict[str, list] = {}  # path -> [size, mtime, codec, bps, sampleRate, bitDepth]
        self.paths: list[str] = []
        self.running = False
        self.done = 0
        self.total = 0
        self.error: str | None = None
        try:
            stored = json.loads(cache_path.read_text())
            if stored.get("version") == CACHE_VERSION:
                self.cache = stored["files"]
        except (OSError, ValueError, AttributeError, KeyError):
            self.cache = {}

    def start(self, paths: list[str]) -> None:
        with self.lock:
            if self.running:
                return
            self.paths = paths
            todo = []
            for p in paths:
                try:
                    st = os.stat(p)
                except OSError:
                    continue
                hit = self.cache.get(p)
                if not hit or hit[0] != st.st_size or hit[1] != int(st.st_mtime):
                    todo.append((p, st.st_size, int(st.st_mtime)))
            self.total = len(todo)
            self.done = 0
            self.error = None
            if not todo:
                return
            self.running = True
        threading.Thread(target=self._run, args=(todo,), daemon=True).start()

    def _run(self, todo: list[tuple[str, int, int]]) -> None:
        try:
            with ThreadPoolExecutor(max_workers=WORKERS) as pool:
                for (path, size, mtime), info in zip(todo, pool.map(lambda t: probe(t[0]), todo)):
                    with self.lock:
                        if info is not None:  # afinfo failed to run: leave uncached, retry next time
                            self.cache[path] = [size, mtime, *info]
                        self.done += 1
            self._save()
        except Exception as e:  # keep the app usable; the UI falls back to Serato's data
            self.error = str(e)
        finally:
            with self.lock:
                self.running = False

    def _save(self) -> None:
        with self.lock:
            data = json.dumps({"version": CACHE_VERSION, "files": self.cache}, ensure_ascii=False)
        tmp = self.cache_path.with_suffix(".json.tmp")
        tmp.write_text(data)
        os.replace(tmp, self.cache_path)

    def status(self) -> dict:
        with self.lock:
            return {"running": self.running, "done": self.done, "total": self.total, "error": self.error}

    def items(self) -> dict[str, list]:
        """path -> [codec, bitsPerSecond, sampleRate, bitDepth] for the current set of files."""
        with self.lock:
            return {p: self.cache[p][2:] for p in self.paths if p in self.cache}
