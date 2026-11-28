"""The shared plan cases (cases/plan_cases.json) applied by Apply to Serato to a fresh library."""

from __future__ import annotations

import json
import shutil
import sqlite3
import tempfile
import unittest
from pathlib import Path

from serato_crates.apply import ApplyError, _Writer, apply_changes, serato_key_type, serato_str_norm
from tests.serato_fixture import make_library, write_wav

CASES = json.loads((Path(__file__).parent / "cases/plan_cases.json").read_text())
ROOT = 5  # the Serato Library root crate in a fresh library (serato_fixture)


def connect(lib: Path) -> sqlite3.Connection:
    con = sqlite3.connect(lib / "master.sqlite")
    con.create_function("serato_str_norm", 1, serato_str_norm, deterministic=True)
    con.create_function("serato_raw_key_string_to_key_type", 1, serato_key_type, deterministic=True)
    con.execute("ATTACH DATABASE ? AS db1", (str(lib / "root.sqlite"),))
    return con


class PlanCases(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = Path(tempfile.mkdtemp())
        cls.template = cls.tmp / "template"
        make_library(cls.template)
        setup = CASES["setup"]
        files = {s: write_wav(cls.tmp / "music" / f"{s}.wav") for s in setup["songs"]}
        create = [
            {"type": "createCrate", "id": f"new-{path}", "name": path.split("/")[-1], "parent": f"new-{path.rsplit('/', 1)[0]}" if "/" in path else ROOT}
            for path in setup["crates"]
        ]
        imports = [{"type": "importTrack", "id": f"imp-{s}", "path": str(files[s])} for s in setup["songs"]]
        result = apply_changes(cls.template, [{"id": "setup", "ops": create + imports}], None)
        cls.crates = {path: result["newIds"][f"new-{path}"] for path in setup["crates"]}
        cls.songs = {s: result["imported"][f"imp-{s}"] for s in setup["songs"]}
        adds = [{"type": "add", "crate": cls.crates[c], "asset": cls.songs[s]} for c, songs in setup["members"].items() for s in songs]
        apply_changes(cls.template, [{"id": "members", "ops": adds}], None)

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def crate_ref(self, ref):
        if ref is None or (isinstance(ref, str) and ref.startswith("new-")):
            return ref
        return ROOT if ref == "" else self.crates[ref]

    def translate(self, op: dict) -> dict:
        out = dict(op)
        for field in ("crate", "parent", "from", "into", "before"):
            if field in out:
                out[field] = self.crate_ref(out[field])
        if "asset" in out:
            out["asset"] = self.songs[out["asset"]]
        return out

    def result(self, lib: Path) -> tuple[dict, dict]:
        """(crate path -> song names, crate path -> child names in order), paths joined with "/"."""
        names = {v: k for k, v in self.songs.items()}
        con = connect(lib)
        try:
            w = _Writer(con)
            tree = {path.replace("\x00", "/"): sorted(names[a] for a in ids) for path, ids in w.actual_tree().items()}
            order = {}
            for path in ["", *tree]:
                mid = w._by_path(path.replace("/", "\x00"))
                order[path] = [r[0] for r in con.execute("SELECT name FROM main.container WHERE parent_id = ? AND type = 1 ORDER BY list_order, id", (mid,))]
        finally:
            con.close()
        return tree, order

    def test_cases(self):
        for case in CASES["cases"]:
            with self.subTest(case["name"]):
                lib = self.tmp / "case"
                shutil.rmtree(lib, ignore_errors=True)
                shutil.copytree(self.template, lib)
                ops = [self.translate(op) for op in case["ops"]]
                if case.get("error"):
                    with self.assertRaises(ApplyError):
                        apply_changes(lib, [{"id": "case", "ops": ops}], None)
                    continue
                apply_changes(lib, [{"id": "case", "ops": ops}], None)
                tree, order = self.result(lib)
                if "tree" in case:
                    self.assertEqual(tree, {k: sorted(v) for k, v in case["tree"].items()})
                for level, children in case.get("order", {}).items():
                    self.assertEqual(order[level], children, f"order of {level or 'the top level'}")


if __name__ == "__main__":
    unittest.main()
