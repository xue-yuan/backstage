"""Apply the staged plan to Serato DJ 4's library (only while Serato is closed).

How Serato 4 stores the local drive's library
---------------------------------------------
- root.sqlite is the drive's own database. master.sqlite mirrors it as location_id = 1, and
  Serato opens master with root ATTACHed as "db1" (root's triggers are written against db1.*).
  We do the same, so both files change in one transaction and roll back together.
- Crates: master.container <-> location_container(location 1).external_container_id <-> db1.container.
  Container ids differ between the two files.
- Songs: master.asset.external_id = db1.asset.id. Crate membership is container_asset in both:
  master rows point at the location_container and carry external_container_asset_id = the
  db1.container_asset id. Each file keeps its own list_order numbering.
- db1 rows carry a revision. We stamp touched rows with the current db1.serato.revision and
  leave that counter (and master.location.revision) alone: both sides are already identical,
  so Serato has nothing to re-sync.
- Master triggers write UI notification rows (updated_container, moved_container, …). They are
  empty while Serato is closed, so we clear what our changes added.

- Removing a song (removeTrack) is what Serato itself does on Cmd+Delete, verified by diffing the
  files before and after: delete the song's space_asset rows in both files and let the triggers
  delete the asset. Foreign keys then drop its crate memberships and set history_entry.asset_id
  to NULL (each history row keeps its own copy of title, artist and path, so play history stays).
  Serato also drops the song from its cached list tables (anonymous_table_*); their maintenance
  triggers only exist while Serato runs, so we delete those rows ourselves. The file on disk is
  not touched here; the server moves it to the Trash after a successful commit when asked to.

Supported plan ops: createCrate, renameCrate, moveCrate, deleteCrate, mergeCrate, add, remove,
relocate, removeTrack.

Before committing we run integrity and foreign-key checks, check that master and root mirror
each other, and check that every crate's contents equal what the app expected. If anything
fails, nothing is written.
"""

from __future__ import annotations

import os
import shutil
import sqlite3
import subprocess
import time
from datetime import datetime
from pathlib import Path

LIBRARY = "Serato Library"
LOCAL = 1  # location id of the local drive (root.sqlite)
# PRAGMA user_version of master.sqlite and root.sqlite that this writer has been verified against.
# 202 = Serato DJ Pro 4.0.x. A newer Serato migrates the files on launch; we refuse to write until
# the new schema has been checked, because the triggers and tables we rely on may have changed.
KNOWN_SCHEMAS = {202}
SUPPORTED = {"createCrate", "renameCrate", "moveCrate", "deleteCrate", "mergeCrate", "add", "remove", "relocate", "removeTrack"}
NOTIFY_TABLES = (
    "updated_container",
    "moved_container",
    "updated_container_tree",
    "updated_location",
    "removed_asset",
    "reordered_container_asset",
    "spaces_with_new_assets",
    "updated_container_asset_list_columns",
)


class ApplyError(RuntimeError):
    pass


# ---------- safety checks ----------
def serato_processes() -> list[str]:
    """Running Serato DJ apps ("pid name"), matched on the executable name only (not on arguments).

    If the check itself fails, returns a placeholder so the caller treats Serato as running.
    """
    try:
        r = subprocess.run(["/bin/ps", "-axo", "pid=,comm="], capture_output=True, text=True, timeout=5)
    except (OSError, subprocess.TimeoutExpired) as e:
        return [f"(無法確認：{e})"]
    if r.returncode != 0:
        return [f"(無法確認：ps {r.returncode})"]
    found = []
    for line in r.stdout.splitlines():
        pid, _, comm = line.strip().partition(" ")
        name = os.path.basename(comm.strip())
        if name.startswith("Serato DJ"):
            found.append(f"{pid} {name}")
    return found


def serato_running() -> bool:
    return bool(serato_processes())


def files_in_use(lib_dir: Path) -> list[str]:
    paths = [str(lib_dir / n) for n in ("master.sqlite", "root.sqlite")]
    try:
        out = subprocess.run(["/usr/sbin/lsof", "-n", "-P", "-Fn", *paths], capture_output=True, text=True, timeout=10).stdout
    except (OSError, subprocess.TimeoutExpired):
        return paths
    return sorted({line[1:] for line in out.splitlines() if line.startswith("n")})


def backup(lib_dir: Path, backups_root: Path, label: str) -> Path:
    stamp = datetime.now().strftime("%Y-%m-%d %H%M%S")
    dest = backups_root / f"{stamp} {label}"
    dest.mkdir(parents=True, exist_ok=False)
    for name in ("master.sqlite", "master.sqlite-wal", "master.sqlite-shm", "root.sqlite", "root.sqlite-journal", "root.sqlite-wal"):
        src = lib_dir / name
        if src.exists():
            shutil.copy2(src, dest / name)
            if not _same(src, dest / name):
                raise ApplyError(f"備份 {name} 失敗（內容不一致）")
    (dest / "還原方法.txt").write_text(
        "這是 Backstage 套用變更到 Serato 之前的資料庫備份。\n"
        "還原：先關掉 Serato DJ，在 Backstage 的「變更計畫」按「還原上次套用前的備份」，\n"
        f"或手動把這裡的檔案複製回 {lib_dir}（並刪掉那裡多出來的 -wal / -shm 檔）。\n",
        encoding="utf-8",
    )
    return dest


def _same(a: Path, b: Path) -> bool:
    if a.stat().st_size != b.stat().st_size:
        return False
    with open(a, "rb") as fa, open(b, "rb") as fb:
        while True:
            x, y = fa.read(1 << 20), fb.read(1 << 20)
            if x != y:
                return False
            if not x:
                return True


def restore(lib_dir: Path, backup_dir: Path) -> None:
    if serato_running():
        raise ApplyError("Serato DJ 還開著，請先關掉再還原")
    if not (backup_dir / "master.sqlite").exists() or not (backup_dir / "root.sqlite").exists():
        raise ApplyError("備份資料夾裡沒有 master.sqlite / root.sqlite")
    for name in ("master.sqlite-wal", "master.sqlite-shm", "root.sqlite-journal", "root.sqlite-wal"):
        (lib_dir / name).unlink(missing_ok=True)
    for name in ("master.sqlite", "master.sqlite-wal", "master.sqlite-shm", "root.sqlite"):
        src = backup_dir / name
        if src.exists():
            tmp = lib_dir / f".{name}.restore"
            shutil.copy2(src, tmp)
            os.replace(tmp, lib_dir / name)


# ---------- the writer ----------
class _Writer:
    def __init__(self, con: sqlite3.Connection):
        self.con = con
        q = con.execute
        self.mspace = q("SELECT id FROM main.space WHERE name = ?", (LIBRARY,)).fetchone()[0]
        self.rspace = q("SELECT id FROM db1.space WHERE name = ?", (LIBRARY,)).fetchone()[0]
        self.mroot = q("SELECT id FROM main.container WHERE space_id = ? AND type = 0", (self.mspace,)).fetchone()[0]
        self.rroot = self._root_of(self.mroot)
        self.rev = q("SELECT revision FROM db1.serato").fetchone()[0]
        self.now = int(time.time())
        self.new_ids: dict[str, int] = {}  # plan's "new-…" ids -> master container ids
        self.removed: list[dict] = []  # songs removed by removeTrack: {asset, path, deleteFile}
        # Serato's cached asset lists ("All...", search results): anonymous_table_N with an asset_id column.
        self.list_caches = [
            t
            for (t,) in q("SELECT name FROM main.sqlite_master WHERE type = 'table' AND name LIKE 'anonymous\\_table\\_%' ESCAPE '\\'")
            if any(c[1] == "asset_id" for c in q(f"PRAGMA main.table_info('{t}')"))
        ]

    # -- lookups --
    def _one(self, sql: str, args=()) -> object:
        row = self.con.execute(sql, args).fetchone()
        return row[0] if row else None

    def _root_of(self, mid: int) -> int:
        rid = self._one("SELECT external_container_id FROM main.location_container WHERE container_id = ? AND location_id = ?", (mid, LOCAL))
        if rid is None:
            raise ApplyError(f"crate #{mid} 在 root.sqlite 裡找不到對應")
        return rid

    def _lc(self, mid: int) -> int:
        return self._one("SELECT id FROM main.location_container WHERE container_id = ? AND location_id = ?", (mid, LOCAL))

    def crate(self, ref, *, allow_root: bool = False) -> int:
        mid = self.new_ids.get(ref) if isinstance(ref, str) else ref
        if mid is None:
            raise ApplyError(f"找不到 crate {ref}")
        row = self.con.execute("SELECT space_id, type FROM main.container WHERE id = ?", (mid,)).fetchone()
        if not row or row[0] != self.mspace or (row[1] != 1 and not (allow_root and mid == self.mroot)):
            raise ApplyError(f"crate #{mid} 已經不存在，或不是 Serato Library 的 crate")
        return mid

    def asset(self, aid: int) -> tuple[int, int, int]:
        """(root asset id, master space_asset id, root space_asset id) for a library song."""
        rasset = self._one("SELECT external_id FROM main.asset WHERE id = ? AND location_id = ?", (aid, LOCAL))
        msa = self._one("SELECT id FROM main.space_asset WHERE asset_id = ? AND space_id = ?", (aid, self.mspace))
        rsa = self._one("SELECT id FROM db1.space_asset WHERE asset_id = ? AND space_id = ?", (rasset, self.rspace)) if rasset is not None else None
        if rasset is None or msa is None or rsa is None:
            raise ApplyError(f"歌曲 #{aid} 不在本機的 Serato Library 裡")
        return rasset, msa, rsa

    def _name_taken(self, mparent: int, name: str, except_mid: int | None = None) -> bool:
        return (
            self._one(
                "SELECT COUNT(*) FROM main.container WHERE parent_id = ? AND type = 1 AND name = ? COLLATE NOCASE AND id IS NOT ?",
                (mparent, name, except_mid),
            )
            > 0
        )

    def _next_order(self, schema: str, parent: int) -> int:
        return (self._one(f"SELECT MAX(list_order) FROM {schema}.container WHERE parent_id = ?", (parent,)) or 0) + 1

    def _subtree(self, mid: int) -> list[int]:
        out, todo = [], [mid]
        while todo:
            cur = todo.pop()
            out.append(cur)
            todo.extend(r[0] for r in self.con.execute("SELECT id FROM main.container WHERE parent_id = ?", (cur,)))
        return out

    def _members(self, mid: int) -> list[int]:
        return [r[0] for r in self.con.execute("SELECT asset_id FROM main.container_asset WHERE location_container_id = ? ORDER BY list_order", (self._lc(mid),))]

    # -- operations --
    def create(self, op: dict) -> None:
        mparent = self.crate(op["parent"], allow_root=True)
        name = str(op["name"]).strip()
        if not name:
            raise ApplyError("crate 名稱是空的")
        if self._name_taken(mparent, name):
            raise ApplyError(f"「{name}」那一層已經有同名的 crate")
        rparent = self._root_of(mparent)
        cur = self.con.execute(
            "INSERT INTO db1.container (revision, parent_id, name, type, list_order, space_id, time_added, expanded, portable_id, color) "
            "VALUES (?, ?, ?, 1, ?, ?, ?, 0, '', 0)",
            (self.rev, rparent, name, self._next_order("db1", rparent), self.rspace, self.now),
        )
        rid = cur.lastrowid
        cur = self.con.execute(
            "INSERT INTO main.container (parent_id, name, type, list_order, space_id, time_added, expanded, portable_id, color) "
            "VALUES (?, ?, 1, ?, ?, ?, 0, '', 0)",
            (mparent, name, self._next_order("main", mparent), self.mspace, self.now),
        )
        mid = cur.lastrowid
        self.con.execute("INSERT INTO main.location_container (container_id, location_id, external_container_id) VALUES (?, ?, ?)", (mid, LOCAL, rid))
        self.new_ids[str(op["id"])] = mid

    def rename(self, op: dict) -> None:
        mid = self.crate(op["crate"])
        name = str(op["name"]).strip()
        mparent = self._one("SELECT parent_id FROM main.container WHERE id = ?", (mid,))
        if self._name_taken(mparent, name, mid):
            raise ApplyError(f"同一層已經有「{name}」")
        self.con.execute("UPDATE main.container SET name = ? WHERE id = ?", (name, mid))
        self.con.execute("UPDATE db1.container SET name = ?, revision = ? WHERE id = ?", (name, self.rev, self._root_of(mid)))

    def move(self, op: dict) -> None:
        mid = self.crate(op["crate"])
        mparent = self.crate(op["parent"], allow_root=True)
        if mparent in self._subtree(mid):
            raise ApplyError("不能把 crate 移到自己底下")
        name = self._one("SELECT name FROM main.container WHERE id = ?", (mid,))
        if self._name_taken(mparent, name, mid):
            raise ApplyError(f"目標裡已經有「{name}」")
        rid, rparent = self._root_of(mid), self._root_of(mparent)
        self.con.execute("UPDATE db1.container SET parent_id = ?, list_order = ?, revision = ? WHERE id = ?", (rparent, self._next_order("db1", rparent), self.rev, rid))
        self.con.execute("UPDATE main.container SET parent_id = ?, list_order = ? WHERE id = ?", (mparent, self._next_order("main", mparent), mid))

    def delete(self, op: dict) -> None:
        mid = self.crate(op["crate"])
        mids = self._subtree(mid)
        rids = [self._root_of(x) for x in mids]
        # Foreign keys cascade to location_container, container_asset, keep-alive and metadata rows.
        self.con.execute(f"DELETE FROM db1.container WHERE id IN ({','.join('?' * len(rids))})", rids)
        self.con.execute(f"DELETE FROM main.container WHERE id IN ({','.join('?' * len(mids))})", mids)

    def merge(self, op: dict) -> None:
        self._merge(self.crate(op["from"]), self.crate(op["into"]))

    def _merge(self, src: int, dst: int) -> None:
        have = set(self._members(dst))
        for aid in self._members(src):
            if aid not in have:
                self._add(dst, aid)
                have.add(aid)
        for (child, name) in self.con.execute("SELECT id, name FROM main.container WHERE parent_id = ? AND type = 1", (src,)).fetchall():
            clash = self._one("SELECT id FROM main.container WHERE parent_id = ? AND type = 1 AND name = ? COLLATE NOCASE", (dst, name))
            if clash is not None:
                self._merge(child, clash)
            else:
                self.move({"crate": child, "parent": dst})
        self.delete({"crate": src})

    def add(self, op: dict) -> None:
        self._add(self.crate(op["crate"]), int(op["asset"]))

    def _add(self, mid: int, aid: int) -> None:
        rasset, msa, rsa = self.asset(aid)
        rid, lc = self._root_of(mid), self._lc(mid)
        if self._one("SELECT id FROM db1.container_asset WHERE container_id = ? AND space_asset_id = ?", (rid, rsa)) is not None:
            return  # already in the crate
        r_order = (self._one("SELECT MAX(list_order) FROM db1.container_asset WHERE container_id = ?", (rid,)) or 0) + 1
        rca = self.con.execute(
            "INSERT INTO db1.container_asset (revision, container_id, space_asset_id, list_order, time_added) VALUES (?, ?, ?, ?, ?)",
            (self.rev, rid, rsa, r_order, self.now),
        ).lastrowid
        m_order = (self._one("SELECT MAX(list_order) FROM main.container_asset WHERE location_container_id = ?", (lc,)) or 0) + 1
        self.con.execute(
            "INSERT INTO main.container_asset (asset_id, location_container_id, space_asset_id, external_container_asset_id, list_order, time_added) "
            "VALUES (?, ?, ?, ?, ?, ?)",
            (aid, lc, msa, rca, m_order, self.now),
        )

    def remove(self, op: dict) -> None:
        mid, aid = self.crate(op["crate"]), int(op["asset"])
        _, msa, rsa = self.asset(aid)
        self.con.execute("DELETE FROM db1.container_asset WHERE container_id = ? AND space_asset_id = ?", (self._root_of(mid), rsa))
        self.con.execute("DELETE FROM main.container_asset WHERE location_container_id = ? AND space_asset_id = ?", (self._lc(mid), msa))

    def relocate(self, op: dict) -> None:
        aid, path = int(op["asset"]), str(op["path"])
        if not path.startswith("/") or path.startswith("/Volumes/"):
            raise ApplyError(f"只能改到本機硬碟上的位置：{path}")
        if not os.path.isfile(path):
            raise ApplyError(f"新的位置沒有檔案：{path}")
        rasset, _, _ = self.asset(aid)
        pid = path[1:]
        if self._one("SELECT id FROM db1.asset WHERE portable_id = ? COLLATE NOCASE AND id <> ?", (pid, rasset)) is not None:
            raise ApplyError(f"Serato 裡已經有另一筆記錄指向 {path}")
        self.con.execute("UPDATE main.asset SET portable_id = ? WHERE id = ? AND location_id = ?", (pid, aid, LOCAL))
        self.con.execute("UPDATE db1.asset SET portable_id = ?, revision = ? WHERE id = ?", (pid, self.rev, rasset))

    def remove_track(self, op: dict) -> None:
        aid = int(op["asset"])
        rasset, _, _ = self.asset(aid)  # must be a song of the local Serato Library
        pid = self._one("SELECT portable_id FROM main.asset WHERE id = ?", (aid,))
        # Every space the song is in (a few are also in Prepare), so the triggers delete the asset itself.
        self.con.execute("DELETE FROM db1.space_asset WHERE asset_id = ?", (rasset,))
        self.con.execute("DELETE FROM main.space_asset WHERE asset_id = ?", (aid,))
        for t in self.list_caches:
            self.con.execute(f"DELETE FROM main.'{t}' WHERE asset_id = ?", (aid,))
        if self._one("SELECT COUNT(*) FROM main.asset WHERE id = ?", (aid,)) or self._one("SELECT COUNT(*) FROM db1.asset WHERE id = ?", (rasset,)):
            raise ApplyError(f"歌曲 #{aid} 沒有被完整移除")
        self.removed.append({"asset": aid, "path": "/" + pid, "deleteFile": bool(op.get("deleteFile"))})

    def run(self, op: dict) -> None:
        kind = op.get("type")
        if kind not in SUPPORTED:
            raise ApplyError(f"還不支援套用「{kind}」")
        {
            "createCrate": self.create,
            "renameCrate": self.rename,
            "moveCrate": self.move,
            "deleteCrate": self.delete,
            "mergeCrate": self.merge,
            "add": self.add,
            "remove": self.remove,
            "relocate": self.relocate,
            "removeTrack": self.remove_track,
        }[kind](op)

    # -- verification --
    def actual_tree(self) -> dict[str, list[int]]:
        """Crate path -> sorted song ids, read from master exactly like the app reads it."""
        rows = self.con.execute(
            "SELECT id, parent_id, name FROM main.container WHERE space_id = ? AND type = 1 AND id NOT IN (SELECT container_id FROM main.smart_crate_rules)",
            (self.mspace,),
        ).fetchall()
        by_id = {r[0]: r for r in rows}

        def path(i: int) -> str:  # joined with U+0000 so a "/" inside a crate name cannot collide
            _, parent, name = by_id[i]
            return f"{path(parent)}\x00{name}" if parent in by_id else name

        out = {path(i): [] for i in by_id}
        for cid, aid in self.con.execute(
            "SELECT lc.container_id, ca.asset_id FROM main.container_asset ca JOIN main.location_container lc ON lc.id = ca.location_container_id"
        ):
            if cid in by_id:
                out[path(cid)].append(aid)
        return {k: sorted(set(v)) for k, v in out.items()}

    def mirror_problems(self) -> list[str]:
        """Master's view of the local drive must equal root.sqlite's."""
        problems = []
        rows = self.con.execute(
            "SELECT c.id, c.parent_id, c.name, lc.id, lc.external_container_id FROM main.container c "
            "LEFT JOIN main.location_container lc ON lc.container_id = c.id AND lc.location_id = ? "
            "WHERE c.space_id = ? AND c.type = 1",
            (LOCAL, self.mspace),
        ).fetchall()
        mapped = set()
        for mid, mparent, name, lc, rid in rows:
            if rid is None:
                continue  # crates that only hold songs from other drives
            mapped.add(rid)
            r = self.con.execute("SELECT parent_id, name, type, space_id FROM db1.container WHERE id = ?", (rid,)).fetchone()
            if not r:
                problems.append(f"master crate {mid} → root {rid} 不存在")
                continue
            if r[1] != name or r[2] != 1 or r[3] != self.rspace:
                problems.append(f"crate {name}: 名稱或類型不一致")
            if mparent != self.mroot or r[0] != self.rroot:
                if self._one("SELECT external_container_id FROM main.location_container WHERE container_id = ? AND location_id = ?", (mparent, LOCAL)) != r[0]:
                    problems.append(f"crate {name}: 上層不一致")
            m_set = {x[0] for x in self.con.execute("SELECT a.external_id FROM main.container_asset ca JOIN main.asset a ON a.id = ca.asset_id WHERE ca.location_container_id = ?", (lc,))}
            r_set = {x[0] for x in self.con.execute("SELECT sa.asset_id FROM db1.container_asset ca JOIN db1.space_asset sa ON sa.id = ca.space_asset_id WHERE ca.container_id = ?", (rid,))}
            if m_set != r_set:
                problems.append(f"crate {name}: master {len(m_set)} 首、root {len(r_set)} 首")
            dangling = self._one(
                "SELECT COUNT(*) FROM main.container_asset ca WHERE ca.location_container_id = ? AND ca.external_container_asset_id NOT IN (SELECT id FROM db1.container_asset WHERE container_id = ?)",
                (lc, rid),
            )
            if dangling:
                problems.append(f"crate {name}: {dangling} 筆對不到 root")
        orphans = self._one(
            f"SELECT COUNT(*) FROM db1.container WHERE space_id = ? AND type = 1 AND id NOT IN ({','.join('?' * len(mapped)) or 'NULL'})",
            (self.rspace, *mapped),
        )
        if orphans:
            problems.append(f"root 裡有 {orphans} 個 crate 在 master 裡沒有對應")
        m_assets = {r[0] for r in self.con.execute("SELECT external_id FROM main.asset WHERE location_id = ?", (LOCAL,))}
        r_assets = {r[0] for r in self.con.execute("SELECT id FROM db1.asset")}
        if m_assets != r_assets:
            problems.append(f"歌曲清單不一致：只在 master {len(m_assets - r_assets)} 首、只在 root {len(r_assets - m_assets)} 首")
        return problems[:20]


def apply_changes(lib_dir: Path, changes: list[dict], expected: dict[str, list[int]] | None, *, dry_run: bool = False) -> dict:
    master, root = lib_dir / "master.sqlite", lib_dir / "root.sqlite"
    con = sqlite3.connect(master, isolation_level=None)
    try:
        con.execute("PRAGMA foreign_keys = ON")
        con.execute("ATTACH DATABASE ? AS db1", (str(root),))
        versions = {schema: con.execute(f"PRAGMA {schema}.user_version").fetchone()[0] for schema in ("main", "db1")}
        if not set(versions.values()) <= KNOWN_SCHEMAS:
            raise ApplyError(
                f"Serato 資料庫的版本是 {versions['main']}（root {versions['db1']}），"
                f"Backstage 只驗證過 {', '.join(map(str, sorted(KNOWN_SCHEMAS)))}（Serato DJ Pro 4.0）。"
                "可能是 Serato 更新過了。為了安全，在確認新版的資料庫格式之前不會寫入，什麼都沒有改。"
            )
        con.execute("BEGIN IMMEDIATE")
        w = _Writer(con)
        before = {t: w._one(f"SELECT COUNT(*) FROM main.{t}") for t in NOTIFY_TABLES}
        history_before = w._one("SELECT COUNT(*) FROM main.history_entry")
        applied = 0
        for change in changes:
            for op in change.get("ops", []):
                try:
                    w.run(op)
                except ApplyError as e:
                    raise ApplyError(f"{op.get('text') or op.get('type')}：{e}") from None
                applied += 1
        for t, n in before.items():  # UI notifications Serato would consume while running
            if n == 0:
                con.execute(f"DELETE FROM main.{t}")

        checks = []
        for schema in ("main", "db1"):
            res = con.execute(f"PRAGMA {schema}.integrity_check").fetchone()[0]
            if res != "ok":
                raise ApplyError(f"{schema} integrity_check：{res}")
        fk = con.execute("PRAGMA foreign_key_check").fetchall()
        if fk:
            raise ApplyError(f"外鍵檢查失敗：{fk[:3]}")
        checks.append("資料庫完整性、外鍵檢查通過")
        if w._one("SELECT COUNT(*) FROM main.history_entry") != history_before:
            raise ApplyError("播放紀錄的筆數變了，為了安全不寫入")
        if w.removed:
            checks.append(f"移除 {len(w.removed)} 首歌，播放紀錄 {history_before} 筆全部保留")
        problems = w.mirror_problems()
        if problems:
            raise ApplyError("master / root 不一致：" + "；".join(problems))
        checks.append("master.sqlite 和 root.sqlite 一致")
        if expected is not None:
            actual = w.actual_tree()
            want = {k: sorted(set(v)) for k, v in expected.items()}
            show = lambda keys: [k.replace("\x00", " / ") for k in keys]
            missing = show(sorted(set(want) - set(actual)))
            extra = show(sorted(set(actual) - set(want)))
            wrong = show(sorted(k for k in set(want) & set(actual) if want[k] != actual[k]))
            if missing or extra or wrong:
                raise ApplyError(
                    "套用後的 crate 和預期不同："
                    + "；".join(
                        x
                        for x in (
                            f"少了 {missing[:5]}" if missing else "",
                            f"多了 {extra[:5]}" if extra else "",
                            f"內容不同 {wrong[:5]}" if wrong else "",
                        )
                        if x
                    )
                    + "。通常是 Backstage 讀取快照之後，又在 Serato 裡改過 crate：請按右上角「↻ 重新讀取」，確認變更計畫後再套用。"
                )
            checks.append(f"{len(actual)} 個 crate 的內容和預期完全相同")
        if dry_run:
            con.execute("ROLLBACK")
        else:
            con.execute("COMMIT")
            con.execute("PRAGMA main.wal_checkpoint(TRUNCATE)")  # leave the files as a cleanly closed Serato would
        return {"ok": True, "applied": applied, "checks": checks, "newIds": w.new_ids, "removed": w.removed, "dryRun": dry_run}
    except Exception:
        if con.in_transaction:
            con.execute("ROLLBACK")
        raise
    finally:
        con.close()
