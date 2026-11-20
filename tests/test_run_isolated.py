import os
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from agents import run_isolated, safe_io


class RunIsolatedTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        (self.root / "data").mkdir()
        self.ledger = self.root / "data" / "cost_ledger.json"
        self.ledger.write_text('{"version": 1, "months": {}}\n', encoding="utf-8")
        self.calls = []
        self.exit_codes = {}
        patcher = patch.object(run_isolated, "ROOT", self.root)
        patcher.start()
        self.addCleanup(patcher.stop)

    def runner(self, command, cwd, env, timeout):
        script = Path(command[1]).name
        self.calls.append(SimpleNamespace(script=script, args=command[2:], env=env))
        # Every stage writes through safe_io, exactly as the real agents do.
        safe_io.atomic_write_json(self.ledger, {"version": 1, "months": {}, "written_by": script})
        return SimpleNamespace(returncode=self.exit_codes.get(script, 0))

    def main(self, *argv, **environment):
        with patch.object(run_isolated.subprocess, "run", self.runner), \
                patch.object(run_isolated, "record_failure") as record, \
                patch.dict(os.environ, {"GITHUB_ACTIONS": "false", "GITHUB_STEP_SUMMARY": "", **environment}):
            return run_isolated.main(list(argv)), record

    def test_stages_run_once_each_in_dependency_order(self):
        code, record = self.main("--llm-review", GITHUB_ACTIONS="true")
        self.assertEqual(code, 0)
        self.assertEqual([call.script for call in self.calls], [
            "product_expander_agent.py", "daily_catalog_linker.py", "daily_trend_ui_agent.py", "fleet_runner.py", "bug_hunter_agent.py"])
        flags = {call.script: call.args for call in self.calls}
        self.assertEqual(flags["product_expander_agent.py"], [])
        for script in ("daily_catalog_linker.py", "daily_trend_ui_agent.py", "fleet_runner.py"):
            self.assertIn("--persist-reservations", flags[script])
        self.assertEqual(flags["fleet_runner.py"][:4], ["--agents", "1000", "--max-hours", "1.0000"])
        self.assertEqual(flags["bug_hunter_agent.py"], ["--llm"])
        record.assert_not_called()

    def test_failed_stage_stops_dependents_but_still_audits_and_logs(self):
        self.exit_codes["daily_catalog_linker.py"] = 1
        code, record = self.main()
        self.assertEqual(code, 1)
        self.assertEqual([call.script for call in self.calls], ["product_expander_agent.py", "daily_catalog_linker.py", "bug_hunter_agent.py"])
        self.assertEqual(record.call_args.args[0], "catalog_linker")
        self.assertIn("exited with code 1", record.call_args.args[1])

    def test_dry_run_leaves_data_untouched_and_cannot_spend_or_push(self):
        before = self.ledger.read_bytes()
        self.exit_codes["fleet_runner.py"] = 1
        code, record = self.main("--dry-run", "--llm-review", GITHUB_ACTIONS="true", LLM_API_KEY="secret")
        self.assertEqual(code, 1)
        self.assertEqual(len(self.calls), 5)
        for call in self.calls:
            self.assertEqual((call.env[safe_io.DRY_RUN_ENV], call.env["LLM_API_KEY"]), ("1", ""))
            self.assertFalse({"--persist-reservations", "--llm"} & set(call.args))
            self.assertFalse(Path(call.env[safe_io.DRY_RUN_DIR_ENV]).exists())
        self.assertEqual(self.ledger.read_bytes(), before)
        self.assertEqual([path.name for path in (self.root / "data").iterdir()], ["cost_ledger.json"])
        self.assertNotIn(safe_io.DRY_RUN_ENV, os.environ)
        record.assert_not_called()

    def test_time_limit_shortens_the_fleet_and_skips_it_when_nothing_is_left(self):
        self.main("--max-minutes", "30")
        hours = float(next(call.args[3] for call in self.calls if call.script == "fleet_runner.py"))
        self.assertAlmostEqual(hours, 14 / 60, delta=0.01)
        self.calls.clear()
        code, _ = self.main("--max-minutes", "20")
        self.assertEqual(code, 0)
        self.assertNotIn("fleet_runner.py", [call.script for call in self.calls])


if __name__ == "__main__":
    unittest.main()
