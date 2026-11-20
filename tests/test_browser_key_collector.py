from contextlib import redirect_stdout
import io
import socket
import tempfile
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, patch

from agents.browser_key_collector import (
    DASHBOARDS,
    PublicConfiguration,
    check_local_model,
    collect,
    inspect_dashboard,
    local_model,
    main,
    update_env_file,
    validated_values,
)


class BrowserKeyCollectorTests(unittest.TestCase):
    def test_only_allowlisted_public_values_are_accepted(self):
        stripe = next(dashboard for dashboard in DASHBOARDS if dashboard.name == "Stripe")
        result = PublicConfiguration(
            manual_verification_needed=False,
            stripe_publishable_key="sk_live_not_public",
        )

        values, rejected = validated_values(result, stripe)

        self.assertEqual(values, {})
        self.assertEqual(rejected, ["STRIPE_PUBLISHABLE_KEY"])

        result.stripe_publishable_key = "pk_test_1234567890abcdef"
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

    def test_unreachable_local_model_has_actionable_error(self):
        with patch(
            "agents.browser_key_collector.socket.create_connection",
            side_effect=socket.timeout("private data"),
        ):
            with self.assertRaisesRegex(RuntimeError, "local model endpoint is unreachable") as error:
                check_local_model("http://127.0.0.1:1234/v1")
        self.assertNotIn("private data", str(error.exception))

    def test_cli_prints_only_variable_names(self):
        public_value = "pk_live_1234567890abcdef"
        with tempfile.TemporaryDirectory() as directory:
            output = io.StringIO()
            def fake_run(coroutine):
                coroutine.close()
                return {"STRIPE_PUBLISHABLE_KEY": public_value}, []

            with (
                patch("agents.browser_key_collector.ENV_PATH", Path(directory) / ".env.local"),
                patch("agents.browser_key_collector.asyncio.run", side_effect=fake_run),
                redirect_stdout(output),
            ):
                status = main()

            self.assertEqual(status, 0)
            self.assertIn("STRIPE_PUBLISHABLE_KEY", output.getvalue())
            self.assertNotIn(public_value, output.getvalue())


class DashboardInspectionTests(unittest.IsolatedAsyncioTestCase):
    async def test_agent_error_reports_status_without_exposing_details(self):
        history = SimpleNamespace(
            structured_output=None, status="error", error="SENSITIVE_ERROR_SENTINEL"
        )
        with patch("agents.browser_key_collector.Agent") as agent:
            agent.return_value.run = AsyncMock(return_value=history)
            with self.assertRaisesRegex(RuntimeError, "status error") as error:
                await inspect_dashboard(None, None, DASHBOARDS[0])
        self.assertNotIn("SENSITIVE_ERROR_SENTINEL", str(error.exception))

    async def test_unreachable_model_stops_before_opening_browser(self):
        with (
            patch("agents.browser_key_collector.Browser") as browser,
            patch(
                "agents.browser_key_collector.socket.create_connection",
                side_effect=ConnectionRefusedError(),
            ),
        ):
            with self.assertRaisesRegex(RuntimeError, "local model endpoint is unreachable"):
                await collect()
        browser.assert_not_called()


if __name__ == "__main__":
    unittest.main()
