from __future__ import annotations

from datetime import datetime
import json
import math
import re
import sys
from typing import Any
from urllib.parse import parse_qsl, urlsplit


PRESET_NAMES = {
    "Cozy Nordic Holiday",
    "Playful Pop Boutique",
    "Warm Artisan Apothecary",
    "Crisp Modern Wellness",
    "Festive Candy Shop",
}
THEME_KEYS = {
    "name", "bg_primary", "bg_card", "text_primary", "text_muted",
    "accent_primary", "accent_secondary", "text_on_accent", "badge_bg",
    "text_on_badge", "border_color", "radius_card", "shadow_card",
    "font_display", "animation_style",
}
SHADOWS = {
    "0 8px 24px rgba(37, 33, 28, 0.10)",
    "0 8px 24px rgba(41, 27, 42, 0.10)",
    "0 8px 24px rgba(48, 35, 28, 0.10)",
    "0 8px 24px rgba(26, 38, 51, 0.09)",
    "0 8px 24px rgba(57, 22, 36, 0.10)",
}
FONTS = {"Georgia, serif", "Trebuchet MS, sans-serif", "system-ui, sans-serif"}
ANIMATIONS = {
    "cubic-bezier(0.2, 0.8, 0.2, 1)",
    "cubic-bezier(0.34, 1.56, 0.64, 1)",
    "ease-out",
}
SENSITIVE_QUERY_KEYS = {
    "access_token", "api_key", "apikey", "auth", "authorization",
    "client_secret", "credential", "password", "secret", "signature", "token",
}
HEX = re.compile(r"^#[0-9a-fA-F]{6}$")
RADIUS = re.compile(r"^(?:0|[1-9]\d?)px$")


def _record(value: Any) -> bool:
    return isinstance(value, dict)


def _parse_hex(value: str) -> tuple[int, int, int]:
    return tuple(int(value[index:index + 2], 16) for index in (1, 3, 5))


def _luminance(color: str) -> float:
    channels = []
    for channel in _parse_hex(color):
        linear = channel / 255
        channels.append(linear / 12.92 if linear <= 0.04045 else ((linear + 0.055) / 1.055) ** 2.4)
    return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2]


def contrast_ratio(foreground: str, background: str) -> float:
    lighter, darker = sorted((_luminance(foreground), _luminance(background)), reverse=True)
    return (lighter + 0.05) / (darker + 0.05)


def _valid_theme(theme: Any) -> bool:
    if not _record(theme) or set(theme) != THEME_KEYS:
        return False
    if not isinstance(theme["name"], str) or not theme["name"].strip():
        return False
    color_keys = THEME_KEYS - {
        "name", "radius_card", "shadow_card", "font_display", "animation_style",
    }
    if any(not isinstance(theme[key], str) or not HEX.fullmatch(theme[key]) for key in color_keys):
        return False
    radius = theme["radius_card"]
    if not isinstance(radius, str) or not RADIUS.fullmatch(radius) or int(radius[:-2]) > 24:
        return False
    if theme["shadow_card"] not in SHADOWS or theme["font_display"] not in FONTS or theme["animation_style"] not in ANIMATIONS:
        return False

    checks = (
        ("text_primary", "bg_primary"),
        ("text_primary", "bg_card"),
        ("text_muted", "bg_primary"),
        ("text_muted", "bg_card"),
        ("accent_secondary", "bg_primary"),
        ("accent_secondary", "bg_card"),
        ("text_on_accent", "accent_primary"),
        ("text_on_accent", "accent_secondary"),
        ("text_on_badge", "badge_bg"),
    )
    return all(contrast_ratio(theme[text], theme[background]) >= 4.5 for text, background in checks)


def validate_theme_document(value: Any) -> tuple[bool, str]:
    if not _record(value) or set(value) != {"schema_version", "updated_at", "active", "presets", "trend"}:
        return False, "Theme document has missing or unexpected fields."
    if isinstance(value["schema_version"], bool) or value["schema_version"] != 1:
        return False, "Unsupported theme schema version."
    if not isinstance(value["updated_at"], str):
        return False, "updated_at must be an ISO timestamp."
    try:
        datetime.fromisoformat(value["updated_at"].replace("Z", "+00:00"))
    except ValueError:
        return False, "updated_at must be an ISO timestamp."
    if not _valid_theme(value["active"]):
        return False, "Active theme has unsafe values or fails WCAG AA contrast."

    presets = value["presets"]
    if not isinstance(presets, list) or len(presets) != len(PRESET_NAMES):
        return False, "Exactly five theme presets are required."
    names = set()
    for preset in presets:
        if not _record(preset) or set(preset) != {"quality_score", "theme"}:
            return False, "Preset has missing or unexpected fields."
        score = preset["quality_score"]
        if not isinstance(score, (int, float)) or isinstance(score, bool) or not 0 <= score <= 1:
            return False, "Preset quality_score must be between zero and one."
        if not _valid_theme(preset["theme"]):
            return False, "Preset theme has unsafe values or fails WCAG AA contrast."
        names.add(preset["theme"]["name"])
    if names != PRESET_NAMES:
        return False, "Preset names must match the five supported presets exactly."

    trend = value["trend"]
    if not _record(trend) or set(trend) != {"signal_status", "provider", "observed_at", "summary", "sources", "observations"}:
        return False, "Trend metadata has missing or unexpected fields."
    if trend["signal_status"] not in {"fallback", "feed_observed", "llm_synthesized", "feed_unavailable"}:
        return False, "Invalid trend signal status."
    if not isinstance(trend["provider"], str) or not isinstance(trend["summary"], str):
        return False, "Trend provider and summary must be strings."
    if not isinstance(trend["observed_at"], str):
        return False, "Trend observed_at must be an ISO timestamp."
    try:
        datetime.fromisoformat(trend["observed_at"].replace("Z", "+00:00"))
    except ValueError:
        return False, "Trend observed_at must be an ISO timestamp."
    if not isinstance(trend["sources"], list):
        return False, "Trend sources must be an array."
    for source in trend["sources"]:
        if not isinstance(source, str):
            return False, "Trend source URLs must be strings."
        parsed = urlsplit(source)
        if (parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password or
                any(key.casefold() in SENSITIVE_QUERY_KEYS for key, _ in parse_qsl(parsed.query, keep_blank_values=True))):
            return False, "Trend sources must be public HTTPS URLs."
    observations = trend["observations"]
    if not isinstance(observations, list) or len(observations) > 10:
        return False, "Trend observations must contain at most ten shops."
    for observation in observations:
        if not _record(observation) or set(observation) != {"shop", "domain", "aesthetic", "rank", "visits"}:
            return False, "Trend observation has missing or unexpected fields."
        if not all(isinstance(observation[key], str) for key in ("shop", "domain", "aesthetic")):
            return False, "Trend shop, domain, and aesthetic values must be strings."
        rank = observation["rank"]
        visits = observation["visits"]
        if (rank is not None and (not isinstance(rank, int) or isinstance(rank, bool) or rank < 1) or
                visits is not None and (not isinstance(visits, (int, float)) or isinstance(visits, bool) or not math.isfinite(visits) or visits < 0)):
            return False, "Trend rank and visit metrics must be nonnegative numeric values."
        if not observation["shop"].strip() and not observation["domain"].strip():
            return False, "Trend observations need a shop name or domain."
    return True, ""


def validate_theme_or_raise(value: Any) -> None:
    valid, error = validate_theme_document(value)
    if not valid:
        raise ValueError(error)


def main() -> int:
    path = sys.argv[1] if len(sys.argv) > 1 else "data/daily_visual_theme.json"
    try:
        with open(path, encoding="utf-8") as source:
            document = json.load(source)
        validate_theme_or_raise(document)
    except (OSError, json.JSONDecodeError, ValueError) as error:
        print(f"Invalid visual theme: {error}", file=sys.stderr)
        return 1
    print(f"Valid visual theme: {path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
