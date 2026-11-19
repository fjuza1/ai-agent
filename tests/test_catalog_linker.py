import asyncio
from datetime import datetime, timezone
from decimal import Decimal
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import AsyncMock, patch
from urllib.parse import parse_qs, urlsplit

from agents.daily_catalog_linker import (
    RESERVATION, CatalogProduct, affiliate_settings, build_store_links, run_linker, select_top_picks,
)
from agents.fleet_runner import FleetError, read_ledger

NOW = datetime(2026, 11, 19, 2, 0, tzinfo=timezone.utc)
DAY = "2026-11-19"


def product(index, **extra):
    categories = [[], ["Holiday Gift Bundles"], ["family-planning-bundles"]][index % 3]
    return {"id": f"item-{index}", "name": f"Item {index}", "description": "Description", "price_cents": 500,
            "origin_country": "USA", "verified_usa_manufacturing": True, "review_status": "approved",
            "verification_source": "https://example.com/evidence", "categories": categories, "goals": [], **extra}


def reply(products, prompt_tokens=1000, completion_tokens=100):
    return {"usage": {"prompt_tokens": prompt_tokens, "completion_tokens": completion_tokens},
            "choices": [{"message": {"content": json.dumps({"products": products})}}]}


class CatalogLinkerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        (self.root / "data").mkdir()
        self.write("cost_ledger.json", {"version": 1, "months": {}})

    def write(self, name, data):
        (self.root / "data" / name).write_text(json.dumps(data), encoding="utf-8")

    def read(self, name):
        return json.loads((self.root / "data" / name).read_text(encoding="utf-8"))

    def run_linker(self, api_key="", **options):
        with patch.dict("os.environ", {"LLM_API_KEY": api_key}):
            return asyncio.run(run_linker(self.root, day=DAY, now=NOW, limit=Decimal("1000"), **options))

    def test_store_links_are_encoded_and_reject_unsafe_affiliate_settings(self):
        item = CatalogProduct.model_validate(product(0, name="Vitamin D3 & K2 (5,000 IU) = 100% #1?"))
        links = build_store_links(item, *affiliate_settings("winterwell-20", "idp=4821"))
        amazon, alza = urlsplit(links.amazon), urlsplit(links.alza)
        self.assertEqual((amazon.netloc, amazon.path), ("www.amazon.com", "/s"))
        self.assertEqual(parse_qs(amazon.query), {"k": [item.name], "tag": ["winterwell-20"]})
        self.assertEqual((alza.netloc, alza.path), ("www.alza.sk", "/search.htm"))
        self.assertEqual(parse_qs(alza.query), {"exps": [item.name], "idp": ["4821"]})
        self.assertEqual(links.direct, "/go/item-0")
        self.assertNotIn("tag=", build_store_links(item, "", None).amazon)
        for tag, param in (("bad tag&x=1", ""), ("", "exps=other"), ("", "a=1&b=2"), ("", "https://evil.example")):
            with self.subTest(tag=tag, param=param), self.assertRaises(FleetError):
                affiliate_settings(tag, param)

    def test_daily_rotation_is_seeded_mixed_and_limited_to_available_items(self):
        items = [CatalogProduct.model_validate(product(index)) for index in range(12)]
        first = select_top_picks(items, DAY)
        # The storefront fallback in lib/dailyFeatured.ts asserts this same order.
        self.assertEqual(first, ["item-5", "item-6", "item-1", "item-2", "item-9", "item-4", "item-8", "item-0"])
        self.assertEqual(first, select_top_picks(list(reversed(items)), DAY))
        self.assertNotEqual(first, select_top_picks(items, "2026-11-20"))
        self.assertEqual({int(pid.split("-")[1]) % 3 for pid in first[:3]}, {0, 1, 2})
        sold_out = CatalogProduct.model_validate(product(5, delivery={"in_stock": False, "express": False}))
        self.assertNotIn("item-5", select_top_picks([*items[:5], sold_out, *items[6:]], DAY))

    def test_without_key_rules_enrich_only_reviewed_products_and_runs_are_idempotent(self):
        foreign = product(9, origin_country="Canada")
        self.write("supplements.json", [
            product(0, goals=["Immunity"]), foreign,
            product(2, fda_device_type="pregnancy_test"), product(4, delivery={"in_stock": False, "express": False}),
        ])
        (self.root / "data" / "clicks.jsonl").write_text(
            '{"at":"2026-11-18T10:00:00.000Z","productId":"item-2","destination":"internal"}\n'
            '{"at":"2026-10-01T10:00:00.000Z","productId":"item-0","destination":"internal"}\nnot json\n', encoding="utf-8")
        summary = self.run_linker(amazon_tag="winterwell-20", click_log=self.root / "data" / "clicks.jsonl")
        catalog = self.read("supplements.json")
        self.assertEqual(catalog[1], foreign)
        self.assertEqual(catalog[0]["used_for"], ["Immunity"])
        self.assertEqual(catalog[0]["store_links"]["amazon"], "https://www.amazon.com/s?k=Item+0&tag=winterwell-20")
        self.assertEqual(catalog[2]["used_for"], ["Early Pregnancy Detection", "Family Planning"])
        self.assertEqual(catalog[0]["discovery_meta"]["source"], "rules")
        featured = self.read("daily_featured.json")
        self.assertEqual((featured["date"], set(featured["top_picks"])), (DAY, {"item-0", "item-2"}))
        self.assertEqual((featured["trending_source"], featured["trending_searches"][0]), ("clicks", "item 2"))
        self.assertEqual(summary["rules"], 3)
        self.assertEqual(self.read("cost_ledger.json"), {"version": 1, "months": {}})
        before = [(self.root / "data" / name).read_bytes() for name in ("supplements.json", "daily_featured.json")]
        self.assertEqual(self.run_linker(amazon_tag="winterwell-20", click_log=self.root / "data" / "clicks.jsonl")["unchanged"], 3)
        self.assertEqual(before, [(self.root / "data" / name).read_bytes() for name in ("supplements.json", "daily_featured.json")])

    def test_model_output_is_sanitized_settled_and_not_requested_twice(self):
        self.write("supplements.json", [product(0), product(1)])
        model = AsyncMock(return_value=reply([
            {"id": "item-0", "used_for": ["Immunity Boost", "Cures Flu", "immunity boost", "<script>"],
             "search_keywords": ["Vitamin C Gummies", "treat colds fast", "vitamin c gummies"]},
            {"id": "item-1", "used_for": ["Prevents Disease"], "search_keywords": ["holiday box"]},
            {"id": "unknown", "used_for": ["Winter Energy"], "search_keywords": ["energy"]},
        ]))
        with patch("agents.daily_catalog_linker.request_enrichment", model):
            summary = self.run_linker(api_key="test")
            catalog = self.read("supplements.json")
            self.assertEqual(catalog[0]["used_for"], ["Immunity Boost"])
            self.assertEqual(catalog[0]["search_keywords"], ["vitamin c gummies"])
            self.assertEqual(catalog[0]["discovery_meta"]["source"], "llm")
            self.assertEqual((catalog[1]["used_for"], catalog[1]["discovery_meta"]["source"]), (["Holiday Gift Box"], "rules"))
            self.assertEqual((summary["llm"], summary["rules"]), (1, 1))
            entry = next(iter(read_ledger(self.root / "data" / "cost_ledger.json")["months"].values()))[0]
            self.assertEqual((entry["state"], Decimal(entry["charged_usd"])), ("settled", Decimal("0.00056")))
            self.assertEqual(model.await_count, 1)
            self.write("supplements.json", [catalog[0]])
            self.run_linker(api_key="test")
            self.assertEqual(model.await_count, 1)
            self.write("supplements.json", [{**catalog[0], "description": "Reviewed again"}])
            self.run_linker(api_key="test")
            self.assertEqual(model.await_count, 2)
            pinned = {**catalog[0], "description": "Edited by a reviewer", "used_for": ["Winter Energy"], "discovery_meta": {"source": "manual"}}
            self.write("supplements.json", [pinned])
            self.run_linker(api_key="test", refresh=True)
            self.assertEqual((model.await_count, self.read("supplements.json")[0]["used_for"]), (2, ["Winter Energy"]))

    def test_monthly_cap_blocks_paid_requests_but_still_rotates(self):
        self.write("supplements.json", [product(0), product(1)])
        spent = {"version": 1, "months": {"2026-11": [{"id": "spent", "state": "settled", "charged_usd": str(Decimal(1000) - RESERVATION)}]}}
        self.write("cost_ledger.json", spent)
        model = AsyncMock()
        with patch("agents.daily_catalog_linker.request_enrichment", model), self.assertLogs("catalog-linker", level="WARNING") as logs:
            summary = self.run_linker(api_key="test")
        self.assertIn("Budget hard-stop", logs.output[0])
        model.assert_not_awaited()
        self.assertEqual(self.read("cost_ledger.json"), spent)
        self.assertEqual((summary["rules"], len(summary["top_picks"])), (2, 2))

    def test_failed_request_keeps_full_reservation_and_invalid_ledger_fails_closed(self):
        self.write("supplements.json", [product(0)])
        with patch("agents.daily_catalog_linker.request_enrichment", AsyncMock(side_effect=OSError("offline"))), \
                self.assertLogs("catalog-linker", level="ERROR"):
            self.assertEqual(self.run_linker(api_key="test")["rules"], 1)
        entry = self.read("cost_ledger.json")["months"]["2026-11"][0]
        self.assertEqual((entry["state"], Decimal(entry["charged_usd"]), entry["agent"]), ("reserved", RESERVATION, "daily_catalog_linker"))
        self.write("supplements.json", [product(1)])
        self.write("cost_ledger.json", {"version": 2})
        with self.assertRaises(FleetError):
            self.run_linker(api_key="test")
        self.assertNotIn("store_links", self.read("supplements.json")[0])


if __name__ == "__main__":
    unittest.main()
