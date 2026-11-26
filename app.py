#!/usr/bin/env python3
"""Backstage — organise your Serato DJ library: folders, crates, screening and applying changes.

    uv run --no-project app.py            # opens http://127.0.0.1:8765
    uv run --no-project app.py --port 9000 --no-browser

The Mac app (src-tauri/) starts this same server in the background and shares
its data folder (~/Library/Application Support/Backstage).
"""

import argparse
import os
import shutil
import threading
import time
import webbrowser
from pathlib import Path

from serato_crates.server import serve

DEFAULT_DATA_DIR = Path.home() / "Library/Application Support/Backstage"
OLD_DATA_DIR = Path.home() / "Library/Application Support/Crate Desk"  # name before 2026-11-26
LEGACY_DATA_DIR = Path(__file__).resolve().parent / "data"


def migrate_legacy_data(data_dir: Path) -> None:
    """One-time moves of older data folders into the current one."""
    if data_dir == DEFAULT_DATA_DIR and not data_dir.exists() and OLD_DATA_DIR.is_dir():
        OLD_DATA_DIR.rename(data_dir)  # the app used to be called "Crate Desk"
        return
    # Very first version kept the plan and caches in ./data next to app.py.
    if data_dir == LEGACY_DATA_DIR or not LEGACY_DATA_DIR.is_dir() or (data_dir / "plan.json").exists():
        return
    data_dir.mkdir(parents=True, exist_ok=True)
    for name in ("plan.json", "audio_info.json"):
        src = LEGACY_DATA_DIR / name
        if src.exists():
            shutil.copy2(src, data_dir / name)


def exit_with_parent() -> None:
    """Stop when the process that started us (the Mac app) goes away, so no server is left behind."""
    parent = os.getppid()

    def watch():
        while True:
            time.sleep(1)
            if os.getppid() != parent:
                os._exit(0)

    threading.Thread(target=watch, daemon=True).start()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--data-dir", type=Path, default=DEFAULT_DATA_DIR)
    parser.add_argument("--no-browser", action="store_true")
    parser.add_argument("--exit-with-parent", action="store_true", help=argparse.SUPPRESS)
    args = parser.parse_args()

    migrate_legacy_data(args.data_dir)
    args.data_dir.mkdir(parents=True, exist_ok=True)
    if args.exit_with_parent:
        exit_with_parent()

    httpd = serve(args.data_dir, args.port)
    url = f"http://127.0.0.1:{args.port}/"
    print(f"Backstage running at {url}  (Serato is only written when you press 套用到 Serato)", flush=True)
    if not args.no_browser:
        threading.Timer(0.5, lambda: webbrowser.open(url)).start()
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nbye")


if __name__ == "__main__":
    main()
