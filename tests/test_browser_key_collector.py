import tempfile
from pathlib import Path
import unittest

from agents.browser_key_collector import (
    DASHBOARDS,
    PublicConfiguration,
    local_model,
    update_env_file,
    validated_values,
)


class BrowserKeyCollectorTests(unittest.TestCase):
    def test_only_allowlisted_public_values_are_accepted(self):
        stripe = next(dashboard for dashboard in DASHBOARDS if dashboard.name == "Stripe")
        result = PublicConfiguration(
            manual_verification_needed=False,
            stripe_publishable_key="pk_test_1234567890abcdef",
            openai_project_id="sk-not-a-public-project-key",
        )

        values, rejected = validated_values(result, stripe)

        self.assertEqual(values, {"STRIPE_PUBLISHABLE_KEY": "pk_test_1234567890abcdef"})
        self.assertEqual(rejected, [])

    def test_env_update_preserves_other_entries_and_never_accepts_secret_key(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / ".env.local"
            path.write_text("# local config\nEXISTING=value\n", encoding="utf-8")

            updated = update_env_file(
                path, {"ADSENSE_CLIENT_ID": "ca-pub-1234567890123456"}
            )

            self.assertEqual(updated, ["ADSENSE_CLIENT_ID"])
            self.assertEqual(
                path.read_text(encoding="utf-8"),
                "# local config\nEXISTING=value\nADSENSE_CLIENT_ID=ca-pub-1234567890123456\n",
            )
            with self.assertRaisesRegex(ValueError, "STRIPE_SECRET_KEY"):
                update_env_file(path, {"STRIPE_SECRET_KEY": "sk_live_not_public"})
            self.assertNotIn("sk_live_not_public", path.read_text(encoding="utf-8"))

    def test_remote_model_endpoint_is_rejected(self):
        with self.assertRaisesRegex(ValueError, "loopback"):
            local_model("https://api.example.com/v1", "model")


if __name__ == "__main__":
    unittest.main()
