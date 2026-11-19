import asyncio
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import AsyncMock, patch

from agents import daily_trend_ui_agent as theme_agent

ROOT = Path(__file__).resolve().parents[1]


class DailyThemeAgentTests(unittest.TestCase):
    def test_records_top_shop_metrics_and_uses_trend_keywords(self):
        document = json.loads((ROOT / "data" / "daily_visual_theme.json").read_text(encoding="utf-8"))
        signals = theme_agent.read_signals({
            "shops": [{
                "name": "Bright Gift Shop",
                "domain": "bright.example",
                "aesthetic": "playful pink boutique",
                "rank": 2,
                "monthly_visits": 123456,
            }]
        })
        self.assertEqual(signals[0]["rank"], 2)
        self.assertEqual(signals[0]["visits"], 123456)
        self.assertEqual(theme_agent.select_preset(document, signals)["name"], "Playful Pop Boutique")
        self.assertEqual(theme_agent.observations(signals)[0]["domain"], "bright.example")

    def test_update_tracks_observed_feed_without_leaking_query_credentials(self):
        source = json.loads((ROOT / "data" / "daily_visual_theme.json").read_text(encoding="utf-8"))
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "theme.json"
            path.write_text(json.dumps(source), encoding="utf-8")
            feed = {"shops": [{
                "name": "Bright Gift Shop",
                "domain": "bright.example",
                "aesthetic": "playful pink boutique",
                "rank": 2,
                "monthly_visits": 123456,
            }]}
            with patch.object(theme_agent, "THEME_PATH", path), \
                    patch.object(theme_agent, "fetch_public_json", new=AsyncMock(return_value=feed)), \
                    patch.object(theme_agent, "write_theme_assets"), \
                    patch.dict("os.environ", {"TREND_FEED_URL": "https://feed.example/rank?api_key=hidden", "LLM_API_KEY": ""}):
                self.assertEqual(asyncio.run(theme_agent.main_async()), 0)
            updated = json.loads(path.read_text(encoding="utf-8"))

        self.assertEqual(updated["active"]["name"], "Playful Pop Boutique")
        self.assertEqual(updated["trend"]["signal_status"], "feed_observed")
        self.assertEqual(updated["trend"]["observations"][0]["rank"], 2)
        self.assertEqual(updated["trend"]["sources"], ["https://feed.example"])
        self.assertNotIn("hidden", json.dumps(updated))


if __name__ == "__main__":
    unittest.main()
