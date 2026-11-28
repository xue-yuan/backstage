"""documents.py: files the page edits as a whole, written only on top of the revision the writer read."""

from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from serato_crates.documents import Conflict, documents


class Documents(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self._tmp.name)
        self.docs = documents(self.dir)

    def tearDown(self):
        self._tmp.cleanup()

    def test_missing_file_reads_as_default_at_revision_0(self):
        self.assertEqual(self.docs["plan"].read(), {"version": 1, "changes": [], "rev": 0})
        self.assertFalse((self.dir / "plan.json").exists())

    def test_each_write_raises_the_revision(self):
        plan = self.docs["plan"]
        self.assertEqual(plan.write({"rev": 0, "version": 1, "changes": [{"id": "a", "ops": []}]}), 1)
        self.assertEqual(plan.write({"rev": 1, "version": 1, "changes": []}), 2)
        self.assertEqual(json.loads((self.dir / "plan.json").read_text())["rev"], 2)

    def test_a_write_based_on_an_old_revision_is_refused(self):
        marks = self.docs["marks"]
        marks.write({"rev": 0, "genuine": ["/a.mp3"], "dismissedDuplicates": [], "pinnedCrates": []})
        with self.assertRaises(Conflict) as caught:
            marks.write({"rev": 0, "genuine": [], "dismissedDuplicates": [], "pinnedCrates": []})
        self.assertEqual(caught.exception.rev, 1)
        self.assertEqual(marks.read()["genuine"], ["/a.mp3"])  # the earlier write is kept

    def test_a_write_without_a_revision_is_refused_once_the_file_exists(self):
        screen = self.docs["screen"]
        screen.write({"rev": 0, "reject": [], "keep": []})
        with self.assertRaises(Conflict):
            screen.write({"reject": ["/x.mp3"], "keep": []})

    def test_invalid_contents_are_refused(self):
        with self.assertRaises(ValueError):
            self.docs["rules"].write({"rev": 0, "overrides": {"5": "maybe"}})
        with self.assertRaises(ValueError):
            self.docs["marks"].write({"rev": 0, "genuine": [1], "dismissedDuplicates": [], "pinnedCrates": []})
        with self.assertRaises(ValueError):
            self.docs["marks"].write({"rev": 0, "genuine": [], "dismissedDuplicates": [], "pinnedCrates": [True]})
        with self.assertRaises(ValueError):
            self.docs["notes"].write({"rev": 0, "notes": [{"id": 1, "text": "x"}]})
        self.assertFalse(any(self.dir.iterdir()))

    def test_notes_keep_the_previous_version(self):
        notes = self.docs["notes"]
        notes.write({"rev": 0, "notes": [{"id": "a", "text": "first"}]})
        notes.write({"rev": 1, "notes": [{"id": "a", "text": "second"}]})
        previous = json.loads((self.dir / "notes.prev.json").read_text())
        self.assertEqual(previous["notes"][0]["text"], "first")

    def test_only_the_known_fields_are_stored(self):
        self.docs["screen"].write({"rev": 0, "reject": ["/a.mp3"], "keep": [], "extra": 1})
        self.assertEqual(self.docs["screen"].read(), {"reject": ["/a.mp3"], "keep": [], "rev": 1})


if __name__ == "__main__":
    unittest.main()
