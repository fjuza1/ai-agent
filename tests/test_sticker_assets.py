import hashlib
import json
from pathlib import Path
import unittest

from PIL import Image

ROOT = Path(__file__).resolve().parents[1]


class StickerAssetsTests(unittest.TestCase):
    def test_exact_catalog_and_distinct_high_resolution_pngs(self):
        catalog = json.loads((ROOT / "data" / "stickers_catalog.json").read_text(encoding="utf-8"))
        self.assertEqual(len(catalog), 50)
        self.assertEqual(len({entry["id"] for entry in catalog}), 50)
        self.assertEqual(len({entry["theme"] for entry in catalog}), 6)
        self.assertTrue(all(entry["theme"] == "Baby Announcement & Milestone" for entry in catalog[40:]))
        hashes = set()
        for index, entry in enumerate(catalog, 1):
            self.assertEqual(entry["image"], f"/stickers/sticker-{index:02}.png")
            file = ROOT / "apps" / "sticker-market" / "public" / entry["image"].lstrip("/")
            with Image.open(file) as image:
                self.assertEqual((image.format, image.size), ("PNG", (1024, 1024)))
            hashes.add(hashlib.sha256(file.read_bytes()).digest())
        self.assertEqual(len(hashes), 50)
        legacy = json.loads((ROOT / "data" / "legacy_stickers_catalog.json").read_text(encoding="utf-8"))
        self.assertEqual(len(legacy), 18)
        for entry in legacy:
            path = ROOT / "apps" / "sticker-market" / "public" / entry["image"].lstrip("/")
            with Image.open(path) as image:
                self.assertEqual((image.format, image.size), ("PNG", (1024, 1024)))


if __name__ == "__main__":
    unittest.main()
