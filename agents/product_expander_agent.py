from __future__ import annotations

import argparse
import asyncio
from datetime import datetime, timezone
from io import BytesIO
import json
import logging
import os
from pathlib import Path
import re
import sys

import aiohttp
from dotenv import load_dotenv
from PIL import Image, UnidentifiedImageError

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from agents.public_sources import fetch_public_json, public_origin, validate_public_https_url
from agents.fleet_runner import ROOT, PublicResolver

LOG = logging.getLogger("product-expander")
OUTPUT_PATH = ROOT / "data" / "product_candidate_drafts.json"
MAX_CANDIDATES = 100
MAX_IMAGE_BYTES = 5_000_000
Image.MAX_IMAGE_PIXELS = 20_000_000


def utc_now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def normalized(value: object) -> str:
    return re.sub(r"[^a-z0-9]+", " ", str(value).casefold()).strip()


def feed_items(value: object) -> list[object]:
    if isinstance(value, list):
        return value[:MAX_CANDIDATES]
    if isinstance(value, dict):
        for key in ("products", "candidates", "items", "results"):
            if isinstance(value.get(key), list):
                return value[key][:MAX_CANDIDATES]
    raise ValueError("Product discovery feed must contain a products, candidates, items, or results array.")


async def image_dimensions(url: str) -> tuple[int, int]:
    validate_public_https_url(url)
    timeout = aiohttp.ClientTimeout(total=30)
    connector = aiohttp.TCPConnector(limit=2, resolver=PublicResolver())
    async with aiohttp.ClientSession(timeout=timeout, connector=connector, trust_env=False) as session:
        async with session.get(url, allow_redirects=False) as response:
            response.raise_for_status()
            if response.status != 200 or response.content_type not in {"image/jpeg", "image/png", "image/webp"}:
                raise ValueError("Product image must be a direct JPEG, PNG, or WebP response.")
            data = await response.content.read(MAX_IMAGE_BYTES + 1)
            if len(data) > MAX_IMAGE_BYTES:
                raise ValueError("Product image exceeds five megabytes.")
    try:
        with Image.open(BytesIO(data)) as image:
            if image.format not in {"JPEG", "PNG", "WEBP"}:
                raise ValueError("Product image format is not supported.")
            width, height = image.size
            if not 1 <= width <= 12_000 or not 1 <= height <= 12_000:
                raise ValueError("Product image dimensions are outside the accepted range.")
            image.verify()
            return width, height
    except (UnidentifiedImageError, OSError, Image.DecompressionBombError) as error:
        raise ValueError("Product image is invalid or unsafe.") from error


def check_product_claims(item: object) -> tuple[dict | None, str]:
    if not isinstance(item, dict):
        return None, "candidate is not an object"
    for key in ("id", "name", "description", "origin_country", "verified_usa_manufacturing",
                "verification_source", "image_url", "categories"):
        if key not in item:
            return None, f"missing {key}"
    if not isinstance(item["name"], str) or not item["name"].strip():
        return None, "empty product title"
    if not isinstance(item["description"], str) or not item["description"].strip():
        return None, "empty product description"
    if item["origin_country"] != "USA" or item["verified_usa_manufacturing"] is not True:
        return None, "source claims do not satisfy USA-origin and manufacturing gates"
    if not isinstance(item["id"], str) or not re.fullmatch(r"[a-z0-9-]{1,80}", item["id"]):
        return None, "invalid product ID"
    price = item.get("price_cents")
    if not isinstance(price, int) or isinstance(price, bool) or not 50 <= price <= 1_000_000:
        return None, "invalid product price"
    if not isinstance(item["categories"], list) or not item["categories"] or not all(isinstance(value, str) for value in item["categories"]):
        return None, "invalid product categories"
    accepted_categories = {"holiday gift bundles", "family planning bundles"}
    if not any(normalized(category) in accepted_categories for category in item["categories"]):
        return None, "candidate is outside holiday bundles and family planning"
    pregnancy_test = (
        any(normalized(category) == "family planning bundles" for category in item["categories"]) and
        any(term in normalized(item["name"]) for term in ("pregnancy", "pregnant", "am i pregnant", "pregnancy test"))
    )
    if pregnancy_test and type(item.get("fda_cleared_otc")) is not bool:
        return None, "pregnancy-test candidates require an explicit FDA OTC clearance flag"
    try:
        source_url = item.get("source_url", item["verification_source"])
        for field in ("verification_source", "image_url"):
            validate_public_https_url(item[field])
        validate_public_https_url(source_url)
        purchase_url = item.get("affiliate_url") or item.get("checkout_url")
        if not isinstance(purchase_url, str):
            return None, "missing affiliate or checkout URL"
        validate_public_https_url(purchase_url)
        if "affiliate_type" in item and item["affiliate_type"] not in {"amazon", "direct"}:
            return None, "invalid affiliate type"
        if "fda_cleared_otc" in item and type(item["fda_cleared_otc"]) is not bool:
            return None, "invalid FDA OTC clearance flag"
        if item.get("fda_cleared_otc") is True:
            if "family-planning-bundles" not in item["categories"]:
                return None, "FDA-cleared pregnancy tests must use the family-planning category"
            if item.get("fda_device_type") != "pregnancy_test" or not isinstance(item.get("fda_device_name"), str) or not item["fda_device_name"].strip():
                return None, "FDA-cleared pregnancy tests need an exact device name and type"
            validate_public_https_url(item.get("fda_clearance_source", ""))
            if "fda_510k_number" in item and not re.fullmatch(r"K\d{6}", str(item["fda_510k_number"])):
                return None, "invalid FDA 510(k) number"
    except (ValueError, TypeError):
        return None, "invalid HTTPS verification, image, affiliate, or checkout URL"

    return {
        "id": str(item["id"])[:80],
        "sku": str(item.get("sku", ""))[:100],
        "name": item["name"].strip()[:200],
        "description": item["description"].strip()[:2000],
        "price_cents": price,
        "origin_country_claim": item["origin_country"],
        "verified_usa_manufacturing_claim": True,
        "verification_source": item["verification_source"],
        "source_url": source_url,
        "image_url": item["image_url"],
        "affiliate_url": item.get("affiliate_url"),
        "checkout_url": item.get("checkout_url"),
        "affiliate_type": item.get("affiliate_type"),
        "categories": item["categories"][:20],
        "goals": item.get("goals", [])[:20] if isinstance(item.get("goals", []), list) else [],
        "fda_cleared_otc_claim": item.get("fda_cleared_otc") is True,
        "fda_device_type": item.get("fda_device_type") if isinstance(item.get("fda_device_type"), str) else None,
        "fda_device_name": item.get("fda_device_name") if isinstance(item.get("fda_device_name"), str) else None,
        "fda_clearance_source": item.get("fda_clearance_source") if isinstance(item.get("fda_clearance_source"), str) else None,
        "fda_510k_number": item.get("fda_510k_number") if isinstance(item.get("fda_510k_number"), str) else None,
        "review_status": "draft",
        "verified_usa_manufacturing": False,
        "requires_human_manufacturing_and_claim_review": True,
    }, ""


def load_catalog() -> list[dict]:
    configured = os.getenv("SUPPLEMENT_CATALOG_PATH", "").strip()
    path = Path(configured).resolve() if configured else ROOT / "data" / "supplements.json"
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, list) or not all(isinstance(item, dict) for item in value):
        raise ValueError("Published supplement catalog must be a JSON array of products.")
    return value


async def expand(feed_url: str) -> dict:
    feed = await fetch_public_json(feed_url)
    items = feed_items(feed)
    catalog = load_catalog()
    known_ids = {normalized(item.get("id")) for item in catalog}
    known_skus = {normalized(item.get("sku")) for item in catalog if item.get("sku")}
    known_titles = {normalized(item.get("name")) for item in catalog}
    draft_ids: set[str] = set()
    draft_skus: set[str] = set()
    draft_titles: set[str] = set()
    candidates = []
    rejected = []

    for item in items:
        draft, reason = check_product_claims(item)
        if draft is None:
            rejected.append({"name": str(item.get("name", ""))[:120] if isinstance(item, dict) else "", "reason": reason})
            continue
        product_id = normalized(draft["id"])
        sku = normalized(draft["sku"])
        title = normalized(draft["name"])
        if product_id in known_ids or (sku and sku in known_skus) or title in known_titles:
            rejected.append({"name": draft["name"], "reason": "duplicate SKU, ID, or normalized title"})
            continue
        if product_id in draft_ids or (sku and sku in draft_skus) or title in draft_titles:
            rejected.append({"name": draft["name"], "reason": "duplicate within the current feed"})
            continue
        try:
            width, height = await image_dimensions(draft["image_url"])
        except (aiohttp.ClientError, OSError, ValueError) as error:
            rejected.append({"name": draft["name"], "reason": str(error)[:200]})
            continue
        draft["image_width"] = width
        draft["image_height"] = height
        candidates.append(draft)
        draft_ids.add(product_id)
        if sku:
            draft_skus.add(sku)
        draft_titles.add(title)

    return {
        "schema_version": 1,
        "updated_at": utc_now(),
        "source_feed": public_origin(feed_url),
        "candidates": candidates,
        "rejected": rejected[:MAX_CANDIDATES],
    }


def atomic_write(value: object) -> None:
    temp = OUTPUT_PATH.with_suffix(OUTPUT_PATH.suffix + ".tmp")
    with temp.open("w", encoding="utf-8", newline="\n") as stream:
        json.dump(value, stream, indent=2, ensure_ascii=True)
        stream.write("\n")
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(temp, OUTPUT_PATH)


async def main_async() -> int:
    feed_url = os.getenv("PRODUCT_DISCOVERY_FEED_URL", "").strip()
    if not feed_url:
        LOG.info("No PRODUCT_DISCOVERY_FEED_URL configured; preserving the existing candidate drafts.")
        return 0
    document = await expand(feed_url)
    atomic_write(document)
    LOG.info(
        "Saved %d unapproved product candidates; rejected %d. Published catalog was not changed.",
        len(document["candidates"]),
        len(document["rejected"]),
    )
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="Discover product candidates without modifying the approved catalog.")
    parser.parse_args()
    load_dotenv(ROOT / ".env")
    try:
        return asyncio.run(main_async())
    except (aiohttp.ClientError, OSError, ValueError, TypeError) as error:
        LOG.error("%s: %s", type(error).__name__, error)
        return 1


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(levelname)s: %(message)s")
    sys.exit(main())
