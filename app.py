#!/usr/bin/env python3
"""Cratify — organise your Serato DJ library: folders, crates, screening and applying changes.

    uv run --no-project app.py            # opens http://127.0.0.1:8765
    uv run --no-project app.py --port 9000 --no-browser

The Mac app (src-tauri/) starts this same server in the background and shares
its data folder (~/Library/Application Support/Cratify).
"""

import argparse
import os
import threading
import time
import webbrowser
from pathlib import Path

from serato_crates.server import BACKUPS_DIR, SERATO_BACKUPS, serve

DEFAULT_DATA_DIR = Path.home() / "Library/Application Support/Cratify"
# Until 2026-11-28 the app was called Backstage. Its folders are moved over once (renamed, not copied).
OLD_DATA_DIR = Path.home() / "Library/Application Support/Backstage"
OLD_BACKUPS_DIR = Path.home() / "Backstage Backups"
OLD_SERATO_BACKUPS = "Serato 資料庫"


def migrate_from_backstage(data_dir: Path) -> None:
    """Move the old app's folders to the new names once. Only for the real data folder, never a test one."""
    if data_dir != DEFAULT_DATA_DIR:
        return
    if not data_dir.exists() and OLD_DATA_DIR.is_dir():
        OLD_DATA_DIR.rename(data_dir)  # the Mac app (main.rs) usually did this already
    if not BACKUPS_DIR.exists() and OLD_BACKUPS_DIR.is_dir():
        OLD_BACKUPS_DIR.rename(BACKUPS_DIR)
        old_serato = BACKUPS_DIR / OLD_SERATO_BACKUPS
        if old_serato.is_dir() and not SERATO_BACKUPS.exists():
            old_serato.rename(SERATO_BACKUPS)


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

    migrate_from_backstage(args.data_dir)
    args.data_dir.mkdir(parents=True, exist_ok=True)
    if args.exit_with_parent:
        exit_with_parent()

    httpd = serve(args.data_dir, args.port)
    url = f"http://127.0.0.1:{args.port}/"
    print(f"Cratify running at {url}  (Serato is only written when you press Apply to Serato)", flush=True)
    if not args.no_browser:
        threading.Timer(0.5, lambda: webbrowser.open(url)).start()
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nbye")


if __name__ == "__main__":
    main()
