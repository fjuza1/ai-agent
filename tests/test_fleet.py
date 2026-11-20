import asyncio
from datetime import datetime, timezone
from decimal import Decimal
import json
from pathlib import Path
import subprocess
import tempfile
import time
import unittest
from unittest.mock import AsyncMock, patch

from agents.fleet_runner import (
    FleetError, MAX_CONCURRENCY, MAX_RUNTIME_SECONDS, RESERVATION, budget_limit,
    daily_allocations, fetch_source, main, persist_reservations, prepare_run, read_ledger, role_for, run_fleet, settle,
)


class FleetTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        (self.root / "data").mkdir()
        self.write("cost_ledger.json", {"version": 1, "months": {}})
        self.write("agent_state.json", {"version": 1, "runs": []})
        self.write("agent_queue.json", [])
        self.write("agent_drafts.json", [])

    def write(self, name, data):
        (self.root / "data" / name).write_text(json.dumps(data), encoding="utf-8")

    def test_exact_role_partition(self):
        roles = [role_for(i) for i in range(1, 1001)]
        self.assertEqual([roles.count(role) for role in ("scout", "analyst", "marketing")], [400, 300, 300])

    def test_budget_bound_before_request_and_strict_ceiling(self):
        month = datetime.now(timezone.utc).strftime("%Y-%m")
        for spent in ("1000", str(Decimal(1000) - RESERVATION)):
            self.write("cost_ledger.json", {"version": 1, "months": {month: [{"state": "settled", "charged_usd": spent}]}})
            with self.assertRaises(FleetError):
                prepare_run(self.root, [{"id": "test"}], 10, Decimal("1000"), False)
        for invalid in ("1001", "NaN", "0", "-1"):
            with self.assertRaises(FleetError):
                budget_limit(invalid)

    def test_reserved_budget_is_settled_from_token_usage(self):
        _, ids = prepare_run(self.root, [{"id": "one"}], 10, Decimal("1000"), False)
        entry = list(read_ledger(self.root / "data" / "cost_ledger.json")["months"].values())[0][0]
        self.assertEqual(Decimal(entry["charged_usd"]), RESERVATION)
        settle(self.root, ids["one"], 1000, 100)
        entry = list(read_ledger(self.root / "data" / "cost_ledger.json")["months"].values())[0][0]
        self.assertEqual(Decimal(entry["charged_usd"]), Decimal("0.00056"))
        with self.assertRaises(FleetError):
            settle(self.root, ids["one"], 1000, 100)

    def test_cross_month_reservations_settle_in_both_buckets(self):
        entry = {"id": "same", "state": "reserved", "charged_usd": str(RESERVATION)}
        self.write("cost_ledger.json", {"version": 1, "months": {"2026-12": [entry], "2027-01": [entry]}})
        settle(self.root, "same", 1000, 100)
        ledger = read_ledger(self.root / "data" / "cost_ledger.json")
        for month in ("2026-12", "2027-01"):
            self.assertEqual(Decimal(ledger["months"][month][0]["charged_usd"]), Decimal("0.00056"))
            self.assertEqual(ledger["months"][month][0]["state"], "settled")

    def test_cross_month_run_reserves_both_months_before_calls(self):
        class FixedDateTime(datetime):
            @classmethod
            def now(cls, tz=None):
                return cls(2026, 12, 31, 23, 59, tzinfo=timezone.utc)

        with patch("agents.fleet_runner.datetime", FixedDateTime):
            _, ids = prepare_run(self.root, [{"id": "test"}], 7200, Decimal("1000"), False)
        ledger = read_ledger(self.root / "data" / "cost_ledger.json")
        for month in ("2026-12", "2027-01"):
            self.assertEqual(ledger["months"][month][0]["id"], ids["test"])
            self.assertEqual(Decimal(ledger["months"][month][0]["charged_usd"]), RESERVATION)

    def test_cli_returns_one_when_monthly_limit_is_reached(self):
        month = datetime.now(timezone.utc).strftime("%Y-%m")
        self.write("cost_ledger.json", {"version": 1, "months": {
            month: [{"id": "spent", "state": "settled", "charged_usd": "1000"}]
        }})
        with patch("agents.fleet_runner.ROOT", self.root), \
                patch("sys.argv", ["fleet_runner.py", "--agents", "1000", "--max-hours", "1"]), \
                patch.dict("os.environ", {"MONTHLY_BUDGET_USD": "1000", "GITHUB_ACTIONS": "false"}), \
                self.assertLogs("fleet", level="ERROR") as logs:
            self.assertEqual(main(), 1)
        self.assertIn("Budget hard-stop", logs.output[0])

    def test_daily_reserved_time_enforced_even_after_crash(self):
        class FixedDateTime(datetime):
            @classmethod
            def now(cls, tz=None):
                return cls(2026, 1, 1, 12, tzinfo=timezone.utc)

        with patch("agents.fleet_runner.datetime", FixedDateTime):
            prepare_run(self.root, [], MAX_RUNTIME_SECONDS, Decimal("1000"), False)
            with self.assertRaisesRegex(FleetError, "daily runtime"):
                prepare_run(self.root, [], 1, Decimal("1000"), False)

    def test_daily_allocation_splits_at_utc_midnight(self):
        start = datetime(2026, 12, 31, 23, 59, 0, tzinfo=timezone.utc)
        self.assertEqual(daily_allocations(start, 7200), {"2026-12-31": 60, "2027-01-01": 7140})

    def test_failed_remote_persistence_prevents_paid_run(self):
        self.write("agent_queue.json", [{"id": "one", "role": "analyst", "topic": "Stickies"}])
        with patch.dict("os.environ", {"LLM_API_KEY": "test"}), patch("agents.fleet_runner.persist_reservations", side_effect=subprocess.CalledProcessError(1, "git")):
            with self.assertRaises(subprocess.CalledProcessError):
                asyncio.run(run_fleet(self.root, 1000, 5, Decimal("1000"), True))
        ledger = read_ledger(self.root / "data" / "cost_ledger.json")
        self.assertEqual(len(next(iter(ledger["months"].values()))), 1)

    def test_empty_queue_runs_all_workers_without_paid_calls(self):
        asyncio.run(run_fleet(self.root, 1000, 5, Decimal("1000"), False))
        state = json.loads((self.root / "data" / "agent_state.json").read_text(encoding="utf-8"))
        self.assertEqual(state["runs"][0]["status"], "completed")
        self.assertEqual(state["runs"][0]["completed"], [])

    def test_all_role_jobs_create_unapproved_drafts_and_settle_usage(self):
        self.write("agent_queue.json", [
            {"id": "s", "role": "scout", "topic": "Evidence", "source_url": "https://example.org"},
            {"id": "a", "role": "analyst", "topic": "Concept"},
            {"id": "m", "role": "marketing", "topic": "Gift guide"},
        ])

        class FakeResponse:
            async def __aenter__(self):
                return self
            async def __aexit__(self, *args):
                pass
            def raise_for_status(self):
                pass
            async def json(self):
                return {"usage": {"prompt_tokens": 1000, "completion_tokens": 100},
                        "choices": [{"message": {"content": '{"summary":"draft"}'}}]}

        class FakeSession:
            def __init__(self, **kwargs):
                pass
            async def __aenter__(self):
                return self
            async def __aexit__(self, *args):
                pass
            def post(self, *args, **kwargs):
                return FakeResponse()

        with patch.dict("os.environ", {"LLM_API_KEY": "test", "INDEXNOW_ENABLED": "false"}), \
                patch("agents.fleet_runner.aiohttp.ClientSession", FakeSession), \
                patch("agents.fleet_runner.aiohttp.TCPConnector"), \
                patch("agents.fleet_runner.fetch_source", new=AsyncMock(return_value="Public source text")):
            asyncio.run(run_fleet(self.root, 1000, 5, Decimal("1000"), False))
        drafts = json.loads((self.root / "data" / "agent_drafts.json").read_text(encoding="utf-8"))
        self.assertEqual({d["role"] for d in drafts}, {"scout", "analyst", "marketing"})
        self.assertTrue(all(d["review_status"] == "draft" and d["verified_usa_manufacturing"] is False for d in drafts))
        entries = next(iter(read_ledger(self.root / "data" / "cost_ledger.json")["months"].values()))
        self.assertTrue(all(e["state"] == "settled" and Decimal(e["charged_usd"]) == Decimal("0.00056") for e in entries))

    def test_deadline_cancels_worker_and_records_checkpoint(self):
        self.write("agent_queue.json", [{"id": "slow", "role": "analyst", "topic": "Stickies"}])

        class FakeSession:
            def __init__(self, **kwargs):
                pass
            async def __aenter__(self):
                return self
            async def __aexit__(self, *args):
                pass
            def post(self, *args, **kwargs):
                return self

        class SlowResponse:
            async def __aenter__(self):
                await asyncio.sleep(10)
            async def __aexit__(self, *args):
                pass

        FakeSession.post = lambda self, *args, **kwargs: SlowResponse()
        with patch.dict("os.environ", {"LLM_API_KEY": "test"}), \
                patch("agents.fleet_runner.aiohttp.ClientSession", FakeSession), \
                patch("agents.fleet_runner.aiohttp.TCPConnector"):
            asyncio.run(run_fleet(self.root, 1000, 1, Decimal("1000"), False))
        state = json.loads((self.root / "data" / "agent_state.json").read_text(encoding="utf-8"))
        self.assertEqual(state["runs"][0]["status"], "timed_out")
        self.assertEqual(state["runs"][0]["failed"][0]["job_id"], "slow")
        entry = next(iter(read_ledger(self.root / "data" / "cost_ledger.json")["months"].values()))[0]
        self.assertEqual(entry["state"], "reserved")

    def test_reservations_are_pushed_to_the_staging_branch_and_never_to_main(self):
        with patch("agents.fleet_runner.subprocess.run") as run, patch.dict("os.environ", {"AGENT_GIT_BRANCH": ""}):
            persist_reservations(self.root, time.monotonic() + 60)
        self.assertEqual(run.call_args_list[-1].args[0], ["git", "push", "origin", "HEAD:refs/heads/agent-staging"])
        for branch in ("main", "MASTER", "../main", "agent staging"):
            with self.subTest(branch=branch), patch("agents.fleet_runner.subprocess.run") as run, \
                    patch.dict("os.environ", {"AGENT_GIT_BRANCH": branch}), self.assertRaises(FleetError):
                persist_reservations(self.root, time.monotonic() + 60)
            run.assert_not_called()

    def test_at_most_25_of_the_1000_workers_are_in_flight(self):
        self.write("agent_queue.json", [{"id": f"job-{i}", "role": "analyst", "topic": "Concept"} for i in range(40)])
        active = peak = 0

        class FakeResponse:
            async def __aenter__(self):
                nonlocal active, peak
                active += 1
                peak = max(peak, active)
                await asyncio.sleep(0.01)
                return self
            async def __aexit__(self, *args):
                nonlocal active
                active -= 1
            def raise_for_status(self):
                pass
            async def json(self):
                return {"usage": {"prompt_tokens": 10, "completion_tokens": 10},
                        "choices": [{"message": {"content": '{"summary":"draft"}'}}]}

        class FakeSession:
            def __init__(self, **kwargs):
                pass
            async def __aenter__(self):
                return self
            async def __aexit__(self, *args):
                pass
            def post(self, *args, **kwargs):
                return FakeResponse()

        with patch.dict("os.environ", {"LLM_API_KEY": "test", "INDEXNOW_ENABLED": "false"}), \
                patch("agents.fleet_runner.aiohttp.ClientSession", FakeSession), \
                patch("agents.fleet_runner.aiohttp.TCPConnector"):
            asyncio.run(run_fleet(self.root, 1000, 60, Decimal("1000"), False))
        self.assertEqual(peak, MAX_CONCURRENCY)
        self.assertEqual(MAX_CONCURRENCY, 25)
        drafts = json.loads((self.root / "data" / "agent_drafts.json").read_text(encoding="utf-8"))
        self.assertEqual(len(drafts), 40)

    def test_dry_run_simulates_queued_jobs_without_a_key_network_or_data_writes(self):
        self.write("agent_queue.json", [{"id": "one", "role": "scout", "topic": "Evidence", "source_url": "https://example.org"}])
        before = {path.name: path.read_bytes() for path in (self.root / "data").iterdir()}
        with tempfile.TemporaryDirectory() as scratch, \
                patch.dict("os.environ", {"AGENT_DRY_RUN": "1", "AGENT_DRY_RUN_DIR": scratch, "LLM_API_KEY": ""}), \
                patch("agents.fleet_runner.aiohttp.ClientSession.post", side_effect=AssertionError("no network in a dry run")), \
                patch("agents.fleet_runner.persist_reservations", side_effect=AssertionError("no push in a dry run")):
            asyncio.run(run_fleet(self.root, 1000, 5, Decimal("1000"), True))
            simulated = json.loads(next(Path(scratch).rglob("agent_drafts.json")).read_text(encoding="utf-8"))
        self.assertEqual(simulated[0]["output"]["dry_run"], True)
        self.assertEqual({path.name: path.read_bytes() for path in (self.root / "data").iterdir()}, before)

    def test_missing_and_invalid_ledger_fail_closed(self):
        path = self.root / "data" / "cost_ledger.json"
        path.unlink()
        with self.assertRaises(FileNotFoundError):
            read_ledger(path)
        self.write("cost_ledger.json", {"version": 1, "months": {"2026-01": [{"state": "settled", "charged_usd": "NaN"}]}})
        with self.assertRaises(FleetError):
            read_ledger(path)

    def test_scout_rejects_literal_private_ip_and_non_https_before_network(self):
        for url in ("https://127.0.0.1/", "https://[::1]/", "http://example.org/", "https://user@example.org/"):
            with self.subTest(url=url), self.assertRaises(FleetError):
                asyncio.run(fetch_source(None, url))


if __name__ == "__main__":
    unittest.main()
