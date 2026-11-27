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
ffmpeg runs at background priority (efficiency cores), 1, 3 or 6 files at a time depending on the
chosen speed. Without ffmpeg (Homebrew's `brew install ffmpeg`) the feature is simply off.
"""

from __future__ import annotations

import os
import re
import shutil
import subprocess
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
        if stored.get("version") == 1:
            return {p: v for p, v in stored["files"].items() if not floor_matters(v[2:])}
        return super()._load(stored)

    def __init__(self, cache_path: Path):
        super().__init__(cache_path)
        self.ffmpeg = find_ffmpeg()
        self.probe = lambda path: band_levels(self.ffmpeg, path)

    def start(self, paths: list[str], speed: str = "normal") -> None:
        if self.ffmpeg and not self.running:
            self.workers = SPEEDS.get(speed, SPEEDS["normal"])
            super().start(paths)

    def status(self) -> dict:
        try:
            last = os.path.getmtime(self.cache_path)  # written at the end of every run
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
