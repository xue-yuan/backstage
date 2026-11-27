"""What Serato's own import stores about a music file, read the way Serato reads it (read-only).

macOS `afinfo` gives the same bit rate and length Serato stores (checked against songs Serato imported:
bit rate 267328 = 267328, 284.105986 s -> length_ms 284105, truncated). The title tag comes from
ffprobe when ffmpeg is installed, else the file name is used; Serato reads the other tags itself
when it analyses the song.
"""

from __future__ import annotations

import os
import re
import subprocess
from pathlib import Path

from .i18n import tr


def file_details(path: str) -> dict:
    """{fileSize, mtime, bitRate, sampleRate, lengthMs, name} for importTrack. Raises ValueError if macOS cannot read it."""
    try:
        out = subprocess.run(["afinfo", path], capture_output=True, text=True, timeout=15).stdout
    except (OSError, subprocess.TimeoutExpired):
        out = ""
    rate = re.search(r"bit rate: (\d+) bits per second", out)
    sample = re.search(r"Data format:\s+\d+ ch,\s+([\d.]+) Hz", out)
    length = re.search(r"estimated duration: ([\d.]+) sec", out)
    if not sample or not length:
        raise ValueError(tr("macOS cannot read this file as audio: {path}", path=path))
    st = os.stat(path)
    return {
        "fileSize": st.st_size,
        "mtime": int(st.st_mtime),
        "bitRate": int(rate.group(1)) if rate else None,
        "sampleRate": float(sample.group(1)),
        "lengthMs": int(float(length.group(1)) * 1000),
        "name": title_tag(path) or Path(path).stem,
    }


def title_tag(path: str) -> str:
    from .spectrum import find_ffmpeg  # spectrum imports audioinfo; keep this module light

    ffmpeg = find_ffmpeg()
    probe = Path(ffmpeg).with_name("ffprobe") if ffmpeg else None
    if not probe or not probe.exists():
        return ""
    try:
        out = subprocess.run([str(probe), "-v", "error", "-show_entries", "format_tags=title", "-of", "default=nw=1:nk=1", path], capture_output=True, text=True, timeout=15).stdout
    except (OSError, subprocess.TimeoutExpired):
        return ""
    return out.strip().splitlines()[0].strip() if out.strip() else ""
