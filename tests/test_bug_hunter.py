from decimal import Decimal
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from agents import bug_hunter_agent as bh


class FakeTools(bh.Tools):
    """Compiler stand-in: tsc reports `errors` findings so patches can be verified or rejected."""

    def __init__(self, root, errors=0):
        super().__init__(root)
        self.errors = errors
        self.tsc_runs = 0

    def run_tsc(self):
        self.tsc_runs += 1
        findings = bh.assign_ids([bh.finding("TSC-TS1", "HIGH", bh.CAT_BUILD, "x.ts", 1, "t", "d", key=str(i), scope="global", tool="tsc")
                                  for i in range(self.errors)])
        return bh.ToolResult("FAIL" if findings else "PASS", findings)

    def run_prisma(self):
        return bh.ToolResult("SKIPPED")

    def run_pycompile(self):
        return bh.ToolResult("SKIPPED")


class RegressingTools(FakeTools):
    """tsc error count follows `sequence` (tool phase, auto-fix baseline, then after each patch)."""

    def __init__(self, root, sequence):
        super().__init__(root)
        self.sequence = iter(sequence)

    def run_tsc(self):
        self.errors = next(self.sequence, self.errors)
        return super().run_tsc()


class BugHunterTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.write("data/cost_ledger.json", json.dumps({"version": 1, "months": {}}))

    def write(self, rel, text):
        path = self.root / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8", newline="\n")

    def audit(self, **kwargs):
        kwargs.setdefault("tools", FakeTools(self.root))
        return bh.run_audit(self.root, **kwargs)

    def rules(self, summary, status=None):
        return {(d["rule"], d["file"]) for d in summary["state"]["open_defects"] if status in (None, d["status"])}

    def test_cron_and_usa_filter_rules(self):
        self.write("apps/shop/app/page.jsx", "export default function Page() { return null; }\n")
        self.write("apps/shop/app/api/cron/open/route.ts", "export async function GET() { return Response.json({}); }\n")
        self.write("apps/shop/app/api/cron/weak/route.ts",
                   "export async function GET(r: Request) {\n  if (r.headers.get('authorization') !== `Bearer ${process.env.CRON_SECRET}`) return new Response('no', { status: 401 });\n  return Response.json({});\n}\n")
        self.write("apps/shop/app/api/cron/safe/route.ts",
                   "export async function GET(r: Request) {\n  const secret = process.env.CRON_SECRET;\n  if (!secret) return new Response('x', { status: 503 });\n  return Response.json({});\n}\n")
        self.write("apps/shop/lib/feed.js", 'import { readFile } from "node:fs/promises";\nexport const load = () => readFile("data/supplements.json", "utf8");\n')
        self.write("apps/shop/lib/loose.js", 'export const ok = (p) => (p.origin_country ?? "USA") === "USA";\n')
        found = self.rules(self.audit(full_scan=True))
        self.assertIn(("AUTH-CRON-UNPROTECTED", "apps/shop/app/api/cron/open/route.ts"), found)
        self.assertIn(("AUTH-CRON-SECRET-UNSET", "apps/shop/app/api/cron/weak/route.ts"), found)
        self.assertNotIn(("AUTH-CRON-SECRET-UNSET", "apps/shop/app/api/cron/safe/route.ts"), found)
        self.assertIn(("USA-UNFILTERED-CATALOG-READ", "apps/shop/lib/feed.js"), found)
        self.assertIn(("USA-ORIGIN-FILTER-WEAK", "apps/shop/lib/loose.js"), found)

    def test_secrets_are_flagged_but_never_written_to_the_report(self):
        secret = "sk_" + "live_" + "A1b2C3d4E5f6G7h8I9j0"
        self.write("lib/pay.js", f'const key = "{secret}";\n')
        summary = self.audit(full_scan=True)
        self.assertIn(("SEC-EXPOSED-SECRET", "lib/pay.js"), self.rules(summary))
        report = (self.root / "BUG_REPORT.md").read_text(encoding="utf-8")
        state = (self.root / "data" / "qa_session_state.json").read_text(encoding="utf-8")
        self.assertNotIn(secret, report + state)
        self.assertIn("CRITICAL", report)

    def test_incremental_sessions_rescan_only_changed_files_and_verify_fixes(self):
        self.write("lib/a.js", 'export const a = new URL(process.env.SITE);\n')
        self.write("lib/b.js", "export const b = 1;\n")
        first = self.audit(full_scan=True)
        self.assertEqual(first["scanned"], 3)
        defect = next(d for d in first["state"]["open_defects"] if d["rule"] == "ENV-UNGUARDED-PARSE")
        second = self.audit()
        self.assertEqual(second["scanned"], 0)
        self.assertIn("No material change", second["note"])
        self.write("lib/a.js", 'export const a = new URL(process.env.SITE || "http://localhost");\n')
        self.write("lib/c.js", "export const c = 3;\n")
        third = self.audit()
        self.assertEqual(third["scanned"], 2)
        state = third["state"]
        self.assertFalse(state["open_defects"])
        resolved = next(d for d in state["resolved_defects"] if d["id"] == defect["id"])
        self.assertEqual(resolved["status"], "VERIFIED")
        self.assertEqual(state["session_count"], 2)
        self.assertEqual(set(state["scanned_file_hashes"]), {"lib/a.js", "lib/b.js", "lib/c.js", "data/cost_ledger.json"})
        self.write("lib/a.js", 'export const a = new URL(process.env.SITE);\n')
        regressed = next(d for d in self.audit()["state"]["open_defects"] if d["id"] == defect["id"])
        self.assertTrue(regressed["reopened"])

    def test_broken_links_imports_and_jsonld(self):
        self.write("apps/shop/app/page.jsx", 'import x from "./missing";\nexport default () => <a href="/nowhere">x</a>;\n')
        self.write("apps/shop/app/product/[id]/page.jsx",
                   'export default () => <><a href={`/product/${1}`}>ok</a><script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify({}) }} /></>;\n')
        found = self.rules(self.audit(full_scan=True))
        self.assertIn(("LINK-BROKEN-INTERNAL", "apps/shop/app/page.jsx"), found)
        self.assertIn(("BUILD-UNRESOLVED-IMPORT", "apps/shop/app/page.jsx"), found)
        self.assertIn(("JSONLD-UNESCAPED", "apps/shop/app/product/[id]/page.jsx"), found)
        self.assertNotIn(("LINK-BROKEN-INTERNAL", "apps/shop/app/product/[id]/page.jsx"), found)

    def test_billing_prisma_and_timezone_rules(self):
        self.write("apps/shop/lib/quota.js",
                   "export async function use(db, now = new Date()) {\n  const day = now.toISOString().slice(0, 10); // daily quota\n"
                   "  const row = await db.usage.findUnique({ where: { day } });\n  await db.usage.update({ where: { day }, data: { count: row.count + 1 } });\n}\n")
        self.write("apps/shop/lib/pay.js", "export const go = (stripe, cents) => stripe.checkout.sessions.create({ line_items: [{ price_data: { unit_amount: cents } }] });\n")
        found = self.rules(self.audit(full_scan=True))
        for rule in ("TZ-DAILY-RESET-UTC", "PRISMA-READ-MODIFY-WRITE", "PRISMA-CHECK-THEN-ACT"):
            self.assertIn((rule, "apps/shop/lib/quota.js"), found)
        self.assertIn(("STRIPE-MIN-CHARGE-UNGUARDED", "apps/shop/lib/pay.js"), found)

    def test_python_budget_and_async_rules(self):
        self.write("agents/bad.py",
                   "import asyncio, time\n\nasync def run(session):\n    time.sleep(1)\n    asyncio.create_task(run(session))\n"
                   "    await session.post('https://api.openai.com/v1/chat/completions')\n")
        found = self.rules(self.audit(full_scan=True))
        for rule in ("PY-ASYNC-BLOCKING-CALL", "PY-FIRE-AND-FORGET", "BUDGET-LLM-NO-CHECK"):
            self.assertIn((rule, "agents/bad.py"), found)

    def test_workflow_and_ledger_rules(self):
        self.write(".github/workflows/x.yml",
                   "on:\n  push:\n  schedule:\n    - cron: '0 2 * * *'\njobs:\n  fleet:\n    runs-on: ubuntu-latest\n    steps:\n      - run: python agents/fleet_runner.py\n        env:\n          LLM_API_KEY: ${{ secrets.LLM_API_KEY }}\n")
        self.write("data/cost_ledger.json", json.dumps({"version": 1, "months": {"2026-11": [{"id": "1", "state": "settled", "charged_usd": "1000"}]}}))
        found = self.rules(self.audit(full_scan=True))
        self.assertIn(("BUDGET-LLM-ON-EVERY-PUSH", ".github/workflows/x.yml"), found)
        self.assertIn(("BUDGET-STEP-NO-CAP", ".github/workflows/x.yml"), found)
        self.assertIn(("CI-NO-TIMEOUT", ".github/workflows/x.yml"), found)
        self.assertIn(("BUDGET-EXCEEDED", "data/cost_ledger.json"), found)

    def test_auto_fix_patches_are_verified_and_reverted_on_regression(self):
        mojibake = "\u2013".encode("utf-8").decode("cp1252")
        self.write("lib/text.js", f'export const t = "12{mojibake}128";\nexport const h = process.env.HOST.trim();\n')
        self.write("agents/io.py", "from pathlib import Path\n\ndef load(p):\n    return Path(p).read_text()\n")
        tools = FakeTools(self.root)
        summary = self.audit(full_scan=True, auto_fix=True, tools=tools)
        self.assertEqual((self.root / "lib/text.js").read_text(encoding="utf-8"), 'export const t = "12\u2013128";\nexport const h = (process.env.HOST ?? "").trim();\n')
        self.assertIn('read_text(encoding="utf-8")', (self.root / "agents/io.py").read_text(encoding="utf-8"))
        statuses = {d["rule"]: d["status"] for d in summary["state"]["resolved_defects"]}
        self.assertEqual(statuses, {"ENC-MOJIBAKE": "AUTO-FIXED", "ENV-UNGUARDED-METHOD": "AUTO-FIXED", "PY-OPEN-NO-ENCODING": "AUTO-FIXED"})
        self.assertFalse(summary["state"]["open_defects"])
        verified = self.audit()
        self.assertEqual({d["status"] for d in verified["state"]["resolved_defects"]}, {"VERIFIED"})

        self.write("lib/risky.js", "export const r = process.env.NAME.trim();\n")
        before = (self.root / "lib/risky.js").read_text(encoding="utf-8")
        reverted = self.audit(auto_fix=True, tools=RegressingTools(self.root, [0, 0, 3]))
        self.assertEqual((self.root / "lib/risky.js").read_text(encoding="utf-8"), before)
        self.assertTrue(any("Reverted" in note for note in reverted["autofix_notes"]))

    def test_tsc_findings_are_auto_fixed_and_verified_by_rerunning_tsc(self):
        self.write("lib/t.ts", "export const x = o.a.b;\n")

        class TscTools(FakeTools):
            def run_tsc(inner):
                text = (self.root / "lib/t.ts").read_text(encoding="utf-8")
                if "o.a.b" not in text:
                    return bh.ToolResult("PASS")
                item = bh.finding("TSC-TS18048", "HIGH", bh.CAT_BUILD, "lib/t.ts", 1, "t", "d", key="k", scope="global", tool="tsc",
                                  fix={"kind": "tsc-optional-chain", "line": 1, "col": 17, "name": "o.a"})
                return bh.ToolResult("FAIL", bh.assign_ids([item]))

        summary = self.audit(full_scan=True, auto_fix=True, tools=TscTools(self.root))
        self.assertEqual((self.root / "lib/t.ts").read_text(encoding="utf-8"), "export const x = o.a?.b;\n")
        self.assertEqual([(d["rule"], d["status"]) for d in summary["state"]["resolved_defects"]], [("TSC-TS18048", "AUTO-FIXED")])
        self.assertFalse(summary["state"]["open_defects"])

    def test_tsc_output_is_parsed_into_defects(self):
        out = ("apps/a/x.ts(3,5): error TS18048: 'user' is possibly 'undefined'.\n"
               "error TS5083: Cannot read file 'tsconfig.json'.\nunrelated noise\n")
        found = bh.parse_tsc(out, self.root, "tsconfig.json")
        self.assertEqual([(f["file"], f["line"], f["rule"]) for f in found], [("apps/a/x.ts", 3, "TSC-TS18048"), ("tsconfig.json", 1, "TSC-TS5083")])
        self.assertEqual(found[0]["_fix"]["name"], "user")

    def test_llm_budget_is_reserved_before_calls_and_aborts_at_the_cap(self):
        limit = Decimal("1000")
        ledger = self.root / "data" / "cost_ledger.json"
        ledger.write_text(json.dumps({"version": 1, "months": {bh.utc_now()[:7]: [{"id": "x", "state": "settled", "charged_usd": "999.99999"}]}}), encoding="utf-8")
        with self.assertRaises(bh.BudgetExceeded):
            bh.reserve_budget(self.root, Decimal("0.01"), limit, "t", "r")
        ledger.write_text(json.dumps({"version": 1, "months": {}}), encoding="utf-8")
        self.write("lib/a.js", "export const a = 1;\n")
        sf = bh.read_source(self.root, self.root / "lib/a.js")
        reply = {"defects": [{"line": 1, "severity": "high", "category": bh.CAT_AUTH, "title": "Issue", "detail": "why"},
                             {"line": 99, "severity": "HIGH", "category": bh.CAT_AUTH, "title": "Out of range", "detail": ""}]}
        findings, stats = bh.llm_review(self.root, [sf], "key", limit, Decimal("1"), 5, caller=lambda key, prompt: (reply, 100, 50))
        self.assertEqual([f["title"] for f in findings], ["Issue"])
        entry = json.loads(ledger.read_text(encoding="utf-8"))["months"][bh.utc_now()[:7]][0]
        self.assertEqual((entry["state"], entry["agent"]), ("settled", "bug-hunter"))
        self.assertLess(Decimal(entry["charged_usd"]), Decimal("0.001"))
        _, capped = bh.llm_review(self.root, [sf], "key", limit, Decimal("0"), 5, caller=lambda key, prompt: self.fail("must not call"))
        self.assertIn("per-run LLM cap", capped["stopped"])

    def test_llm_is_skipped_without_a_key(self):
        self.write("lib/a.js", "export const a = 1;\n")
        with patch.dict("os.environ", {"LLM_API_KEY": ""}):
            summary = self.audit(full_scan=True, llm=True)
        self.assertFalse(summary["state"]["llm"]["enabled"])

    def test_gate_failures_are_logged_and_survive_later_audits(self):
        self.write("lib/a.js", "export const a = 1;\n")
        self.audit(full_scan=True)
        bh.record_pipeline_failure(self.root, "verify", "Lighthouse SEO below 97 | no pull request", "https://github.com/o/r/actions/runs/7")
        report = (self.root / "BUG_REPORT.md").read_text(encoding="utf-8")
        self.assertIn("| `verify` | Lighthouse SEO below 97 \\| no pull request | [log](https://github.com/o/r/actions/runs/7) |", report)
        self.assertIn("## LOW (0 open)", report)
        self.write("lib/b.js", "export const b = process.env.NAME.trim();\n")
        self.assertTrue(self.audit()["wrote"])
        bh.record_pipeline_failure(self.root, "promote", "merge refused", "javascript:alert(1)")
        report = (self.root / "BUG_REPORT.md").read_text(encoding="utf-8")
        self.assertEqual((report.count(bh.PIPELINE_BEGIN), report.count("## Pipeline gate failures")), (1, 1))
        self.assertLess(report.index("| `promote` | merge refused |  |"), report.index("| `verify` |"))
        state = json.loads((self.root / "data" / "qa_session_state.json").read_text(encoding="utf-8"))
        self.assertEqual([item["stage"] for item in state["pipeline_failures"]], ["promote", "verify"])
        self.assertTrue(state["open_defects"])

    def test_report_is_ordered_by_severity(self):
        self.write("lib/a.js", 'const k = process.env.A.trim();\nconst s = "' + "sk_" + "live_" + 'A1b2C3d4E5f6G7h8I9j0";\n')
        self.audit(full_scan=True)
        report = (self.root / "BUG_REPORT.md").read_text(encoding="utf-8")
        order = [report.index(f"## {s} ") for s in bh.SEVERITIES]
        self.assertEqual(order, sorted(order))
        self.assertIn("| ID | File : Line | Category | Status | Root cause / reproduction |", report)


if __name__ == "__main__":
    unittest.main()
