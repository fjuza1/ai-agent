import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch

from filelock import Timeout

from agents import safe_io

ROOT = Path(__file__).resolve().parents[1]
INCREMENT = """
import sys
sys.path.insert(0, sys.argv[1])
from agents import safe_io
for _ in range(int(sys.argv[3])):
    with safe_io.file_lock(sys.argv[2]):
        document = safe_io.atomic_read_json(sys.argv[2])
        document["count"] += 1
        safe_io.atomic_write_json(sys.argv[2], document)
"""


class SafeIoTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name) / "data" / "cost_ledger.json"

    def leftovers(self):
        return sorted(p.name for p in self.path.parent.iterdir() if p.suffix == ".tmp")

    def test_round_trip_is_atomic_and_identical_writes_are_skipped(self):
        self.assertTrue(safe_io.atomic_write_json(self.path, {"version": 1, "months": {}}))
        self.assertEqual(self.path.read_bytes(), b'{\n  "version": 1,\n  "months": {}\n}\n')
        self.assertEqual(safe_io.atomic_read_json(self.path), {"version": 1, "months": {}})
        modified = self.path.stat().st_mtime_ns
        self.assertFalse(safe_io.atomic_write_json(self.path, {"version": 1, "months": {}}))
        self.assertEqual(self.path.stat().st_mtime_ns, modified)
        self.assertEqual(self.leftovers(), [])
        with self.assertRaises(FileNotFoundError):
            safe_io.atomic_read_json(self.path.with_name("missing.json"))

    def test_failed_replace_keeps_the_previous_document(self):
        safe_io.atomic_write_json(self.path, {"count": 1})
        with patch("agents.safe_io.os.replace", side_effect=OSError("disk full")), self.assertRaises(OSError):
            safe_io.atomic_write_json(self.path, {"count": 2})
        self.assertEqual(json.loads(self.path.read_text(encoding="utf-8")), {"count": 1})
        self.assertEqual(self.leftovers(), [])

    def test_parallel_processes_never_lose_an_update(self):
        safe_io.atomic_write_json(self.path, {"count": 0})
        workers = [subprocess.Popen([sys.executable, "-c", INCREMENT, str(ROOT), str(self.path), "25"]) for _ in range(4)]
        self.assertEqual([worker.wait(timeout=120) for worker in workers], [0, 0, 0, 0])
        self.assertEqual(safe_io.atomic_read_json(self.path), {"count": 100})
        self.assertEqual(self.leftovers(), [])

    def test_lock_is_reentrant_for_its_holder_and_excludes_everyone_else(self):
        outcome = []

        def contend():
            try:
                with safe_io.file_lock(self.path, timeout=0.2):
                    outcome.append("acquired")
            except Timeout:
                outcome.append("timeout")

        with safe_io.file_lock(self.path), safe_io.file_lock(self.path):
            thread = threading.Thread(target=contend)
            thread.start()
            thread.join()
        self.assertEqual(outcome, ["timeout"])
        contend()
        self.assertEqual(outcome, ["timeout", "acquired"])

    def test_dry_run_redirects_writes_and_locks_but_reads_its_own_output(self):
        safe_io.atomic_write_json(self.path, {"count": 1})
        before = sorted(p.name for p in self.path.parent.iterdir() if p.suffix != ".lock")
        with tempfile.TemporaryDirectory() as scratch, \
                patch.dict(os.environ, {safe_io.DRY_RUN_ENV: "1", safe_io.DRY_RUN_DIR_ENV: scratch}):
            self.assertEqual(safe_io.atomic_read_json(self.path), {"count": 1})
            self.assertFalse(safe_io.atomic_write_json(self.path, {"count": 1}))
            self.assertTrue(safe_io.atomic_write_json(self.path, {"count": 2}))
            self.assertEqual(safe_io.atomic_read_json(self.path), {"count": 2})
            self.assertEqual([p.name for p in Path(scratch).rglob("*.json")], ["cost_ledger.json"])
        self.assertEqual(json.loads(self.path.read_text(encoding="utf-8")), {"count": 1})
        self.assertEqual(sorted(p.name for p in self.path.parent.iterdir() if p.suffix != ".lock"), before)


if __name__ == "__main__":
    unittest.main()
