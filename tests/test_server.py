"""The local server's routes, on a temporary data folder (Serato's files are only read, as by the app)."""

from __future__ import annotations

import json
import socket
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from pathlib import Path

from serato_crates import server
from tests.serato_fixture import SERATO_LIBRARY


class Server(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls._tmp = tempfile.TemporaryDirectory()
        with socket.socket() as probe:  # a free port (the server checks the Host header against it)
            probe.bind(("127.0.0.1", 0))
            cls.port = probe.getsockname()[1]
        cls.httpd = server.serve(Path(cls._tmp.name), cls.port)
        threading.Thread(target=cls.httpd.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        cls.httpd.server_close()
        cls._tmp.cleanup()

    def call(self, method: str, path: str, body=None) -> tuple[int, object]:
        req = urllib.request.Request(f"http://127.0.0.1:{self.port}{path}", method=method)
        req.add_header("Host", f"127.0.0.1:{self.port}")
        data = None
        if body is not None:
            data = json.dumps(body).encode()
            req.add_header("Content-Type", "application/json")
        try:
            with urllib.request.urlopen(req, data, timeout=60) as res:
                raw = res.read()
                return res.status, json.loads(raw) if res.headers.get_content_type() == "application/json" else raw
        except urllib.error.HTTPError as e:
            with e:
                return e.code, json.loads(e.read() or b"{}")

    def test_page_and_static_files(self):
        status, page = self.call("GET", "/")
        self.assertEqual(status, 200)
        self.assertIn(b"main.js", page)
        status, table = self.call("GET", "/static/locales/en.json")
        self.assertEqual(status, 200)
        self.assertEqual(table["tab.plan"], "Plan")

    def test_settings(self):
        status, settings = self.call("GET", "/api/settings")
        self.assertEqual(status, 200)
        self.assertIn(settings["lang"], ("en", "zh"))

    def test_documents_have_revisions_and_refuse_stale_writes(self):
        for name in ("plan", "screen", "notes", "rules", "marks"):
            with self.subTest(name):
                status, doc = self.call("GET", f"/api/{name}")
                self.assertEqual(status, 200)
                self.assertEqual(doc["rev"], 0)
        status, out = self.call("PUT", "/api/marks", {"rev": 0, "genuine": ["/a.mp3"], "dismissedDuplicates": [], "pinnedCrates": [3]})
        self.assertEqual((status, out), (200, {"rev": 1}))
        status, out = self.call("PUT", "/api/marks", {"rev": 0, "genuine": [], "dismissedDuplicates": [], "pinnedCrates": []})
        self.assertEqual(status, 409)
        self.assertEqual(out["rev"], 1)
        status, out = self.call("PUT", "/api/plan", {"rev": 0, "changes": "not a list"})
        self.assertEqual(status, 400)

    def test_unknown_route(self):
        self.assertEqual(self.call("GET", "/api/nothing")[0], 404)

    def test_library(self):
        if not (SERATO_LIBRARY / "master.sqlite").exists():
            self.skipTest("Serato DJ 4 is not installed on this Mac")
        status, lib = self.call("GET", "/api/library")
        self.assertEqual(status, 200)
        self.assertIn("tracks", lib)
        self.assertIn("crates", lib)


if __name__ == "__main__":
    unittest.main()
