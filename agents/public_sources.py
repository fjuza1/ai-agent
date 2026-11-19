from __future__ import annotations

import json
from urllib.parse import parse_qsl, urlsplit

import aiohttp

from agents.fleet_runner import PublicResolver


MAX_FEED_BYTES = 1_000_000
SENSITIVE_QUERY_KEYS = {
    "access_token", "api_key", "apikey", "auth", "authorization",
    "client_secret", "credential", "password", "secret", "signature", "token",
}


def validate_public_https_url(url: str) -> None:
    parsed = urlsplit(url)
    if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password or parsed.port not in (None, 443):
        raise ValueError("Source URLs must use public HTTPS on port 443.")
    if any(key.casefold() in SENSITIVE_QUERY_KEYS for key, _ in parse_qsl(parsed.query, keep_blank_values=True)):
        raise ValueError("Source URLs must not contain credentials or secret query parameters.")


def public_origin(url: str) -> str:
    parsed = urlsplit(url)
    return f"{parsed.scheme}://{parsed.netloc}"


async def fetch_public_json(url: str) -> object:
    validate_public_https_url(url)
    timeout = aiohttp.ClientTimeout(total=30)
    connector = aiohttp.TCPConnector(limit=2, resolver=PublicResolver())
    async with aiohttp.ClientSession(timeout=timeout, connector=connector, trust_env=False) as session:
        async with session.get(url, allow_redirects=False) as response:
            response.raise_for_status()
            if response.status != 200 or response.content_type not in ("application/json", "text/json"):
                raise ValueError("Trend and discovery feeds must return JSON without redirects.")
            body = await response.content.read(MAX_FEED_BYTES + 1)
            if len(body) > MAX_FEED_BYTES:
                raise ValueError("Feed exceeds one megabyte.")
            return json.loads(body)
