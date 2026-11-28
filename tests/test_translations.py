"""The translation files match the code that uses them (tools/check_i18n.py)."""

from __future__ import annotations

import importlib.util
import io
import unittest
from contextlib import redirect_stdout
from pathlib import Path

TOOL = Path(__file__).resolve().parent.parent / "tools/check_i18n.py"


class Translations(unittest.TestCase):
    def test_consistent(self):
        spec = importlib.util.spec_from_file_location("check_i18n", TOOL)
        tool = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(tool)
        out = io.StringIO()
        with redirect_stdout(out):
            status = tool.main()
        self.assertEqual(status, 0, out.getvalue())


if __name__ == "__main__":
    unittest.main()
