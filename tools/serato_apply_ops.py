"""Apply a list of plan actions to Serato from the command line, with the same safety as "Apply to Serato".

    uv run --no-project tools/serato_apply_ops.py OPS.json            # rehearse on a copy only
    uv run --no-project tools/serato_apply_ops.py OPS.json --apply    # write (Serato closed)

OPS.json is a list of plan ops as apply.py takes them, e.g.
    [{"type": "removeTrack", "asset": 854874, "deleteFile": false, "text": "Remove test song"},
     {"type": "deleteCrate", "crate": 10245, "text": "Delete Crate 2"}]
removeTrack never moves files here: deleteFile is ignored, the files stay where they are.

Without --apply it copies Serato's database (byte copy, safe while Serato is open), applies the ops to
the copy and prints the checks. --apply needs Serato closed and nothing else using the database; it
rehearses on a copy of the closed files, backs up master.sqlite and root.sqlite to ~/Backstage Backups
(the Plan view's "Restore the backup from before the last apply" restores it) and checks integrity,
foreign keys and that master and root match before committing.
"""

from __future__ import annotations

import argparse
import json
import shutil
import sys
import tempfile
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from serato_crates.apply import ApplyError, apply_changes, backup as backup_serato, files_in_use, serato_running  # noqa: E402
from serato_crates.server import BEFORE_APPLY, SERATO_BACKUPS, SERATO_LIBRARY  # noqa: E402
from serato_import_poc import copy_library  # noqa: E402


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("ops", type=Path)
    ap.add_argument("--apply", action="store_true", help="write to Serato (Serato must be closed)")
    args = ap.parse_args()
    ops = json.loads(args.ops.read_text())
    for op in ops:
        op.pop("deleteFile", None)  # this tool never moves music files
    changes = [{"ops": ops}]

    with tempfile.TemporaryDirectory(prefix="backstage-ops-") as tmp:
        try:
            result = apply_changes(copy_library(Path(tmp)), changes, None)
        except ApplyError as e:
            raise SystemExit(f"Rehearsal failed, nothing written: {e}")
    print(f"Rehearsal on a private copy: {len(ops)} actions OK ({'; '.join(result['checks'])})")
    if not args.apply:
        print("Nothing was written. Quit Serato DJ and add --apply to write it.")
        return
    if serato_running():
        raise SystemExit("Serato DJ is still open. Quit it first; nothing was written.")
    busy = files_in_use(SERATO_LIBRARY)
    if busy:
        raise SystemExit(f"Another program is using the Serato database ({', '.join(busy)}); nothing was written.")
    with tempfile.TemporaryDirectory(prefix="backstage-ops-") as tmp:
        lib = Path(tmp)
        for name in ("master.sqlite", "master.sqlite-wal", "master.sqlite-shm", "root.sqlite"):
            if (SERATO_LIBRARY / name).exists():
                shutil.copy2(SERATO_LIBRARY / name, lib / name)
        apply_changes(lib, changes, None)
    dest = backup_serato(SERATO_LIBRARY, SERATO_BACKUPS, BEFORE_APPLY)
    result = apply_changes(SERATO_LIBRARY, changes, None)
    print(f"\nWritten to Serato at {time.strftime('%H:%M:%S')}: {'; '.join(result['checks'])}")
    print(f"Backup of the databases: {dest}")


if __name__ == "__main__":
    main()
