import asyncio
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import AsyncMock, patch

from agents import product_expander_agent as expander


def product(**patches):
    value = {
        "id": "holiday-bundle",
        "name": "Reviewed Holiday Bundle",
        "description": "A seasonal gift bundle with a complete product description.",
        "price_cents": 2500,
        "origin_country": "USA",
        "verified_usa_manufacturing": True,
        "verification_source": "https://maker.example/evidence",
        "source_url": "https://maker.example/product",
        "image_url": "https://maker.example/product.png",
        "affiliate_url": "https://shop.example/product",
        "categories": ["Holiday Gift Bundles"],
        "goals": ["Winter Wellness"],
    }
    value.update(patches)
    return value


class ProductExpanderTests(unittest.TestCase):
    def test_candidate_claims_require_all_gate_fields_and_remain_unapproved(self):
        accepted, reason = expander.check_product_claims(product())
        self.assertEqual(reason, "")
        self.assertEqual(accepted["review_status"], "draft")
        self.assertFalse(accepted["verified_usa_manufacturing"])
        self.assertTrue(accepted["requires_human_manufacturing_and_claim_review"])

        for bad in (
            product(verified_usa_manufacturing=False),
            product(origin_country="Canada"),
            product(description=" "),
            product(affiliate_url="http://shop.example/product"),
            product(categories=["Energy"]),
            product(price_cents=True),
        ):
            with self.subTest(candidate=bad):
                self.assertIsNone(expander.check_product_claims(bad)[0])

    def test_expander_checks_catalog_and_normalized_feed_duplicates(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "data").mkdir()
            (root / "data" / "supplements.json").write_text("[]", encoding="utf-8")
            feed = [product(), product(id="same-title", name="Reviewed Holiday Bundle!")]
            with patch.object(expander, "ROOT", root), \
                    patch.object(expander, "fetch_public_json", new=AsyncMock(return_value=feed)), \
                    patch.object(expander, "image_dimensions", new=AsyncMock(return_value=(800, 600))):
                result = asyncio.run(expander.expand("https://feed.example/products.json"))

        self.assertEqual(len(result["candidates"]), 1)
        self.assertEqual(result["candidates"][0]["image_width"], 800)
        self.assertIn("duplicate within the current feed", result["rejected"][0]["reason"])


if __name__ == "__main__":
    unittest.main()
