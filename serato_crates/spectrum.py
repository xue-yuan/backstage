"""Spot transcodes ("fake 320k", "fake lossless") from where a file's high frequencies stop (read-only).

An encoder low-passes what it cannot afford: about 16.5 kHz at 128k, 17.5 kHz at 160k, 19 kHz at
192k, 19.5 kHz at 256k and 20 kHz at 320k, while lossless audio keeps going to 22 kHz. Converting a
file to a higher bit rate (or to WAV) cannot bring the cut-off part back, so an "MP3 320" whose sound
stops at 16.5 kHz was made from a 128k file.

ffmpeg decodes 3 x 10 s (at 30, 50 and 70 % of the song), splits the sound into 250 Hz bands from
14 to 22 kHz with steep FIR filters, and measures each band's level against an 8-12 kHz reference
band. A "wall" (a drop of tens of dB within a few hundred Hz, down to the noise floor) is an encoder's
low-pass; a gentle slope is just how the song sounds, so it gets no verdict.

Levels are measured in floating point (`astats`). ffmpeg's `volumedetect` works in 16 bits, so nothing
reads below about -90 dB: in a quiet song every band then looked like it had content ("full"), and a
wall going down to that floor looked like a slope. Cache version 1 was measured that way; loading it
keeps the files whose verdict the floor cannot have changed and leaves the rest to be checked again.

It only runs when asked (the Quality tab), to save power. The levels are cached in spectrum.json
(checked against size and mtime, like audio_info.json), so a run only analyses new or changed files.
Serato writes its analysis and cue points into the music file, which changes size and mtime but not
the sound. So each result also keeps an audio fingerprint (MD5 of the compressed audio packets of
0-10 s and 60-70 s, read without decoding, about 0.04 s a file): a changed file whose fingerprint is
the same keeps its result. Files checked before fingerprints existed get one in a single low-priority
pass when the Quality data is first asked for.
ffmpeg runs at background priority (efficiency cores), 1, 3 or 6 files at a time depending on the
chosen speed. Without ffmpeg (Homebrew's `brew install ffmpeg`) the feature is simply off.
"""

from __future__ import annotations

import os
import re
import shutil
import subprocess
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from .audioinfo import AudioInfoProber

FFMPEG_PATHS = ("/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg")
TASKPOLICY = "/usr/sbin/taskpolicy"
REF_BAND = (8000, 12000)
BANDS = [REF_BAND] + [(f, f + 250) for f in range(14000, 22000, 250)]  # reference + 32 bands (14.00-21.75 kHz)
LEVEL_RE = re.compile(r"Parsed_astats_(\d+) .*RMS level dB: (-?[\d.]+|-inf)")
DURATION_RE = re.compile(r"Duration: (\d+):(\d+):([\d.]+)")

# Verdict thresholds (calibrated on the whole library against an FFT analysis, 2026-11-27).
CONTENT_DB = -48  # a band "has content" when it is at most this far below the reference band
WALL_DB = 18  # level difference across the cut-off that makes it a wall, not a slope
S16_FLOOR_DB = -89.0  # cache version 1 (16-bit volumedetect) never read below about -90.5 dB


def find_ffmpeg() -> str | None:
    found = shutil.which("ffmpeg")
    return found or next((p for p in FFMPEG_PATHS if os.path.isfile(p)), None)


def _background(cmd: list[str]) -> list[str]:
    # macOS: efficiency cores and throttled disk access, so Serato never waits for us.
    return [TASKPOLICY, "-c", "background", *cmd] if os.path.exists(TASKPOLICY) else ["nice", "-n", "19", *cmd]


def fingerprint(ffmpeg: str, path: str, background: bool = False) -> str | None:
    """MD5 of the audio packets of 0-10 s and 60-70 s, copied without decoding. Tags are not part of
    it, so it stays the same when only tags change (Serato's analysis, cue points). None if ffmpeg failed."""
    cmd = [ffmpeg, "-nostdin", "-v", "error", "-t", "10", "-i", path, "-ss", "60", "-t", "10", "-i", path,
           "-map", "0:a:0", "-map", "1:a:0?", "-c", "copy", "-f", "md5", "-"]
    try:
        out = subprocess.run(_background(cmd) if background else cmd, capture_output=True, text=True, timeout=30).stdout.strip()
    except (OSError, subprocess.TimeoutExpired):
        return None
    return out[4:] if out.startswith("MD5=") else None


def duration(ffmpeg: str, path: str) -> float:
    out = subprocess.run([ffmpeg, "-nostdin", "-hide_banner", "-i", path], capture_output=True, text=True, timeout=30).stderr
    m = DURATION_RE.search(out)
    return int(m.group(1)) * 3600 + int(m.group(2)) * 60 + float(m.group(3)) if m else 0.0


def band_levels(ffmpeg: str, path: str) -> list[float] | None:
    """[reference level, then 32 band levels] in dB, or [] when the file cannot be decoded."""
    try:
        length = duration(ffmpeg, path)
        starts = [length * f for f in (0.3, 0.5, 0.7)] if length > 40 else [0.0]
        cmd = [ffmpeg, "-nostdin", "-hide_banner", "-loglevel", "info"]
        for s in starts:
            cmd += ["-ss", f"{s:.2f}", "-t", "10", "-i", path]
        n = len(BANDS)
        graph = "".join(f"[{i}:a:0]" for i in range(len(starts)))
        graph += f"concat=n={len(starts)}:v=0:a=1,aformat=sample_rates=44100:channel_layouts=mono,asplit={n}"
        graph += "".join(f"[b{i}]" for i in range(n)) + ";"
        graph += ";".join(f"[b{i}]firequalizer=gain='if(between(f,{lo},{hi}),0,-150)':delay=0.02,astats=measure_perchannel=none:measure_overall=RMS_level[o{i}]" for i, (lo, hi) in enumerate(BANDS))
        graph += ";" + "".join(f"[o{i}]" for i in range(n)) + f"amix=inputs={n}"
        err = subprocess.run(_background(cmd + ["-filter_complex", graph, "-f", "null", "-"]), capture_output=True, text=True, timeout=180).stderr
    except (OSError, subprocess.TimeoutExpired):
        return None  # ffmpeg did not run: retry next time
    found = sorted((int(i), -150.0 if v == "-inf" else float(v)) for i, v in LEVEL_RE.findall(err))
    return [round(v, 1) for _, v in found] if len(found) == n else []


def verdict(levels: list[float]) -> list | None:
    """[cutoff kHz or None, kind] with kind 'full' | 'wall' | 'slope' | 'quiet'; None without data."""
    if not levels or len(levels) != len(BANDS):
        return None
    ref, rel = levels[0], [v - levels[0] for v in levels[1:]]
    if ref < -70:
        return [None, "quiet"]
    has = [i for i, v in enumerate(rel) if v >= CONTENT_DB]
    if not has:
        return [14.0, "wall"]  # nothing at all above 14 kHz
    c = max(has)
    if c >= len(rel) - 2:
        return [None, "full"]  # content up to ~21.5 kHz
    below = sorted(rel[max(c - 2, 0) : c + 1])[len(rel[max(c - 2, 0) : c + 1]) // 2]
    above = sorted(rel[c + 1 : c + 4])[len(rel[c + 1 : c + 4]) // 2]
    cutoff = (BANDS[c + 1][1]) / 1000  # top of the last band with content
    return [round(cutoff, 2), "wall" if below - above >= WALL_DB else "slope"]


def floor_matters(levels: list[float]) -> bool:
    """True when a version-1 verdict could change with a meter that reads below the 16-bit floor."""
    if not levels:
        return False  # could not be decoded either way
    deeper = [-150.0 if v <= S16_FLOOR_DB else v for v in levels]
    return verdict(deeper) != verdict(levels)


SPEEDS = {"saver": 1, "normal": 3, "fast": 6}  # files analysed at the same time


class SpectrumProber(AudioInfoProber):
    version = 2  # 1: 16-bit volumedetect; 2: floating-point astats
    workers = SPEEDS["normal"]

    def _load(self, stored: dict) -> dict:
        prints, last = stored.get("prints"), stored.get("lastRun")
        self._stored = {"prints": prints if isinstance(prints, dict) else {}, "lastRun": last if isinstance(last, (int, float)) else None}
        if stored.get("version") == 1:
            return {p: v for p, v in stored["files"].items() if not floor_matters(v[2:])}
        return super()._load(stored)

    def __init__(self, cache_path: Path):
        super().__init__(cache_path)
        stored = getattr(self, "_stored", {})
        self.prints: dict[str, str] = stored.get("prints") or {}  # path -> audio fingerprint of the checked content
        self.last_run: float | None = stored.get("lastRun")
        self.compared: dict[tuple[str, int, int], bool] = {}  # (path, size, mtime) -> fingerprint still the same
        self.backfill_started = False
        self.ffmpeg = find_ffmpeg()
        self.probe = self._probe

    def _probe(self, path: str) -> list[float] | None:
        levels = band_levels(self.ffmpeg, path)
        if levels:  # remember what the audio was, so a tag-only change later keeps this result
            fp = fingerprint(self.ffmpeg, path)
            if fp:
                with self.lock:
                    self.prints[path] = fp
        return levels

    def _extra(self) -> dict:
        return {"prints": self.prints, "lastRun": self.last_run}

    def _run(self, todo: list[tuple[str, int, int]]) -> None:
        super()._run(todo)
        self.last_run = time.time()
        self._save()

    def _same_content(self, changed: list[tuple[str, int, int]]) -> set[str]:
        """Changed files whose audio fingerprint is still the one their result was made from."""
        if not self.ffmpeg:
            return set()
        ask = [t for t in changed if self.prints.get(t[0]) and t not in self.compared]
        if ask:
            with ThreadPoolExecutor(max_workers=4) as pool:
                now = list(pool.map(lambda t: fingerprint(self.ffmpeg, t[0]), ask))
            for t, fp in zip(ask, now):
                if fp is not None:  # ffmpeg failed: ask again next time
                    self.compared[t] = fp == self.prints.get(t[0])
        return {t[0] for t in changed if self.compared.get(t)}

    def coverage(self, paths: list[str]) -> dict:
        self._start_backfill(paths)
        return super().coverage(paths)

    def _start_backfill(self, paths: list[str]) -> None:
        """Once per app run: fingerprints for results made before fingerprints existed (one file at a time, background priority)."""
        if self.backfill_started or not self.ffmpeg:
            return
        self.backfill_started = True
        with self.lock:
            todo = [(p, h[0], h[1]) for p in paths if (h := self.cache.get(p)) and len(h) > 2 and p not in self.prints]
        if todo:
            threading.Thread(target=self._backfill, args=(todo,), daemon=True).start()

    def _backfill(self, todo: list[tuple[str, int, int]]) -> None:
        def unchanged(path: str, size: int, mtime: int) -> bool:
            try:
                st = os.stat(path)
            except OSError:
                return False
            return (st.st_size, int(st.st_mtime)) == (size, mtime)

        added = 0
        for path, size, mtime in todo:
            # Only while the file is still exactly what was checked; otherwise the fingerprint would vouch for other audio.
            if not unchanged(path, size, mtime):
                continue
            fp = fingerprint(self.ffmpeg, path, background=True)
            if fp and unchanged(path, size, mtime):
                with self.lock:
                    self.prints.setdefault(path, fp)
                added += 1
                if added % 500 == 0:
                    self._save()
        if added:
            self._save()

    def start(self, paths: list[str], speed: str = "normal") -> None:
        if self.ffmpeg and not self.running:
            self.workers = SPEEDS.get(speed, SPEEDS["normal"])
            super().start(paths)

    def status(self) -> dict:
        last = self.last_run
        if last is None:  # caches from before lastRun was stored: the file was written at the end of every run
            try:
                last = os.path.getmtime(self.cache_path)
            except OSError:
                last = None
        return {**super().status(), "available": bool(self.ffmpeg), "lastRun": last}

    def items(self) -> dict[str, list]:
        """path -> [cutoff kHz or None, kind] for analysed files."""
        out = {}
        for path, levels in super().items().items():
            v = verdict(levels)
            if v:
                out[path] = v
        return out

    def spectrogram(self, path: str) -> bytes:
        """PNG picture of a minute of the song (from 30 %), for checking by eye."""
        if not self.ffmpeg:
            raise ValueError("ffmpeg is not installed")
        start = duration(self.ffmpeg, path) * 0.3
        cmd = [self.ffmpeg, "-nostdin", "-v", "error", "-ss", f"{start:.2f}", "-t", "60", "-i", path,
               "-lavfi", "showspectrumpic=s=1000x420:legend=1:color=intensity:scale=log:fscale=lin:stop=22050",
               "-frames:v", "1", "-f", "image2pipe", "-vcodec", "png", "-"]
        out = subprocess.run(cmd, capture_output=True, timeout=60).stdout
        if not out:
            raise ValueError("could not draw the spectrum")
        return out
