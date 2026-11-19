from copy import deepcopy
import json
from pathlib import Path
import unittest

from agents.theme_schema import contrast_ratio, validate_theme_document

ROOT = Path(__file__).resolve().parents[1]


class ThemeSchemaTests(unittest.TestCase):
    def setUp(self):
        self.document = json.loads((ROOT / "data" / "daily_visual_theme.json").read_text(encoding="utf-8"))

    def test_all_five_presets_and_active_theme_pass_wcag_aa(self):
        valid, reason = validate_theme_document(self.document)
        self.assertTrue(valid, reason)
        self.assertEqual(len(self.document["presets"]), 5)
        for item in self.document["presets"]:
            self.assertGreaterEqual(
                contrast_ratio(item["theme"]["text_primary"], item["theme"]["bg_card"]),
                4.5,
            )

    def test_invalid_contrast_and_unsafe_radius_are_rejected(self):
        low_contrast = deepcopy(self.document)
        low_contrast["active"]["text_primary"] = "#FFFFFF"
        valid, _ = validate_theme_document(low_contrast)
        self.assertFalse(valid)

        unsafe_radius = deepcopy(self.document)
        unsafe_radius["active"]["radius_card"] = "999px"
        valid, _ = validate_theme_document(unsafe_radius)
        self.assertFalse(valid)

    def test_unrecognized_theme_fields_and_missing_presets_fail_closed(self):
        extra_field = deepcopy(self.document)
        extra_field["active"]["background_image"] = "url(https://example.com)"
        self.assertFalse(validate_theme_document(extra_field)[0])

        missing_preset = deepcopy(self.document)
        missing_preset["presets"].pop()
        self.assertFalse(validate_theme_document(missing_preset)[0])

    def test_trend_observations_reject_invalid_ranks_and_visit_metrics(self):
        invalid = deepcopy(self.document)
        invalid["trend"]["observations"] = [{
            "shop": "Shop",
            "domain": "shop.example",
            "aesthetic": "playful",
            "rank": 0,
            "visits": 100,
        }]
        self.assertFalse(validate_theme_document(invalid)[0])

        invalid["trend"]["observations"][0]["rank"] = 1
        invalid["trend"]["observations"][0]["visits"] = float("nan")
        self.assertFalse(validate_theme_document(invalid)[0])


if __name__ == "__main__":
    unittest.main()
