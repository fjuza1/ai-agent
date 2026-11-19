#!/usr/bin/env python3
"""Persistent, stateful Bug-Hunter & Defect Audit agent.

Scans the monorepo for defects, tracks them across sessions in
``data/qa_session_state.json`` and writes a severity-ordered ``BUG_REPORT.md``.

* Only files whose SHA-256 changed since the last session are rescanned (``--full-scan`` rescans all).
* Deterministic rules cover auth/privacy, Stripe/billing, Prisma/SQLite races, cron/email timing,
  the USA-origin filter, SEO/links/JSON-LD and Python async/budget guardrails.
* ``npx tsc --noEmit``, ``npx prisma validate`` and ``python -m py_compile`` are executed and their
  errors become defects.
* ``--llm`` adds an LLM code review. Every request is reserved in ``data/cost_ledger.json`` before it
  is sent and the run aborts before the monthly budget (default and maximum $1000) is reached.
* ``--auto-fix`` patches deterministic bugs and keeps a patch only if the compiler check still passes.
"""
from __future__ import annotations

import argparse
import ast
import hashlib
import json
import logging
import math
import os
from pathlib import Path
import posixpath
import re
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation
from uuid import uuid4

ROOT = Path(__file__).resolve().parents[1]
LOG = logging.getLogger("bug-hunter")

STATE_VERSION = 1
STATE_PATH = Path("data") / "qa_session_state.json"
REPORT_PATH = Path("BUG_REPORT.md")
LEDGER_PATH = Path("data") / "cost_ledger.json"
SEVERITIES = ("CRITICAL", "HIGH", "MEDIUM", "LOW")
MAX_RESOLVED_HISTORY = 500

CAT_AUTH = "Auth/Security"
CAT_BILLING = "Stripe/Billing"
CAT_PRISMA = "SQLite/Prisma Race Conditions"
CAT_CRON = "Cron/Email Timing"
CAT_USA = "USA Origin Filter Bypass"
CAT_SEO = "SEO/Broken Links"
CAT_PY = "Python Async/Budget Guardrails"
CAT_BUILD = "Build/Compiler/Schema"
CAT_DATA = "Reliability/Data Integrity"
CATEGORIES = (CAT_AUTH, CAT_BILLING, CAT_PRISMA, CAT_CRON, CAT_USA, CAT_SEO, CAT_PY, CAT_BUILD, CAT_DATA)

SCAN_EXTENSIONS = {".ts", ".tsx", ".py", ".json", ".yml", ".yaml", ".js", ".jsx", ".mjs", ".cjs", ".prisma", ".sql"}
JS_EXTS = {".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx"}
SKIP_DIRS = {"node_modules", ".git", ".next", ".venv", "venv", "__pycache__", "reports", "dist", "build", "coverage", ".turbo", "generated"}
SKIP_FILES = {"package-lock.json", "qa_session_state.json"}
SELF = "agents/bug_hunter_agent.py"

# LLM pricing mirrors agents/fleet_runner.py so ledger entries stay comparable.
MODEL = "gpt-4.1-mini-2025-04-14"
INPUT_RATE = Decimal("0.40") / 1_000_000
OUTPUT_RATE = Decimal("1.60") / 1_000_000
MAX_OUTPUT_TOKENS = 1500
MAX_LLM_FILE_BYTES = 60_000
HARD_BUDGET_CAP = Decimal("1000")


def utc_now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def atomic_write_text(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_suffix(path.suffix + ".tmp")
    with temp.open("w", encoding="utf-8", newline="\n") as stream:
        stream.write(text)
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(temp, path)


def atomic_write_json(path: Path, value: object) -> None:
    atomic_write_text(path, json.dumps(value, indent=2, ensure_ascii=True, sort_keys=False) + "\n")


# --------------------------------------------------------------------------------------------
# Source files and findings
# --------------------------------------------------------------------------------------------

class SourceFile:
    def __init__(self, rel: str, text: str) -> None:
        self.rel = rel
        self.text = text
        self.lines = text.split("\n")
        self.ext = Path(rel).suffix.lower()
        self.name = posixpath.basename(rel)
        self.is_test = bool(re.search(r"(^|/)(tests?|__tests__)/|\.(test|spec)\.|(^|/)test_[^/]*\.py$", rel))
        parts = rel.split("/")
        self.app = parts[1] if len(parts) > 2 and parts[0] == "apps" else None

    def line_of(self, offset: int) -> int:
        return self.text.count("\n", 0, offset) + 1

    def code_lines(self):
        """Yields (line_number, text) skipping comment-only lines."""
        for number, line in enumerate(self.lines, 1):
            stripped = line.strip()
            if not stripped:
                continue
            if self.ext == ".py" and stripped.startswith("#"):
                continue
            if self.ext in JS_EXTS and stripped.startswith(("//", "/*", "*")):
                continue
            yield number, line


def clip(text: str, limit: int = 160) -> str:
    text = re.sub(r"\s+", " ", text).strip()
    return text if len(text) <= limit else text[: limit - 3] + "..."


def finding(rule: str, severity: str, category: str, sf_rel: str, line: int, title: str, detail: str,
            snippet: str = "", key: str | None = None, fix: dict | None = None,
            scope: str = "file", tool: str = "") -> dict:
    assert severity in SEVERITIES and category in CATEGORIES, (rule, severity, category)
    result = {
        "rule": rule, "severity": severity, "category": category, "file": sf_rel, "line": max(1, int(line)),
        "title": title, "detail": detail, "snippet": clip(snippet), "scope": scope, "tool": tool,
        "_key": key if key is not None else clip(snippet, 400),
    }
    if fix:
        result["_fix"] = fix
    return result


def assign_ids(findings: list[dict]) -> list[dict]:
    """Stable IDs: rule + file + normalised evidence (not the line number) + occurrence index."""
    seen: dict[tuple, int] = {}
    for item in findings:
        basis = (item["rule"], item["file"], item.get("_key", ""))
        index = seen.get(basis, 0)
        seen[basis] = index + 1
        digest = sha256_bytes("|".join((*basis, str(index))).encode("utf-8"))[:8].upper()
        item["id"] = f"BUG-{digest}"
    return findings


class Context:
    def __init__(self, root: Path) -> None:
        self.root = root
        self.routes: dict[str, list[re.Pattern]] = {}
        self.public: dict[str, set[str]] = {}
        self.route_fingerprints: dict[str, str] = {}
        self.budget_limit = HARD_BUDGET_CAP
        self._load_routes()

    def _load_routes(self) -> None:
        apps = self.root / "apps"
        if not apps.is_dir():
            return
        for app_dir in sorted(p for p in apps.iterdir() if p.is_dir()):
            app_root = app_dir / "app"
            if not app_root.is_dir():
                continue
            static: set[str] = set()
            patterns: list[re.Pattern] = []
            labels: list[str] = []
            for current, dirs, files in os.walk(app_root):
                dirs[:] = sorted(d for d in dirs if d not in SKIP_DIRS)
                rel_dir = Path(current).relative_to(app_root).as_posix()
                segments = [] if rel_dir == "." else [s for s in rel_dir.split("/") if not (s.startswith("(") or s.startswith("@"))]
                for name in sorted(files):
                    base = name.rsplit(".", 1)[0]
                    if base in ("page", "route") and name.rsplit(".", 1)[-1] in ("js", "jsx", "ts", "tsx"):
                        route = "/" + "/".join(segments)
                    elif base == "robots":
                        route = "/robots.txt"
                    elif base == "sitemap":
                        route = "/sitemap.xml"
                    elif base in ("icon", "apple-icon", "favicon", "opengraph-image", "twitter-image"):
                        route = "/" + name
                    else:
                        continue
                    labels.append(route)
                    regex = "".join(
                        "" if not seg else
                        r"(?:/.+)?" if re.fullmatch(r"\[\[\.\.\..+\]\]", seg) else
                        r"/.+" if re.fullmatch(r"\[\.\.\..+\]", seg) else
                        r"/[^/]+" if re.fullmatch(r"\[.+\]", seg) else "/" + re.escape(seg)
                        for seg in route.split("/")
                    ) or "/"
                    patterns.append(re.compile(rf"^{regex}$"))
                    static.add(route)
            public = set()
            public_dir = app_dir / "public"
            if public_dir.is_dir():
                for current, dirs, files in os.walk(public_dir):
                    dirs[:] = sorted(dirs)
                    for name in files:
                        public.add("/" + (Path(current) / name).relative_to(public_dir).as_posix())
            self.routes[app_dir.name] = patterns
            self.public[app_dir.name] = public
            self.route_fingerprints[app_dir.name] = sha256_bytes("\n".join(sorted(labels) + ["--"] + sorted(public)).encode("utf-8"))

    def route_exists(self, app: str, path: str) -> bool:
        if path in self.public.get(app, set()):
            return True
        return any(p.match(path) for p in self.routes.get(app, []))


# --------------------------------------------------------------------------------------------
# Deterministic rules
# --------------------------------------------------------------------------------------------

MOJIBAKE_RUN = re.compile("[\u00c2-\u00f4][\u0080-\u00bf\u0152-\u02dc\u2013-\u203a\u20ac\u2122\u0161\u017e\u0178\u0192]+")


def repair_mojibake(run: str) -> str | None:
    try:
        fixed = run.encode("cp1252").decode("utf-8")
    except (UnicodeEncodeError, UnicodeDecodeError):
        return None
    return fixed if fixed != run else None


def rule_mojibake(sf: SourceFile, ctx: Context) -> list[dict]:
    out = []
    for number, line in enumerate(sf.lines, 1):
        for match in MOJIBAKE_RUN.finditer(line):
            fixed = repair_mojibake(match.group(0))
            if fixed:
                out.append(finding(
                    "ENC-MOJIBAKE", "MEDIUM", CAT_SEO, sf.rel, number, "Mojibake (UTF-8 decoded as Windows-1252)",
                    f"Text `{match.group(0)}` should be `{fixed}`. It renders as garbled characters to users and in search snippets; "
                    "the file was saved after being re-decoded with the wrong codec.",
                    line, key=match.group(0), fix={"kind": "replace", "line": number, "old": match.group(0), "new": fixed}))
    return out


SECRET_PATTERNS = (
    ("Stripe live secret key", "CRITICAL", re.compile(r"\b[sr]k_live_[0-9A-Za-z]{16,}")),
    ("Stripe test secret key", "HIGH", re.compile(r"\b[sr]k_test_[0-9A-Za-z]{16,}")),
    ("Stripe webhook signing secret", "CRITICAL", re.compile(r"\bwhsec_[0-9A-Za-z]{16,}")),
    ("AWS access key id", "CRITICAL", re.compile(r"\bAKIA[0-9A-Z]{16}\b")),
    ("SendGrid API key", "CRITICAL", re.compile(r"\bSG\.[\w-]{16,}\.[\w-]{16,}")),
    ("GitHub token", "CRITICAL", re.compile(r"\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})")),
    ("OpenAI-style API key", "CRITICAL", re.compile(r"\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}")),
    ("Resend API key", "CRITICAL", re.compile(r"\bre_[A-Za-z0-9]{24,}\b")),
    ("Private key block", "CRITICAL", re.compile(r"-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----")),
)
GENERIC_SECRET = re.compile(r"""(?i)\b[\w.-]*(?:api[_-]?key|secret|token|passwd|password)[\w.-]*["']?\s*[:=]\s*["']([^"'\s]{16,})["']""")
PLACEHOLDER = re.compile(r"(?i)example|placeholder|changeme|your[_-]|xxx|dummy|fake|test|sample|<[^>]+>|\$\{|process\.env|os\.environ|\*{3,}|invalid")
NEXT_PUBLIC_SECRET = re.compile(r"NEXT_PUBLIC_\w*(?:SECRET|PRIVATE|PASSWORD|TOKEN|SERVICE_ROLE|API_KEY)\w*")


def redact(line: str, span: tuple[int, int]) -> str:
    value = line[span[0]:span[1]]
    return line[: span[0]] + value[:4] + "...[REDACTED]" + line[span[1]:]


def rule_secrets(sf: SourceFile, ctx: Context) -> list[dict]:
    out = []
    for number, line in enumerate(sf.lines, 1):
        if len(line) > 4000:
            continue
        hit = False
        for label, severity, pattern in SECRET_PATTERNS:
            match = pattern.search(line)
            if match and not PLACEHOLDER.search(match.group(0)):
                shown = redact(line, match.span())
                out.append(finding(
                    "SEC-EXPOSED-SECRET", severity, CAT_AUTH, sf.rel, number, f"Exposed secret: {label}",
                    f"A {label} is committed in source control. Anyone with read access (or any fork/clone) can use it. "
                    "Rotate the credential immediately and load it from an environment variable or secret store.",
                    shown, key=f"{label}:{sha256_bytes(match.group(0).encode())[:12]}"))
                hit = True
                break
        if hit or sf.is_test:
            continue
        match = GENERIC_SECRET.search(line)
        if match and not PLACEHOLDER.search(match.group(0)):
            out.append(finding(
                "SEC-HARDCODED-CREDENTIAL", "HIGH", CAT_AUTH, sf.rel, number, "Hard-coded credential-like literal",
                "A literal assigned to an api key/secret/token/password variable is committed to source control. "
                "Move it to an environment variable and rotate it if it is real.",
                redact(line, match.span(1)), key=f"generic:{sha256_bytes(match.group(1).encode())[:12]}"))
        match = NEXT_PUBLIC_SECRET.search(line)
        if match and sf.ext in JS_EXTS | {".json", ".yml", ".yaml"}:
            out.append(finding(
                "SEC-NEXT-PUBLIC-SECRET", "CRITICAL", CAT_AUTH, sf.rel, number, "Secret exposed to the browser via NEXT_PUBLIC_",
                f"`{match.group(0)}` is inlined into the client bundle by Next.js, so its value is public. "
                "Rename it without the NEXT_PUBLIC_ prefix and read it only on the server.", line))
    return out


METHOD_EXPORT = re.compile(r"export\s+(?:async\s+)?function\s+(GET|POST|PUT|PATCH|DELETE)\b|export\s+const\s+(GET|POST|PUT|PATCH|DELETE)\b")
AUTH_SIGNALS = re.compile(r"currentUser(?:Id)?|requireUser|getServerSession|\bauth\(|constructEvent|CRON_SECRET|authorization|verify\w*\(|getToken|bearer|hmac|signature|timingSafeEqual", re.I)
RATE_SIGNALS = re.compile(r"rate[-_ ]?limit|ratelimit|throttle|limiter|upstash|turnstile|recaptcha|hcaptcha", re.I)
SIDE_EFFECTS = re.compile(r"appendFile|writeFile|\.(?:create|createMany|update|upsert|delete)\(")


def rule_routes(sf: SourceFile, ctx: Context) -> list[dict]:
    if sf.ext not in JS_EXTS or sf.is_test:
        return []
    is_route = bool(re.fullmatch(r"route\.[mc]?[jt]sx?", sf.name))
    is_pages_api = "/pages/api/" in "/" + sf.rel
    if not (is_route or is_pages_api):
        return []
    text, out = sf.text, []
    path = "/" + sf.rel
    methods = {m.group(1) or m.group(2) for m in METHOD_EXPORT.finditer(text)} or ({"HANDLER"} if is_pages_api else set())
    first = METHOD_EXPORT.search(text)
    first_line = sf.line_of(first.start()) if first else 1
    has_auth, has_rate = bool(AUTH_SIGNALS.search(text)), bool(RATE_SIGNALS.search(text))

    if "/api/cron/" in path:
        if "CRON_SECRET" not in text:
            out.append(finding("AUTH-CRON-UNPROTECTED", "CRITICAL", CAT_AUTH, sf.rel, first_line, "Cron endpoint has no CRON_SECRET check",
                               "Anyone on the internet can call this route (`curl https://<host>" + path.split("/app", 1)[-1].replace("/route.ts", "").replace("/route.js", "")
                               + "`) and trigger the scheduled job, causing duplicate emails, billing runs or data changes.", sf.lines[first_line - 1], key="cron-unprotected"))
        else:
            variable = re.search(r"(?:const|let|var)\s+(\w+)\s*=\s*process\.env\.CRON_SECRET", text)
            guarded = bool(re.search(r"!\s*process\.env\.CRON_SECRET", text)) or bool(variable and re.search(rf"!\s*{variable.group(1)}\b", text))
            if not guarded:
                line = sf.line_of(text.index("CRON_SECRET"))
                out.append(finding("AUTH-CRON-SECRET-UNSET", "CRITICAL", CAT_AUTH, sf.rel, line, "Cron auth bypass when CRON_SECRET is unset",
                                   "The secret is compared without first rejecting an unset value. With CRON_SECRET missing, a header of `Bearer undefined` "
                                   "(or `undefined === undefined`) is accepted. Fail closed with `if (!process.env.CRON_SECRET) return 500/401`.",
                                   sf.lines[line - 1], key="cron-unset"))
    if "/api/track/" in path and not (has_auth or has_rate):
        out.append(finding("AUTH-TRACK-UNPROTECTED", "HIGH", CAT_AUTH, sf.rel, first_line, "Tracking endpoint has no auth, signature or rate limit",
                           "Unauthenticated callers can flood or forge tracking events (analytics poisoning, storage exhaustion). "
                           "Add a signed token or rate limiting and validate the payload.", sf.lines[first_line - 1], key="track-unprotected"))
    if "unsubscribe" in path.lower() and not re.search(r"verify|signature|hmac|token|jwt|timingSafeEqual", text, re.I):
        out.append(finding("PRIV-UNSUBSCRIBE-UNVERIFIED", "HIGH", CAT_AUTH, sf.rel, first_line, "Unsubscribe endpoint lacks token validation (GDPR)",
                           "Anyone can unsubscribe (or probe the existence of) arbitrary addresses by guessing an email parameter. "
                           "Require a signed, per-recipient token and return the same response for unknown addresses.", sf.lines[first_line - 1], key="unsub"))
    special = "/api/cron/" in path or "/api/track/" in path or "unsubscribe" in path.lower()
    if not special and not has_auth and not has_rate:
        mutating = sorted(methods & {"POST", "PUT", "PATCH", "DELETE", "HANDLER"})
        if mutating:
            out.append(finding("AUTH-PUBLIC-MUTATION-NO-RATELIMIT", "MEDIUM", CAT_AUTH, sf.rel, first_line,
                               f"Public {'/'.join(mutating)} endpoint without authentication or rate limiting",
                               "The route accepts unauthenticated writes/side effects with no throttling, so a script can hammer it "
                               "(e.g. spam the support inbox and burn the email quota). Add rate limiting (IP + route) or a CAPTCHA.",
                               sf.lines[first_line - 1], key="public-mutation"))
        elif "GET" in methods and any(not sf.lines[sf.line_of(m.start()) - 1].lstrip().startswith("import") for m in SIDE_EFFECTS.finditer(text)):
            match = next(m for m in SIDE_EFFECTS.finditer(text) if not sf.lines[sf.line_of(m.start()) - 1].lstrip().startswith("import"))
            line = sf.line_of(match.start())
            out.append(finding("AUTH-PUBLIC-GET-SIDE-EFFECT", "MEDIUM", CAT_AUTH, sf.rel, line, "Unauthenticated GET writes data with no rate limit",
                               "Every request appends/writes state, so crawlers or a loop can grow the log/database without bound (disk exhaustion). "
                               "Throttle or sample the write.", sf.lines[line - 1], key="get-side-effect"))
    if re.search(r"(?:^|/)go/", sf.rel) or "/go/" in path:
        match = re.search(r"catch\s*(?:\([^)]*\))?\s*\{[^}]*?return\s+new\s+Response\([^;]*?\b5\d\d\b", text, re.S)
        if match and re.search(r"appendFile|writeFile|\.create\(|fetch\(", text):
            line = sf.line_of(text.index("return", match.start()))
            out.append(finding("GO-REDIRECT-FAIL-CLOSED", "HIGH", CAT_SEO, sf.rel, line, "Redirect fails with 5xx when click tracking fails",
                               "The click log write is inside the redirect path and its failure returns a 5xx. On read-only/serverless file systems, "
                               "a full disk or a missing directory, every `/go/<productId>` link becomes a dead end, losing affiliate revenue. "
                               "Log best-effort and still issue the 302.", sf.lines[line - 1], key="go-fail-closed"))
    if re.search(r"searchParams\.get\(|req\.query|request\.nextUrl\.searchParams", text) and re.search(r"Location|redirect\(", text) \
            and not re.search(r"allow|startsWith\(\s*[\"']/[\"']\s*\)|\.hostname|\.origin\s*===|valid\w*\(|verify\w*\(", text, re.I):
        match = re.search(r"Location|redirect\(", text)
        line = sf.line_of(match.start())
        out.append(finding("AUTH-OPEN-REDIRECT", "HIGH", CAT_AUTH, sf.rel, line, "Possible open redirect from user-controlled URL",
                           "The redirect target is derived from query parameters without an allow-list, enabling phishing links on your domain.",
                           sf.lines[line - 1], key="open-redirect"))
    return out


CATALOG_READ = re.compile(r"supplements\.json|SUPPLEMENT_CATALOG_PATH")
FILTER_SIGNAL = re.compile(r"filterUsaProducts|isUsaProduct|origin_country|lib/catalog|catalog\(\)")


def rule_usa_filter(sf: SourceFile, ctx: Context) -> list[dict]:
    if sf.is_test or sf.rel == SELF or sf.ext not in JS_EXTS | {".py"}:
        return []
    out = []
    text = sf.text
    if CATALOG_READ.search(text) and not FILTER_SIGNAL.search(text):
        match = CATALOG_READ.search(text)
        line = sf.line_of(match.start())
        out.append(finding("USA-UNFILTERED-CATALOG-READ", "CRITICAL", CAT_USA, sf.rel, line, "Catalog read without the USA-origin filter",
                           "This file reads the published product catalog directly and never applies `filterUsaProducts`/`isUsaProduct` or checks "
                           "`origin_country`. Any non-USA item present in the data would reach the storefront. Read products through `lib/catalog`.",
                           sf.lines[line - 1], key="unfiltered-read"))
    patterns = (
        (r"origin_country\s*(?:\|\||\?\?)\s*[\"']", "CRITICAL", "Missing origin defaults to a country",
         "A missing `origin_country` is silently replaced by a default, so unverified items can pass the USA check."),
        (r"\.get\(\s*[\"']origin_country[\"']\s*,\s*[\"'][^\"']+[\"']", "CRITICAL", "Missing origin defaults to a country",
         "`dict.get('origin_country', '<default>')` fabricates provenance for items that have no origin."),
        (r"origin_country\s*(?:!==?|===?)\s*[\"']([^\"']+)[\"']", "HIGH", "Origin compared against a non-'USA' literal",
         "The comparison uses an alias/case variant, which either lets lookalike values through or rejects valid ones. The only valid value is the exact string `USA`."),
        (r"origin_country[\"']?\]?\)?\??\.(?:toLowerCase|toUpperCase|includes|startsWith|endsWith|match|lower|upper|casefold|startswith|endswith)\(", "HIGH",
         "Origin normalised or fuzzy-matched",
         "Case folding or substring matching widens the filter (`usa-made`, `Not USA`, `USAF`) so non-USA origins can match."),
        (r"origin_country[\"']?\]?\s+(?:not\s+)?in\s+[\[({]|\[[^\]]*\]\.includes\(\s*\w+\.origin_country", "HIGH", "Origin allow-list widened",
         "Membership tests over several countries bypass the USA-only rule."),
    )
    for number, line in sf.code_lines():
        for pattern, severity, title, why in patterns:
            match = re.search(pattern, line)
            if not match:
                continue
            if "===" in match.group(0) or "!==" in match.group(0) or "==" in match.group(0) or "!=" in match.group(0):
                literal = re.search(r"[\"']([^\"']+)[\"']", match.group(0))
                if literal and literal.group(1) == "USA":
                    continue
            out.append(finding("USA-ORIGIN-FILTER-WEAK", severity, CAT_USA, sf.rel, number, title, why, line, key=title))
            break
        if sf.ext in JS_EXTS and re.search(r"origin_country\s*(?:==|!=)(?!=)", line):
            out.append(finding("USA-ORIGIN-LOOSE-EQUALITY", "MEDIUM", CAT_USA, sf.rel, number, "Loose equality on origin_country",
                               "`==`/`!=` coerces types; use `===`/`!==` so only the exact string `USA` passes.", line, key="loose-eq"))
        if sf.ext == ".py" and re.search(r"[\"']origin_country[\"']\s*:\s*[\"']USA[\"']", line):
            out.append(finding("USA-HARDCODED-PROVENANCE", "HIGH", CAT_USA, sf.rel, number, "Code stamps origin_country=USA on generated records",
                               "Writing `origin_country: USA` from code means provenance is asserted, not verified. Agents must record claims "
                               "(`origin_country_claim`) and leave approval to the human-review gate.", line, key="hardcoded-usa"))
    return out


def rule_timezone(sf: SourceFile, ctx: Context) -> list[dict]:
    if sf.is_test:
        return []
    out = []
    if sf.ext in JS_EXTS:
        lines = sf.lines
        for number, line in sf.code_lines():
            if re.search(r"\.toISOString\(\)\s*\.slice\(\s*0\s*,\s*10\s*\)", line):
                window = " ".join(lines[max(0, number - 3): number + 2])
                # An explicit "UTC by design" note means the reset is a documented product decision.
                if re.search(r"usage|quota|allowance|reset|limit", window, re.I) and "UTC by design" not in window:
                    out.append(finding(
                        "TZ-DAILY-RESET-UTC", "MEDIUM", CAT_BILLING, sf.rel, number, "Daily sticker allowance resets on the UTC day boundary",
                        "The 'day' key is the UTC date, so the 20-sticker allowance resets at 00:00 UTC (7pm/4pm US Eastern/Pacific) instead of the user's midnight. "
                        "Repro: a US user exhausts 20 stickers at 6pm ET, gets 20 more at 7pm ET; another user loses unused allowance mid-evening. "
                        "Store a per-user IANA timezone (or document UTC reset in the UI) and compute the day key from it.", line, key="utc-day"))
            if re.search(r"\.(?:getHours|getDate|getDay|getMonth|setHours|setDate)\(", line) and not re.search(r"UTC", line):
                out.append(finding("TZ-LOCAL-TIME-API", "LOW", CAT_CRON, sf.rel, number, "Server-local time API used",
                                   "`getHours()/getDate()/...` depend on the host timezone (UTC on CI/serverless, local on dev machines), so schedules and cutoffs "
                                   "shift between environments. Use the `getUTC*` variants or `Intl.DateTimeFormat` with an explicit `timeZone`.", line, key="local-time"))
    return out


def rule_stripe(sf: SourceFile, ctx: Context) -> list[dict]:
    if sf.ext not in JS_EXTS or sf.is_test:
        return []
    text, out = sf.text, []
    create = re.search(r"checkout\.sessions\.create|paymentIntents\.create|invoiceItems\.create|\bprices\.create", text)
    if not create:
        return out
    guard = re.search(r"(?:<|<=|>|>=)\s*(?:50|25)\b|MIN_?(?:CHARGE|AMOUNT)|minimum|isUsaProduct|filterUsaProducts|catalog\(\)", text, re.I)
    amount = re.search(r"unit_amount\s*:\s*([^,}]+)|\bamount\s*:\s*([^,}]+)", text)
    if amount and not guard:
        line = sf.line_of(amount.start())
        out.append(finding("STRIPE-MIN-CHARGE-UNGUARDED", "HIGH", CAT_BILLING, sf.rel, line, "No guard for Stripe's $0.50 minimum charge",
                           "Stripe rejects charges below $0.50 (the 2-cent overage price only works in batches of >= 25 units). Without a minimum-amount "
                           "check the checkout call throws `amount_too_small` and the user sees a generic failure. Enforce a minimum before calling Stripe.",
                           sf.lines[line - 1], key="min-charge"))
    for match in re.finditer(r"unit_amount\s*:\s*(\d+)\b", text):
        if int(match.group(1)) < 50:
            line = sf.line_of(match.start())
            out.append(finding("STRIPE-SUB-MINIMUM-LITERAL", "HIGH", CAT_BILLING, sf.rel, line, "Literal Stripe amount below $0.50",
                               "A per-item amount under 50 cents fails at Stripe unless multiplied by a quantity that reaches the minimum; verify quantity.",
                               sf.lines[line - 1], key=f"literal-{match.group(1)}"))
    if "checkout.sessions.create" in text and "idempotencyKey" not in text:
        line = sf.line_of(text.index("checkout.sessions.create"))
        out.append(finding("STRIPE-NO-IDEMPOTENCY", "LOW", CAT_BILLING, sf.rel, line, "Checkout session created without an idempotency key",
                           "A double-click or client retry creates two Checkout Sessions for one intent. Pass `{ idempotencyKey }` derived from the cart/purchase.",
                           sf.lines[line - 1], key="idempotency"))
    return out


def split_functions(text: str) -> list[tuple[int, str]]:
    starts = [m.start() for m in re.finditer(r"^(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+\w+", text, re.M)]
    if not starts:
        return [(1, text)]
    bounds = starts + [len(text)]
    return [(text.count("\n", 0, a) + 1, text[a:b]) for a, b in zip(bounds, bounds[1:])]


def rule_prisma_usage(sf: SourceFile, ctx: Context) -> list[dict]:
    if sf.ext not in JS_EXTS or sf.is_test:
        return []
    out = []
    for start_line, chunk in split_functions(sf.text):
        reads = {m.group(1) for m in re.finditer(r"\bdb\.(\w+)\.(?:findUnique|findFirst|findUniqueOrThrow|findFirstOrThrow|findMany|count)\(", chunk)}
        handles_conflict = bool(re.search(r"P2002|P2003|P2025", chunk))
        for match in re.finditer(r"\bdb\.(\w+)\.(create|update|delete|upsert)\(", chunk):
            if match.group(1) in reads and not (handles_conflict and match.group(2) == "create"):
                line = start_line + chunk.count("\n", 0, match.start())
                out.append(finding(
                    "PRISMA-CHECK-THEN-ACT", "LOW" if match.group(2) == "upsert" else "MEDIUM", CAT_PRISMA, sf.rel, line,
                    f"Read-then-write on `{match.group(1)}` outside a transaction",
                    f"`db.{match.group(1)}` is read and then `{match.group(2)}`d in separate statements. Two concurrent requests both pass the check "
                    "(double spend / double claim / limit overshoot). Use `$transaction` with a guarded `updateMany({ where: { id, state } })` and check `count`.",
                    chunk.splitlines()[chunk.count("\n", 0, match.start())], key=f"cta-{match.group(1)}-{match.group(2)}"))
        for match in re.finditer(r"\b(\w+)\s*:\s*[\w.?]+\.\1\s*[+\-]\s*[\w.(]", chunk):
            window = chunk[max(0, match.start() - 160): match.start()]
            if re.search(r"\.(?:update|updateMany|upsert)\(", window):
                line = start_line + chunk.count("\n", 0, match.start())
                out.append(finding("PRISMA-READ-MODIFY-WRITE", "HIGH", CAT_PRISMA, sf.rel, line, f"Lost-update on `{match.group(1)}`",
                                   f"`{match.group(1)}` is written as a value computed from a previously read row. Concurrent requests overwrite each other. "
                                   f"Use `{{ {match.group(1)}: {{ increment: n }} }}` so SQLite applies it atomically.",
                                   chunk.splitlines()[chunk.count("\n", 0, match.start())], key=f"rmw-{match.group(1)}"))
    return out


def rule_prisma_schema(sf: SourceFile, ctx: Context) -> list[dict]:
    if sf.ext != ".prisma":
        return []
    text, out = sf.text, []
    models = list(re.finditer(r"^model\s+(\w+)\s*\{(.*?)^\}", text, re.M | re.S))
    model_names = {m.group(1).lower() for m in models}
    role_words = {"seller", "buyer", "owner", "author", "creator", "recipient", "sender", "parent", "customer", "member", "admin", "user"}
    for model in models:
        name, body = model.group(1), model.group(2)
        relation_fields = {f.strip() for m in re.finditer(r"@relation\([^)]*fields:\s*\[([^\]]*)\]", body) for f in m.group(1).split(",")}
        indexed = set()
        for m in re.finditer(r"@@(?:index|unique|id)\(\s*\[([^\]]*)\]", body):
            indexed.add(m.group(1).split(",")[0].strip())
        base = text.count("\n", 0, model.start(2))
        for offset, line in enumerate(body.split("\n")):
            field = re.match(r"\s*(\w+)\s+(?:String|Int|BigInt)\??\b(.*)", line)
            if not field or field.group(1) == "id" or not field.group(1).endswith("Id"):
                continue
            fname, attrs = field.group(1), field.group(2)
            if "@id" in attrs:
                continue
            number = base + offset + 1
            target = fname[:-2].lower()
            if fname not in relation_fields:
                if target in model_names or target in role_words:
                    out.append(finding("PRISMA-ORPHAN-FK", "MEDIUM", CAT_PRISMA, sf.rel, number, f"`{name}.{fname}` looks like a foreign key but has no @relation",
                                       "Without a relation the database cannot enforce referential integrity: deleting the parent leaves orphan rows and a bad id "
                                       "is accepted silently. Declare the relation (with an `onDelete` rule) or rename the column.", line, key=f"{name}.{fname}"))
            elif fname not in indexed and "@unique" not in attrs:
                out.append(finding("PRISMA-FK-NO-INDEX", "LOW", CAT_PRISMA, sf.rel, number, f"Foreign key `{name}.{fname}` has no index",
                                   "Prisma does not index foreign keys on SQLite; lookups and cascading deletes scan the table and hold the single writer lock longer, "
                                   "increasing SQLITE_BUSY contention. Add `@@index([" + fname + "])`.", line, key=f"{name}.{fname}.index"))
    provider = re.search(r'provider\s*=\s*"sqlite"', text)
    # The URL lives in the environment, so the schema must document the tuning (connection_limit/socket_timeout) to pass.
    if provider and "connection_limit" not in text:
        line = sf.line_of(provider.start())
        out.append(finding("SQLITE-WRITER-CONTENTION", "LOW", CAT_PRISMA, sf.rel, line, "SQLite datasource: single-writer contention not configured",
                           "SQLite allows one writer. Concurrent Stripe webhooks + checkout transactions can fail with SQLITE_BUSY/timeouts, leaving rows "
                           "like Listing.state='reserved' or Purchase.state='pending' stuck. Use `?connection_limit=1&socket_timeout=...` in DATABASE_URL, "
                           "keep transactions short, and rely on Stripe retries plus a reconciliation job.", sf.lines[line - 1], key="sqlite"))
    return out


def rule_jsonld(sf: SourceFile, ctx: Context) -> list[dict]:
    if sf.ext not in JS_EXTS or "ld+json" not in sf.text or sf.is_test:
        return []
    text, out = sf.text, []
    for script in re.finditer(r"<script[^>]*ld\+json[^>]*>", text):
        html = re.search(r"__html:\s*(.*?)\s*\}\}", text[script.start(): script.start() + 600])
        line = sf.line_of(script.start())
        expr = html.group(1) if html else ""
        if "structuredData(" in expr:
            continue
        if "JSON.stringify" in expr and ".replace(" not in expr:
            out.append(finding("JSONLD-UNESCAPED", "HIGH", CAT_SEO, sf.rel, line, "JSON-LD serialised without escaping `<`",
                               "`JSON.stringify` output containing `</script>` (e.g. a product name) closes the tag and injects HTML/JS (stored XSS) and breaks the schema. "
                               "Use `structuredData()` from packages/seo, which escapes `<`.", sf.lines[line - 1], key="jsonld-unescaped"))
        elif "JSON.stringify" not in expr:
            out.append(finding("JSONLD-UNVERIFIED", "MEDIUM", CAT_SEO, sf.rel, line, "JSON-LD payload is not produced by a known serializer",
                               "Use `structuredData()` so output is valid JSON and `<` is escaped.", sf.lines[line - 1], key="jsonld-unverified"))
    if not re.search(r"\"@context\"\s*:\s*\"https://schema\.org\"", text):
        match = re.search(r"\"@context\"\s*:\s*\"http://schema\.org\"", text)
        line = sf.line_of(match.start()) if match else sf.line_of(text.index("ld+json"))
        out.append(finding("JSONLD-NO-CONTEXT", "HIGH", CAT_SEO, sf.rel, line, "JSON-LD has no valid `@context` (https://schema.org)",
                           "Without `@context: https://schema.org` the structured data is ignored by Google's parser.", sf.lines[line - 1], key="jsonld-context"))
    for match in re.finditer(r"\"@type\"\s*:\s*\"Product\"", text):
        rest = re.search(r"\"@context\"|\"@type\"\s*:\s*\"(?:BreadcrumbList|FAQPage|Organization|WebSite)\"", text[match.end():])
        block = text[match.start(): match.end() + rest.start()] if rest else text[match.start(): match.start() + 1500]
        line = sf.line_of(match.start())
        missing = []
        if not re.search(r"\bimage\b", block):
            missing.append("image")
        if not re.search(r"\boffers\b|aggregateRating|\breview\b", block):
            missing.append("offers/aggregateRating/review")
        if missing:
            out.append(finding("JSONLD-PRODUCT-INCOMPLETE", "MEDIUM", CAT_SEO, sf.rel, line, "Product JSON-LD missing " + ", ".join(missing),
                               "Google's Product rich-result requirements need `name`, `image` and one of `offers`, `review` or `aggregateRating`. "
                               "Incomplete markup is reported as invalid in Search Console and loses rich results.", sf.lines[line - 1], key="product-" + ",".join(missing)))
    for match in re.finditer(r"\"@type\"\s*:\s*\"Offer\"", text):
        block = text[match.start(): match.start() + 500]
        if not re.search(r"\bprice\b", block) or not re.search(r"priceCurrency", block):
            line = sf.line_of(match.start())
            out.append(finding("JSONLD-OFFER-INVALID", "HIGH", CAT_SEO, sf.rel, line, "Offer JSON-LD missing price or priceCurrency",
                               "An Offer without `price` and `priceCurrency` is invalid and suppresses price rich results.", sf.lines[line - 1], key="offer"))
    return out


HREF = re.compile(
    r"""(?:\bhref|\bto|\baction)\s*=\s*(?:"([^"]*)"|'([^']*)'|\{\s*(?:"([^"]*)"|'([^']*)'|`([^`]*)`)\s*\})"""
    r"""|\b(?:redirect|permanentRedirect|router\.push|router\.replace)\(\s*(?:"([^"]*)"|'([^']*)'|`([^`]*)`)""")


def rule_links(sf: SourceFile, ctx: Context) -> list[dict]:
    if sf.ext not in JS_EXTS or sf.is_test:
        return []
    out = []
    text = sf.text
    if sf.app and sf.app in ctx.routes:
        for match in HREF.finditer(text):
            target = next((g for g in match.groups() if g is not None), "")
            if not target.startswith("/") or target.startswith("//"):
                continue
            path = re.sub(r"[?#].*$", "", re.sub(r"\$\{[^}]*\}", "X", target)) or "/"
            if not ctx.route_exists(sf.app, path):
                line = sf.line_of(match.start())
                out.append(finding("LINK-BROKEN-INTERNAL", "HIGH", CAT_SEO, sf.rel, line, f"Broken internal link `{target}`",
                                   f"No page, route handler or public file in apps/{sf.app} serves `{path}`; visitors and crawlers get a 404. "
                                   "Fix the URL or add the route.", match.group(0), key=target))
        if re.fullmatch(r"sitemap\.[jt]s", sf.name):
            for match in re.finditer(r"[\"'](/[A-Za-z0-9_\-/]*)[\"']", text):
                if not ctx.route_exists(sf.app, match.group(1)):
                    line = sf.line_of(match.start())
                    out.append(finding("LINK-SITEMAP-DEAD-URL", "HIGH", CAT_SEO, sf.rel, line, f"Sitemap lists missing route `{match.group(1)}`",
                                       "Sitemap entries that 404 waste crawl budget and trigger Search Console errors.", match.group(0), key=match.group(1)))
    for match in re.finditer(r"""(?:href|src)\s*=\s*["'](http://(?!localhost|127\.0\.0\.1)[^"']+)["']""", text):
        line = sf.line_of(match.start())
        out.append(finding("LINK-INSECURE-HTTP", "LOW", CAT_SEO, sf.rel, line, "Insecure http:// link or asset",
                           "Mixed content is blocked by browsers and flagged by Lighthouse. Use https.", match.group(0), key=match.group(1)))
    for match in re.finditer(r"<img\b(?:[^>{]|\{[^}]*\})*>", text):
        if not re.search(r"\balt\s*=", match.group(0)):
            line = sf.line_of(match.start())
            out.append(finding("SEO-IMG-NO-ALT", "LOW", CAT_SEO, sf.rel, line, "<img> without alt text",
                               "Images without `alt` hurt accessibility and image SEO and fail the Lighthouse SEO audit.", match.group(0), key="img-" + clip(match.group(0), 60)))
    for match in re.finditer(r"<a\b(?:[^>{]|\{[^}]*\})*target=[\"']_blank[\"'](?:[^>{]|\{[^}]*\})*>", text):
        if not re.search(r"rel\s*=\s*(?:\"[^\"]*|'[^']*|\{[^>]*?)(?:noopener|noreferrer)", match.group(0)):
            line = sf.line_of(match.start())
            out.append(finding("LINK-BLANK-NO-NOOPENER", "LOW", CAT_AUTH, sf.rel, line, "target=_blank link without rel=noopener",
                               "The opened page can navigate the opener via `window.opener` (reverse tabnabbing).", match.group(0), key="blank-" + clip(match.group(0), 60)))
    return out


IMPORT_SPEC = re.compile(
    r"""(?:import|export)\s[^'"`;]*?\sfrom\s*["'](\.{1,2}/[^"']*|\.{1,2})["']"""
    r"""|\bimport\s*["'](\.{1,2}/[^"']*)["']|\bimport\(\s*["'](\.{1,2}/[^"']*)["']\s*\)|\brequire\(\s*["'](\.{1,2}/[^"']*)["']\s*\)""")
RESOLVE_EXTS = (".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts", ".json", ".css")


def import_resolves(root: Path, importer: str, spec: str) -> bool:
    base = (root / importer).parent / spec
    candidates = [base]
    if base.suffix in (".js", ".jsx", ".mjs", ".cjs"):
        candidates += [base.with_suffix(ext) for ext in (".ts", ".tsx", ".mts", ".cts")]
    candidates += [Path(str(base) + ext) for ext in RESOLVE_EXTS]
    candidates += [base / f"index{ext}" for ext in RESOLVE_EXTS]
    return any(c.is_file() for c in candidates)


def rule_imports(sf: SourceFile, ctx: Context) -> list[dict]:
    if sf.ext not in JS_EXTS:
        return []
    out = []
    for match in IMPORT_SPEC.finditer(sf.text):
        spec = next(g for g in match.groups() if g is not None)
        line = sf.line_of(match.start())
        if sf.lines[line - 1].lstrip().startswith(("//", "*")):
            continue
        if not import_resolves(ctx.root, sf.rel, spec):
            out.append(finding("BUILD-UNRESOLVED-IMPORT", "HIGH", CAT_BUILD, sf.rel, line, f"Import `{spec}` does not resolve to a file",
                               "The module is missing, so `next build`/`tsc`/Node fail at load time with MODULE_NOT_FOUND.", sf.lines[line - 1], key=spec))
    return out


def rule_js_safety(sf: SourceFile, ctx: Context) -> list[dict]:
    if sf.ext not in JS_EXTS or sf.is_test:
        return []
    out = []
    for number, line in sf.code_lines():
        if "dangerouslySetInnerHTML" in line and "ld+json" not in line and "ld+json" not in "\n".join(sf.lines[max(0, number - 3): number]):
            out.append(finding("SEC-DANGEROUS-HTML", "HIGH", CAT_AUTH, sf.rel, number, "dangerouslySetInnerHTML with non-JSON-LD content",
                               "Raw HTML injection is an XSS sink. Sanitise with a vetted library or render as React nodes.", line, key="dangerous-html"))
        if re.search(r"\beval\(|new\s+Function\(", line) or re.search(r"\bexec(?:Sync)?\(\s*(?:`[^`]*\$\{|[\"'][^\"']*[\"']\s*\+)", line):
            out.append(finding("SEC-CODE-EXECUTION", "HIGH", CAT_AUTH, sf.rel, number, "Dynamic code or shell execution",
                               "`eval`/`new Function`/templated `exec` run attacker-influenced strings as code.", line, key="code-exec"))
        if re.search(r"rejectUnauthorized\s*:\s*false|NODE_TLS_REJECT_UNAUTHORIZED", line):
            out.append(finding("SEC-TLS-DISABLED", "HIGH", CAT_AUTH, sf.rel, number, "TLS certificate verification disabled",
                               "Disabling verification allows man-in-the-middle attacks on every request from this process.", line, key="tls"))
        if "Math.random" in line and re.search(r"token|secret|password|serial|session|nonce", line, re.I):
            out.append(finding("SEC-WEAK-RANDOM", "MEDIUM", CAT_AUTH, sf.rel, number, "Math.random() used for a security-sensitive value",
                               "`Math.random` is predictable; use `crypto.randomBytes`/`randomUUID`.", line, key="weak-random"))
        for match in re.finditer(r"process\.env\.([A-Z0-9_]+)\.(\w+)\(", line):
            out.append(finding("ENV-UNGUARDED-METHOD", "MEDIUM", CAT_BUILD, sf.rel, number, f"`process.env.{match.group(1)}` dereferenced without a fallback",
                               f"If {match.group(1)} is unset, `.{match.group(2)}()` throws `TypeError: Cannot read properties of undefined` at runtime.",
                               line, key=match.group(0),
                               fix={"kind": "replace", "line": number, "old": match.group(0),
                                    "new": f'(process.env.{match.group(1)} ?? "").{match.group(2)}('}))
        for match in re.finditer(r"(?:new URL|JSON\.parse|Number|parseInt|parseFloat)\(\s*process\.env\.([A-Z0-9_]+)\s*[,)]", line):
            out.append(finding("ENV-UNGUARDED-PARSE", "MEDIUM", CAT_BUILD, sf.rel, number, f"`process.env.{match.group(1)}` parsed without a fallback",
                               f"An unset {match.group(1)} yields `Invalid URL`, a JSON SyntaxError or NaN. Provide a default or validate at startup.",
                               line, key=match.group(0)))
    out.extend(find_unchecked_derefs(sf))
    return out


def find_unchecked_derefs(sf: SourceFile) -> list[dict]:
    """`.find(...)` / `.match(...)` results dereferenced immediately (they may return undefined/null)."""
    out = []
    text = sf.text
    for match in re.finditer(r"\.(find|match)\(", text):
        depth, index = 1, match.end()
        while index < len(text) and depth:
            depth += {"(": 1, ")": -1}.get(text[index], 0)
            index += 1
        if depth:
            continue
        follow = re.match(r"\.([A-Za-z_]\w*)|\[(\d+)\]", text[index:])
        if not follow:
            continue
        line = sf.line_of(index)
        if sf.lines[line - 1].lstrip().startswith(("//", "*")):
            continue
        column = index - (text.rfind("\n", 0, index) + 1)
        snippet = sf.lines[line - 1]
        out.append(finding(
            "NULL-UNCHECKED-LOOKUP", "MEDIUM", CAT_DATA, sf.rel, line, f"Result of `.{match.group(1)}()` dereferenced without a null check",
            f"`.{match.group(1)}()` returns {'undefined' if match.group(1) == 'find' else 'null'} when nothing matches, so the immediate property access throws "
            "`TypeError` for an unknown id/input and turns a 404 into a 500.", snippet, key=snippet.strip()[:120],
            fix={"kind": "splice", "line": line, "col": column, "old": "." if follow.group(1) else "[", "new": "?." if follow.group(1) else "?.["}))
    return out


def rule_email_privacy(sf: SourceFile, ctx: Context) -> list[dict]:
    if sf.ext not in JS_EXTS | {".py"} or sf.is_test:
        return []
    text = sf.text
    match = re.search(r"api\.resend\.com/emails|\bsendgrid\.send\(|\.sendMail\(|\bses\.send|api\.mailgun|postmarkapp\.com/email", text)
    if not match:
        return []
    if re.search(r"unsubscribe|List-Unsubscribe", text, re.I):
        return []
    line = sf.line_of(match.start())
    recipient = re.search(r"\bto\s*:\s*\[?\s*(\w+)", text)
    if "recipient" not in text.lower() and (re.search(r"SUPPORT", text) or (recipient and recipient.group(1) in ("to", "support", "supportTo"))):
        return []
    return [finding("PRIV-EMAIL-NO-UNSUBSCRIBE", "MEDIUM", CAT_AUTH, sf.rel, line, "Outbound email to user-supplied address without unsubscribe/consent handling",
                    "The message goes to a third party who never opted in and carries no `List-Unsubscribe` header or opt-out link. Under GDPR/CAN-SPAM this "
                    "needs a suppression list and a one-click unsubscribe (validated with a signed token), otherwise the sender domain can be reported for spam.",
                    sf.lines[line - 1], key="email-unsub")]


def rule_auth_flows(sf: SourceFile, ctx: Context) -> list[dict]:
    if sf.ext not in JS_EXTS or sf.is_test:
        return []
    out = []
    if not RATE_SIGNALS.search(sf.text) and not re.search(r"attempts|lockout|failedLogin", sf.text, re.I):
        for match in re.finditer(r"export\s+async\s+function\s+(login|signin|signIn|register|signup|signUp|authenticate)\b", sf.text):
            line = sf.line_of(match.start())
            out.append(finding("AUTH-NO-BRUTE-FORCE-PROTECTION", "MEDIUM", CAT_AUTH, sf.rel, line, f"`{match.group(1)}` has no rate limiting or lockout",
                               "Unlimited password guesses (and account creation) per IP/email enable credential stuffing and scrypt CPU exhaustion. "
                               "Add rate limiting and exponential back-off.", sf.lines[line - 1], key=match.group(1)))
    return out


def rule_ai_budget_js(sf: SourceFile, ctx: Context) -> list[dict]:
    if sf.ext not in JS_EXTS or sf.is_test:
        return []
    match = re.search(r"api\.openai\.com|api\.anthropic\.com|generativelanguage\.googleapis", sf.text)
    if match and not re.search(r"cost_ledger|budget|MONTHLY_BUDGET", sf.text, re.I):
        line = sf.line_of(match.start())
        return [finding("BUDGET-LLM-NO-CHECK-JS", "HIGH", CAT_PY, sf.rel, line, "LLM API call without a cost_ledger.json budget check",
                        "Paid model calls must reserve cost in `data/cost_ledger.json` and abort before the $1,000/month cap.", sf.lines[line - 1], key="llm-js")]
    return []


# ---- package.json / data / workflow rules ---------------------------------------------------

def rule_package_json(sf: SourceFile, ctx: Context) -> list[dict]:
    if sf.name != "package.json":
        return []
    try:
        data = json.loads(sf.text.lstrip("\ufeff"))
    except ValueError:
        return []
    out = []
    base = (ctx.root / sf.rel).parent
    scripts = data.get("scripts") if isinstance(data.get("scripts"), dict) else {}
    for name, command in scripts.items():
        missing = []
        for token in re.findall(r"[\w./@\\-]+\.(?:m?js|cjs|mts|ts|tsx)\b", str(command)):
            if token.startswith(("-", "node_modules")) or "*" in token:
                continue
            if not (base / token).exists():
                missing.append(token)
        if missing:
            line = next((i for i, l in enumerate(sf.lines, 1) if f'"{name}"' in l), 1)
            out.append(finding("BUILD-SCRIPT-MISSING-FILE", "HIGH", CAT_BUILD, sf.rel, line, f"npm script `{name}` references missing file(s)",
                               "Missing: " + ", ".join(f"`{m}`" for m in sorted(set(missing))) + f". `npm run {name}` fails immediately, which breaks any CI step that calls it "
                               "(`npm test`, `npm run build`).", sf.lines[line - 1], key=f"{name}:{','.join(sorted(set(missing)))}"))
    for section in ("dependencies", "devDependencies"):
        for package, version in (data.get(section) or {}).items():
            if str(version).strip() in ("*", "latest", ""):
                line = next((i for i, l in enumerate(sf.lines, 1) if f'"{package}"' in l), 1)
                out.append(finding("BUILD-UNPINNED-DEPENDENCY", "MEDIUM", CAT_BUILD, sf.rel, line, f"Dependency `{package}` uses `{version}`",
                                   "Unbounded versions make builds non-reproducible and open the supply chain to malicious releases.", sf.lines[line - 1], key=package))
    return out


def rule_json_data(sf: SourceFile, ctx: Context) -> list[dict]:
    if sf.ext != ".json":
        return []
    out = []
    if sf.text.startswith("\ufeff"):
        out.append(finding("JSON-BOM", "LOW", CAT_DATA, sf.rel, 1, "UTF-8 BOM at start of JSON file",
                           "A BOM makes `JSON.parse` and several Python loaders fail. Save as UTF-8 without BOM.", "", key="bom"))
    try:
        data = json.loads(sf.text.lstrip("\ufeff"))
    except ValueError as error:
        line = getattr(error, "lineno", 1)
        out.append(finding("JSON-INVALID", "HIGH", CAT_DATA, sf.rel, line, "Invalid JSON",
                           f"Parser error: {error}. Every consumer (build, agents, storefront) crashes while reading this file.",
                           sf.lines[min(line, len(sf.lines)) - 1], key="invalid-json"))
        return out
    name = sf.name
    if name == "supplements.json" and isinstance(data, list):
        seen = set()
        for index, item in enumerate(data):
            line = next((i for i, l in enumerate(sf.lines, 1) if isinstance(item, dict) and f'"{item.get("id")}"' in l), 1)
            if not isinstance(item, dict):
                continue
            problems = []
            if item.get("origin_country") != "USA":
                problems.append(f"origin_country={item.get('origin_country')!r}")
            if item.get("verified_usa_manufacturing") is not True:
                problems.append("verified_usa_manufacturing is not true")
            if item.get("review_status") != "approved":
                problems.append(f"review_status={item.get('review_status')!r}")
            if problems:
                out.append(finding("USA-NON-COMPLIANT-CATALOG-ITEM", "CRITICAL", CAT_USA, sf.rel, line, f"Catalog item `{item.get('id')}` violates the USA-only gate",
                                   "; ".join(problems) + ". The storefront filter drops it, but any consumer that reads the file directly (scripts, feeds, "
                                   "sitemaps) would publish a non-USA/unreviewed product.", sf.lines[line - 1], key=f"{item.get('id')}:{problems[0]}"))
            price = item.get("price_cents")
            if not isinstance(price, int) or price < 50:
                out.append(finding("STRIPE-CATALOG-PRICE-BELOW-MINIMUM", "HIGH", CAT_BILLING, sf.rel, line, f"Catalog item `{item.get('id')}` price below Stripe's $0.50 minimum",
                                   f"price_cents={price!r}; Stripe rejects Checkout for amounts under 50 cents.", sf.lines[line - 1], key=f"price:{item.get('id')}"))
            if item.get("id") in seen:
                out.append(finding("DATA-DUPLICATE-ID", "HIGH", CAT_DATA, sf.rel, line, f"Duplicate product id `{item.get('id')}`",
                                   "Duplicate ids make `/product/[id]` and `/go/[id]` resolve to the wrong product and fail `catalog()`.", sf.lines[line - 1], key=f"dup:{item.get('id')}"))
            seen.add(item.get("id"))
    if name.endswith("stickers_catalog.json") and isinstance(data, list):
        seen = set()
        public = ctx.root / "apps" / "sticker-market" / "public"
        for item in data:
            if not isinstance(item, dict):
                continue
            line = next((i for i, l in enumerate(sf.lines, 1) if f'"{item.get("id")}"' in l), 1)
            if item.get("id") in seen:
                out.append(finding("DATA-DUPLICATE-ID", "HIGH", CAT_DATA, sf.rel, line, f"Duplicate sticker id `{item.get('id')}`",
                                   "Duplicate ids produce colliding `/stickers/[id]` pages and sitemap entries.", sf.lines[line - 1], key=f"dup:{item.get('id')}"))
            seen.add(item.get("id"))
            image = item.get("image")
            if isinstance(image, str) and image.startswith("/") and public.is_dir() and not (public / image.lstrip("/")).is_file():
                out.append(finding("SEO-IMAGE-FILE-MISSING", "HIGH", CAT_SEO, sf.rel, line, f"Sticker image `{image}` missing from public/",
                                   "The page renders a broken image and its Product JSON-LD points at a 404.", sf.lines[line - 1], key=f"img:{image}"))
            if "alt" in item and not str(item.get("alt", "")).strip():
                out.append(finding("SEO-EMPTY-ALT", "LOW", CAT_SEO, sf.rel, line, f"Sticker `{item.get('id')}` has empty alt text",
                                   "Empty alt text hurts accessibility and image SEO.", sf.lines[line - 1], key=f"alt:{item.get('id')}"))
    if name == "cost_ledger.json":
        out.extend(check_ledger(sf, data, ctx))
    return out


def check_ledger(sf: SourceFile, data: object, ctx: Context) -> list[dict]:
    out = []
    if not isinstance(data, dict) or data.get("version") != 1 or not isinstance(data.get("months"), dict):
        return [finding("BUDGET-LEDGER-INVALID", "HIGH", CAT_PY, sf.rel, 1, "cost_ledger.json has an invalid structure",
                        "Agents refuse to run (`Ledger missing or invalid`) or, worse, may treat the month as empty and overspend.", "", key="ledger-shape")]
    limit = ctx.budget_limit
    for month, entries in data["months"].items():
        total = Decimal("0")
        try:
            for entry in entries:
                amount = Decimal(entry["charged_usd"])
                if not amount.is_finite() or amount < 0 or entry["state"] not in ("reserved", "settled"):
                    raise ValueError("bad entry")
                total += amount
        except (KeyError, TypeError, ValueError, InvalidOperation):
            out.append(finding("BUDGET-LEDGER-INVALID", "HIGH", CAT_PY, sf.rel, 1, f"Ledger month {month} contains an invalid entry",
                               "A malformed entry stops every budgeted agent (hard failure) until repaired.", "", key=f"entry:{month}"))
            continue
        if total >= limit:
            out.append(finding("BUDGET-EXCEEDED", "CRITICAL", CAT_PY, sf.rel, 1, f"Monthly budget reached in {month}: ${total} of ${limit}",
                               "Reserved + settled spend is at or above the cap; agents must hard-stop.", "", key=f"over:{month}"))
        elif total >= limit * Decimal("0.8"):
            out.append(finding("BUDGET-NEAR-LIMIT", "MEDIUM", CAT_PY, sf.rel, 1, f"Monthly budget {month} above 80%: ${total} of ${limit}",
                               "Remaining headroom is small; fleet reservations may be refused.", "", key=f"near:{month}"))
    return out


def job_blocks(lines: list[str]) -> list[tuple[str, int, int]]:
    """(job name, first line index, end line index) for each job under `jobs:` (2-space indented keys)."""
    try:
        start = next(i for i, l in enumerate(lines) if re.match(r"^jobs:\s*$", l))
    except StopIteration:
        return []
    heads = [(i, m.group(1)) for i in range(start + 1, len(lines)) if (m := re.match(r"^  ([\w-]+):\s*$", lines[i]))]
    ends = [h[0] for h in heads[1:]] + [len(lines)]
    return [(name, i, e) for (i, name), e in zip(heads, ends)]


def rule_workflow(sf: SourceFile, ctx: Context) -> list[dict]:
    if sf.ext not in (".yml", ".yaml"):
        return []
    out = []
    for number, line in enumerate(sf.lines, 1):
        if "\t" in line and line.lstrip("\t") != line:
            out.append(finding("YAML-TAB-INDENT", "HIGH", CAT_BUILD, sf.rel, number, "Tab used for YAML indentation",
                               "YAML forbids tabs for indentation; the file fails to parse.", line, key="tab"))
            break
    if "/.github/workflows/" not in "/" + sf.rel:
        return out
    text = sf.text
    if re.search(r"^\s*pull_request_target\s*:", text, re.M) and re.search(r"github\.event\.pull_request\.head", text):
        line = next(i for i, l in enumerate(sf.lines, 1) if "pull_request_target" in l)
        out.append(finding("CI-PWN-REQUEST", "CRITICAL", CAT_AUTH, sf.rel, line, "pull_request_target checks out untrusted PR code",
                           "Runs fork code with repository secrets and a write token.", sf.lines[line - 1], key="pwn"))
    for number, line in enumerate(sf.lines, 1):
        if re.search(r"\$\{\{\s*github\.(?:event\.(?:issue|pull_request|comment|review|head_commit|pages)[\w.\[\]*]*|head_ref)\s*\}\}", line) \
                and not re.match(r"\s*(?:if|name|ref|group)\s*:", line) and not re.search(r"^\s*[A-Z_]+\s*:", line):
            out.append(finding("CI-SCRIPT-INJECTION", "HIGH", CAT_AUTH, sf.rel, number, "Untrusted GitHub context interpolated into a step",
                               "PR titles, branch names or comment bodies are attacker-controlled; interpolating them into `run:` allows shell injection. "
                               "Pass them via `env:` and quote the variable.", line, key=clip(line, 80)))
    for number, line in enumerate(sf.lines, 1):
        match = re.search(r"MONTHLY_BUDGET_USD\s*:.*\|\|\s*'?\"?(\d+(?:\.\d+)?)", line)
        if match and Decimal(match.group(1)) > HARD_BUDGET_CAP:
            out.append(finding("BUDGET-WORKFLOW-DEFAULT-OVER-CAP", "HIGH", CAT_PY, sf.rel, number, f"MONTHLY_BUDGET_USD defaults to {match.group(1)} (> $1000)",
                               "The workflow default exceeds the hard monthly cap.", line, key="budget-default"))
    triggers = re.search(r"^on:\s*\n((?:[ \t]+.*\n|\n)*)", text, re.M)
    runs_on_events = triggers.group(1) if triggers else ""
    event_driven = bool(re.search(r"^\s+(?:push|pull_request)\s*:|^\s+(?:push|pull_request)\s*$", runs_on_events, re.M))
    for name, begin, end in job_blocks(sf.lines):
        block = "\n".join(sf.lines[begin:end])
        header = "\n".join(sf.lines[begin:end])
        if not re.search(r"^    timeout-minutes\s*:", block, re.M):
            out.append(finding("CI-NO-TIMEOUT", "MEDIUM", CAT_BUILD, sf.rel, begin + 1, f"Job `{name}` has no timeout-minutes",
                               "A hung step consumes the default 360 minutes of runner time.", sf.lines[begin], key=f"timeout:{name}"))
        spends = re.search(r"LLM_API_KEY", block)
        if spends:
            step_starts = [i for i in range(begin, end) if re.match(r"^      - ", sf.lines[i])]
            for step_begin, step_end in zip(step_starts, step_starts[1:] + [end]):
                step = "\n".join(sf.lines[step_begin:step_end])
                if "LLM_API_KEY" in step and "MONTHLY_BUDGET_USD" not in step and "bug_hunter_agent" not in step:
                    out.append(finding("BUDGET-STEP-NO-CAP", "HIGH", CAT_PY, sf.rel, step_begin + 1, f"Step in `{name}` uses LLM_API_KEY without MONTHLY_BUDGET_USD",
                                       "Budgeted agents default to $1000, but the cap must be explicit in every paid step so it can be lowered per environment.",
                                       sf.lines[step_begin], key=f"nocap:{name}:{step_begin - begin}"))
            gated_key = all("github.event_name" in l for l in sf.lines[begin:end] if re.match(r"\s*LLM_API_KEY\s*:", l))
            if event_driven and not gated_key and not re.search(r"^    if\s*:.*github\.event_name", header, re.M):
                out.append(finding("BUDGET-LLM-ON-EVERY-PUSH", "HIGH", CAT_PY, sf.rel, begin + 1, f"Job `{name}` spends LLM budget on push/PR events",
                                   "The workflow also triggers on push/pull_request, so every commit would reserve paid LLM calls. Gate the job with "
                                   "`if: github.event_name != 'push'`.", sf.lines[begin], key=f"push-spend:{name}"))
    return out


# ---- Python rules (AST) ---------------------------------------------------------------------

def dotted(node: ast.AST) -> str:
    parts = []
    while isinstance(node, ast.Attribute):
        parts.append(node.attr)
        node = node.value
    if isinstance(node, ast.Name):
        parts.append(node.id)
    return ".".join(reversed(parts))


def walk_no_nested_defs(node: ast.AST):
    stack = list(ast.iter_child_nodes(node))
    while stack:
        current = stack.pop()
        yield current
        if isinstance(current, (ast.FunctionDef, ast.AsyncFunctionDef, ast.Lambda, ast.ClassDef)):
            continue
        stack.extend(ast.iter_child_nodes(current))


BLOCKING = {"time.sleep", "urllib.request.urlopen", "socket.gethostbyname", "input"}
BLOCKING_PREFIXES = ("requests.", "subprocess.")


def byte_col_to_char(line: str, col: int) -> int:
    return len(line.encode("utf-8")[:col].decode("utf-8", errors="ignore"))


def rule_python(sf: SourceFile, ctx: Context) -> list[dict]:
    if sf.ext != ".py":
        return []
    try:
        tree = ast.parse(sf.text)
    except SyntaxError:
        return []
    out = []
    text = sf.text

    def add(rule, severity, category, node, title, detail, key=None, fix=None):
        line = getattr(node, "lineno", 1)
        out.append(finding(rule, severity, category, sf.rel, line, title, detail, sf.lines[line - 1], key=key, fix=fix))

    async_fns = [n for n in ast.walk(tree) if isinstance(n, ast.AsyncFunctionDef)]
    for fn in async_fns:
        for node in walk_no_nested_defs(fn):
            if isinstance(node, ast.Call):
                name = dotted(node.func)
                if name in BLOCKING or name.startswith(BLOCKING_PREFIXES):
                    add("PY-ASYNC-BLOCKING-CALL", "MEDIUM", CAT_PY, node, f"Blocking call `{name}()` inside `async def {fn.name}`",
                        "The call blocks the event loop, stalling every other worker coroutine (a 1000-agent fleet stops making progress and can miss its "
                        "runtime deadline). Use `await asyncio.to_thread(...)` or an async client.", key=f"{fn.name}:{name}")
            if isinstance(node, ast.ExceptHandler) and (node.type is None or dotted(node.type) == "BaseException") \
                    and not any(isinstance(n, ast.Raise) for n in ast.walk(node)):
                add("PY-ASYNC-SWALLOWS-CANCEL", "MEDIUM", CAT_PY, node, f"`{fn.name}` catches BaseException without re-raising",
                    "`asyncio.CancelledError` is a BaseException; swallowing it makes timeouts and shutdown (FLEET_SHUTDOWN_BUFFER_SECONDS) hang.", key=fn.name)
    for node in ast.walk(tree):
        if isinstance(node, ast.Expr) and isinstance(node.value, ast.Call) and dotted(node.value.func) in ("asyncio.create_task", "asyncio.ensure_future", "loop.create_task"):
            add("PY-FIRE-AND-FORGET", "MEDIUM", CAT_PY, node, "Task created and immediately dropped",
                "Unreferenced tasks can be garbage-collected mid-flight and their exceptions are never retrieved, silently losing budgeted work. "
                "Keep a reference and await/gather it.")
        if isinstance(node, ast.ExceptHandler):
            if node.type is None:
                add("PY-BARE-EXCEPT", "MEDIUM", CAT_PY, node, "Bare `except:`", "Catches KeyboardInterrupt/SystemExit and hides real failures; catch specific exceptions.")
            elif dotted(node.type) in ("Exception", "BaseException") and len(node.body) == 1 and isinstance(node.body[0], ast.Pass):
                add("PY-SILENT-EXCEPT", "LOW", CAT_PY, node, "`except Exception: pass` silently swallows errors",
                    "Failures (including ledger/IO errors) vanish without a log line, so budget or data problems go unnoticed.")
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            for default in node.args.defaults + [d for d in node.args.kw_defaults if d is not None]:
                if isinstance(default, (ast.List, ast.Dict, ast.Set)):
                    add("PY-MUTABLE-DEFAULT", "MEDIUM", CAT_PY, default, f"Mutable default argument in `{node.name}`",
                        "The same list/dict is shared across calls and workers, leaking state between jobs.", key=node.name)
        if isinstance(node, ast.Call):
            name = dotted(node.func)
            for keyword in node.keywords:
                if keyword.arg == "shell" and isinstance(keyword.value, ast.Constant) and keyword.value.value is True:
                    add("PY-SHELL-TRUE", "HIGH", CAT_AUTH, node, "subprocess with shell=True", "Shell interpolation enables command injection; pass an argument list.")
            if name in ("eval", "exec", "pickle.load", "pickle.loads", "yaml.load", "marshal.loads"):
                add("PY-UNSAFE-EVAL", "HIGH", CAT_AUTH, node, f"`{name}()` on untrusted data", "Arbitrary code execution if the input is attacker-influenced.", key=name)
            if name in ("datetime.utcnow", "datetime.today", "date.today") or (name == "datetime.now" and not node.args and not node.keywords):
                severity = "MEDIUM" if re.search(r"ledger|budget|month|daily|day\b", text, re.I) else "LOW"
                add("PY-NAIVE-DATETIME", severity, CAT_CRON, node, f"Naive/host-timezone `{name}()`",
                    "Day/month boundaries (budget months, daily allowances, cron windows) shift with the host timezone (CI is UTC, laptops are not). "
                    "Use `datetime.now(timezone.utc)`.", key=name)
            if name.startswith("requests.") and name.split(".")[-1] in ("get", "post", "put", "delete", "request") \
                    and not any(k.arg == "timeout" for k in node.keywords):
                add("PY-REQUESTS-NO-TIMEOUT", "MEDIUM", CAT_PY, node, f"`{name}()` without timeout", "`requests` waits forever by default; one hung host stalls the job.", key=name)
            if name in ("aiohttp.ClientSession",) and not any(k.arg == "timeout" for k in node.keywords) and "timeout" not in text:
                add("PY-AIOHTTP-NO-TIMEOUT", "LOW", CAT_PY, node, "aiohttp.ClientSession without an explicit timeout",
                    "The 5-minute default total timeout lets one stuck request hold a worker slot and its budget reservation.")
            encoding_missing = False
            if name == "open" and node.args:
                mode = node.args[1].value if len(node.args) > 1 and isinstance(node.args[1], ast.Constant) else next(
                    (k.value.value for k in node.keywords if k.arg == "mode" and isinstance(k.value, ast.Constant)), "r")
                encoding_missing = isinstance(mode, str) and "b" not in mode and not any(k.arg == "encoding" for k in node.keywords)
            elif isinstance(node.func, ast.Attribute) and node.func.attr in ("read_text", "write_text"):
                encoding_missing = not any(k.arg == "encoding" for k in node.keywords) and not (node.func.attr == "read_text" and node.args)
                if node.func.attr == "write_text" and len(node.args) > 1:
                    encoding_missing = False
            if encoding_missing and getattr(node, "end_lineno", None):
                add("PY-OPEN-NO-ENCODING", "LOW", CAT_BUILD, node, "Text file opened without encoding",
                    "The platform default codec (cp1252 on Windows) corrupts non-ASCII data and causes mojibake that differs between dev machines and CI. "
                    "Pass `encoding='utf-8'`.", key=clip(sf.lines[node.lineno - 1], 100),
                    fix={"kind": "py-encoding", "line": node.end_lineno, "col": node.end_col_offset - 1, "has_args": bool(node.args or node.keywords)})
    if re.search(r"chat/completions|api\.openai\.com|api\.anthropic\.com", text) and not sf.is_test \
            and not re.search(r"ledger|budget|reserve|settle", text, re.I):
        line = sf.line_of(re.search(r"chat/completions|api\.openai\.com|api\.anthropic\.com", text).start())
        out.append(finding("BUDGET-LLM-NO-CHECK", "HIGH", CAT_PY, sf.rel, line, "LLM API call without a cost_ledger.json budget check",
                           "Paid model calls must reserve their worst-case cost in `data/cost_ledger.json` and abort before the $1,000/month cap.", sf.lines[line - 1], key="llm"))
    if "cost_ledger" in text and re.search(r"write_text\(|json\.dump\(", text) and not re.search(r"os\.replace|atomic_write|\.replace\(", text) and not sf.is_test:
        line = sf.line_of(re.search(r"write_text\(|json\.dump\(", text).start())
        out.append(finding("BUDGET-LEDGER-NON-ATOMIC", "HIGH", CAT_PY, sf.rel, line, "Ledger written without an atomic replace",
                           "A crash mid-write truncates cost_ledger.json; agents then refuse to run or restart the month at $0 and overspend.", sf.lines[line - 1], key="ledger-write"))
    if "MONTHLY_BUDGET_USD" in text and not re.search(r"budget_limit\(|1000|HARD_BUDGET_CAP", text) and not sf.is_test:
        line = sf.line_of(text.index("MONTHLY_BUDGET_USD"))
        out.append(finding("BUDGET-UNCAPPED-ENV", "HIGH", CAT_PY, sf.rel, line, "MONTHLY_BUDGET_USD is used without enforcing the $1000 cap",
                           "A mis-set secret (e.g. 100000) would silently lift the spending limit. Validate it with `budget_limit()`.", sf.lines[line - 1], key="budget-env"))
    for node in ast.walk(tree):
        if isinstance(node, ast.Call) and dotted(node.func) in ("int", "float", "Decimal") and node.args and isinstance(node.args[0], ast.Call):
            inner = node.args[0]
            if dotted(inner.func) in ("os.getenv", "os.environ.get") and len(inner.args) == 1 and not inner.keywords:
                add("PY-ENV-NO-FALLBACK", "MEDIUM", CAT_PY, node, f"`{dotted(node.func)}({dotted(inner.func)}(...))` with no default",
                    "An unset variable yields `None`, so the conversion raises TypeError at startup/mid-run. Provide a default or validate explicitly.", key=clip(sf.lines[node.lineno - 1], 100))
    return out


RULES = (
    rule_mojibake, rule_secrets, rule_routes, rule_usa_filter, rule_timezone, rule_stripe, rule_prisma_usage, rule_prisma_schema,
    rule_jsonld, rule_links, rule_imports, rule_js_safety, rule_email_privacy, rule_auth_flows, rule_ai_budget_js,
    rule_package_json, rule_json_data, rule_workflow, rule_python,
)


def scan_source(sf: SourceFile, ctx: Context) -> list[dict]:
    found: list[dict] = []
    for rule in RULES:
        try:
            found.extend(rule(sf, ctx))
        except Exception as error:  # a rule bug must never abort the audit
            LOG.warning("Rule %s failed on %s: %s", rule.__name__, sf.rel, error)
    return assign_ids(found)


# --------------------------------------------------------------------------------------------
# Compiler / schema tools
# --------------------------------------------------------------------------------------------

class ToolResult:
    def __init__(self, status: str, findings: list[dict] | None = None, detail: str = "") -> None:
        self.status = status
        self.findings = findings or []
        self.detail = detail


TSC_LINE = re.compile(r"^(?P<file>[^\n(]+?)\((?P<line>\d+),(?P<col>\d+)\): error (?P<code>TS\d+): (?P<msg>.*)$")
TSC_GLOBAL = re.compile(r"^error (?P<code>TS\d+): (?P<msg>.*)$")


def parse_tsc(output: str, root: Path, label: str) -> list[dict]:
    out = []
    for raw in output.splitlines():
        raw = raw.strip()
        match = TSC_LINE.match(raw)
        if match:
            file = match.group("file").replace("\\", "/")
            try:
                file = Path(file).resolve().relative_to(root.resolve()).as_posix() if Path(file).is_absolute() else file
            except ValueError:
                pass
            code, msg, line, col = match.group("code"), match.group("msg"), int(match.group("line")), int(match.group("col"))
            fix = None
            name = re.match(r"'([\w.]+)' is possibly '(?:undefined|null)'", msg)
            if code in ("TS18048", "TS18047") and name:
                fix = {"kind": "tsc-optional-chain", "line": line, "col": col - 1, "name": name.group(1)}
            out.append(finding(f"TSC-{code}", "HIGH", CAT_BUILD, file, line, f"TypeScript {code}: {clip(msg, 120)}",
                               f"`npx tsc --noEmit` ({label}) reports: {msg.rstrip('.')}. The type check (CI `verify:zero-mistakes`) fails until this is fixed.",
                               "", key=f"{code}:{msg}", fix=fix, scope="global", tool="tsc"))
            continue
        match = TSC_GLOBAL.match(raw)
        if match:
            out.append(finding(f"TSC-{match.group('code')}", "HIGH", CAT_BUILD, label, 1, f"TypeScript {match.group('code')}: {clip(match.group('msg'), 120)}",
                               f"`npx tsc --noEmit` ({label}) reports: {match.group('msg')}.", "", key=raw, scope="global", tool="tsc"))
    return out


class Tools:
    """Runs the compilers. Overridden in tests."""

    def __init__(self, root: Path) -> None:
        self.root = root

    def _bin(self, name: str) -> bool:
        base = self.root / "node_modules" / ".bin"
        return any((base / f"{name}{suffix}").exists() for suffix in ("", ".cmd", ".ps1"))

    def _run(self, command: list[str], timeout: int = 600, env: dict | None = None) -> tuple[int, str]:
        try:
            completed = subprocess.run(command, cwd=self.root, capture_output=True, text=True, encoding="utf-8", errors="replace",
                                       timeout=timeout, env={**os.environ, **(env or {})})
        except (OSError, subprocess.TimeoutExpired) as error:
            return -1, f"{type(error).__name__}: {error}"
        return completed.returncode, (completed.stdout or "") + "\n" + (completed.stderr or "")

    def run_tsc(self) -> ToolResult:
        npx = shutil.which("npx")
        if not npx or not self._bin("tsc"):
            return ToolResult("SKIPPED", detail="typescript is not installed (run npm ci)")
        projects = [[]] if (self.root / "tsconfig.json").is_file() else []
        apps = self.root / "apps"
        if apps.is_dir():
            projects += [["-p", f"apps/{p.name}"] for p in sorted(apps.iterdir()) if (p / "tsconfig.json").is_file()]
        findings: list[dict] = []
        seen = set()
        failed = 0
        for extra in projects:
            label = extra[1] if extra else "tsconfig.json"
            code, output = self._run([npx, "--no-install", "tsc", "--noEmit", "--pretty", "false", *extra])
            parsed = parse_tsc(output, self.root, label)
            if code != 0 and not parsed:
                parsed = [finding("TSC-RUN-FAILED", "HIGH", CAT_BUILD, label, 1, "tsc could not complete", clip(output, 400), "", key=clip(output, 200), scope="global", tool="tsc")]
            for item in parsed:
                signature = (item["file"], item["line"], item["rule"], item["_key"])
                if signature not in seen:
                    seen.add(signature)
                    findings.append(item)
            failed += code != 0
        return ToolResult("FAIL" if findings else "PASS", assign_ids(findings), f"{len(projects)} project(s), {len(findings)} error(s)")

    def run_prisma(self) -> ToolResult:
        npx = shutil.which("npx")
        schemas = [p for p in iter_files(self.root) if p.suffix == ".prisma"]
        if not schemas:
            return ToolResult("SKIPPED", detail="no schema.prisma found")
        if not npx or not self._bin("prisma"):
            return ToolResult("SKIPPED", detail="prisma is not installed (run npm ci)")
        findings = []
        for schema in schemas:
            rel = schema.relative_to(self.root).as_posix()
            code, output = self._run([npx, "--no-install", "prisma", "validate", "--schema", rel],
                                     env={"DATABASE_URL": os.environ.get("DATABASE_URL", "file:./dev.db"), "PRISMA_HIDE_UPDATE_MESSAGE": "1"})
            if code == 0:
                continue
            location = re.search(r"-->\s+(\S+):(\d+)", output)
            message = re.findall(r"^error:\s*(.+)$", output, re.M)
            file = location.group(1).replace("\\", "/") if location else rel
            if not (self.root / file).exists():
                file = rel
            text = "; ".join(message[:2]) if message else clip(re.sub(r"npm notice[^\n]*", "", output), 300)
            findings.append(finding("PRISMA-VALIDATE", "HIGH", CAT_BUILD, file, int(location.group(2)) if location else 1,
                                    "prisma validate failed", f"`npx prisma validate --schema {rel}`: {text}", "", key=clip(text, 200), scope="global", tool="prisma"))
        return ToolResult("FAIL" if findings else "PASS", assign_ids(findings), f"{len(schemas)} schema(s)")

    def run_pycompile(self) -> ToolResult:
        files = sorted((self.root / "agents").glob("*.py")) if (self.root / "agents").is_dir() else []
        if not files:
            return ToolResult("SKIPPED", detail="no agents/*.py")
        findings = []
        for path in files:
            rel = path.relative_to(self.root).as_posix()
            code, output = self._run([sys.executable, "-m", "py_compile", rel], timeout=120)
            if code == 0:
                continue
            line = re.findall(r'line (\d+)', output)
            message = re.findall(r"^(\w*Error: .*)$", output, re.M)
            text = message[-1] if message else clip(output, 200)
            findings.append(finding("PYCOMPILE", "HIGH", CAT_BUILD, rel, int(line[-1]) if line else 1, f"py_compile: {clip(text, 100)}",
                                    f"`python -m py_compile {rel}` fails: {text}. The agent cannot start.", "", key=text, scope="global", tool="py_compile"))
        return ToolResult("FAIL" if findings else "PASS", assign_ids(findings), f"{len(files)} file(s)")


# --------------------------------------------------------------------------------------------
# Auto-fix
# --------------------------------------------------------------------------------------------

def apply_fixes(text: str, fixes: list[dict]) -> tuple[str, int]:
    lines = text.split("\n")
    applied = 0
    for fix in sorted(fixes, key=lambda f: (f["line"], f.get("col", 0)), reverse=True):
        index = fix["line"] - 1
        if not 0 <= index < len(lines):
            continue
        line = lines[index]
        kind = fix["kind"]
        if kind == "replace" and fix["old"] in line:
            lines[index] = line.replace(fix["old"], fix["new"], 1)
        elif kind == "splice":
            col = fix["col"]
            if line[col: col + len(fix["old"])] != fix["old"]:
                continue
            lines[index] = line[:col] + fix["new"] + line[col + len(fix["old"]):]
        elif kind == "tsc-optional-chain":
            col, name = fix["col"], fix["name"]
            end = col + len(name)
            if line[col:end] != name or line[end: end + 1] != "." or line[end: end + 2] == "..":
                continue
            lines[index] = line[:end] + "?." + line[end + 1:]
        elif kind == "py-encoding":
            col = byte_col_to_char(line, fix["col"])
            if line[col: col + 1] != ")":
                continue
            lines[index] = line[:col] + (', encoding="utf-8"' if fix["has_args"] else 'encoding="utf-8"') + line[col:]
        else:
            continue
        applied += 1
    return "\n".join(lines), applied


def verify_python(root: Path, rel: str) -> bool:
    try:
        ast.parse((root / rel).read_text(encoding="utf-8"))
        return True
    except (SyntaxError, ValueError):
        return False


def run_auto_fix(root: Path, ctx: Context, findings: list[dict], tools: Tools) -> tuple[list[dict], list[str]]:
    """Patches fixable findings file by file; a patch is kept only if verification still passes.

    Returns (fixed findings, notes)."""
    notes: list[str] = []
    by_file: dict[str, list[dict]] = {}
    for item in findings:
        if item.get("_fix"):
            by_file.setdefault(item["file"], []).append(item)
    if not by_file:
        return [], ["No deterministic fixes were applicable."]
    baseline = tools.run_tsc()
    baseline_count = len(baseline.findings) if baseline.status in ("PASS", "FAIL") else None
    fixed: list[dict] = []
    for rel, items in sorted(by_file.items()):
        path = root / rel
        suffix = path.suffix.lower()
        try:
            original = path.read_bytes()
            before = original.decode("utf-8")
        except (OSError, UnicodeDecodeError):
            continue
        patched, applied = apply_fixes(before, [i["_fix"] for i in items])
        if not applied or patched == before:
            continue
        if suffix in JS_EXTS and baseline_count is None and any(i["_fix"]["kind"] != "replace" or i["rule"] != "ENC-MOJIBAKE" for i in items):
            notes.append(f"Skipped {rel}: tsc is unavailable, so code patches could not be verified.")
            continue
        newline = "\r\n" if b"\r\n" in original else "\n"
        path.write_bytes(patched.replace("\r\n", "\n").replace("\n", newline).encode("utf-8"))
        ok = True
        if suffix == ".py":
            ok = verify_python(root, rel)
        elif suffix in JS_EXTS and baseline_count is not None:
            after = tools.run_tsc()
            ok = after.status in ("PASS", "FAIL") and len(after.findings) <= baseline_count
            if ok:
                baseline_count = len(after.findings)
        elif suffix == ".json":
            try:
                json.loads(patched.lstrip("\ufeff"))
            except ValueError:
                ok = False
        if not ok:
            path.write_bytes(original)
            notes.append(f"Reverted {rel}: verification failed after patching.")
            continue
        for item in items:
            item["fix"] = f"Auto-fixed ({item['_fix']['kind']}); verified with " + ("tsc --noEmit" if suffix in JS_EXTS and baseline_count is not None else "syntax check")
            fixed.append(item)
        notes.append(f"Patched {rel} ({applied} fix(es)).")
    return fixed, notes


# --------------------------------------------------------------------------------------------
# Budget ledger + optional LLM review
# --------------------------------------------------------------------------------------------

class BudgetExceeded(RuntimeError):
    pass


def read_ledger(path: Path) -> dict:
    data = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(data, dict) or data.get("version") != 1 or not isinstance(data.get("months"), dict):
        raise BudgetExceeded("Ledger missing or invalid; refusing to reset it.")
    for month, entries in data["months"].items():
        if not re.fullmatch(r"\d{4}-\d{2}", month) or not isinstance(entries, list):
            raise BudgetExceeded("Invalid ledger month.")
        for entry in entries:
            amount = Decimal(entry["charged_usd"])
            if not amount.is_finite() or amount < 0 or entry["state"] not in ("reserved", "settled"):
                raise BudgetExceeded("Invalid ledger entry.")
    return data


def budget_limit(raw: str) -> Decimal:
    try:
        amount = Decimal(raw)
    except InvalidOperation as error:
        raise BudgetExceeded("MONTHLY_BUDGET_USD is not a number.") from error
    if not amount.is_finite() or not Decimal("0") < amount <= HARD_BUDGET_CAP:
        raise BudgetExceeded("MONTHLY_BUDGET_USD must be positive and cannot exceed $1000.")
    return amount


def reserve_budget(root: Path, cost: Decimal, limit: Decimal, label: str, run_id: str, now: datetime | None = None) -> str:
    """Appends a reserved entry; aborts before the monthly cap would be reached."""
    path = root / LEDGER_PATH
    month = (now or datetime.now(timezone.utc)).strftime("%Y-%m")
    ledger = read_ledger(path)
    entries = ledger["months"].setdefault(month, [])
    spent = sum((Decimal(e["charged_usd"]) for e in entries), Decimal("0"))
    if spent >= limit or spent + cost >= limit:
        raise BudgetExceeded(f"Budget hard-stop for {month}: ${spent} spent/reserved; another ${cost} would reach ${limit}.")
    identifier = str(uuid4())
    entries.append({"id": identifier, "run_id": run_id, "job_id": label, "agent": "bug-hunter", "state": "reserved", "charged_usd": str(cost), "model": MODEL})
    atomic_write_json(path, ledger)
    return identifier


def settle_budget(root: Path, identifier: str, prompt_tokens: int, completion_tokens: int) -> None:
    path = root / LEDGER_PATH
    ledger = read_ledger(path)
    matches = [e for entries in ledger["months"].values() for e in entries if e["id"] == identifier]
    if len(matches) != 1 or matches[0]["state"] != "reserved":
        raise BudgetExceeded("Reservation is missing or already settled.")
    prompt_tokens, completion_tokens = max(0, int(prompt_tokens)), min(max(0, int(completion_tokens)), MAX_OUTPUT_TOKENS)
    reserved = Decimal(matches[0]["charged_usd"])
    actual = prompt_tokens * INPUT_RATE + completion_tokens * OUTPUT_RATE
    matches[0].update(state="settled", prompt_tokens=prompt_tokens, completion_tokens=completion_tokens, charged_usd=str(min(actual, reserved)))
    atomic_write_json(path, ledger)


LLM_SYSTEM_PROMPT = (
    "You are a principal QA security and reliability engineer reviewing one source file from a Next.js + Prisma/SQLite + Stripe monorepo "
    "with Python budget-guarded agents. Report only concrete, reproducible defects visible in the code. Categories: "
    + "; ".join(CATEGORIES) + ". Focus on: unprotected routes (/api/cron, /api/track), missing CRON_SECRET or unsubscribe validation, "
    "timezone bugs in the daily 20-sticker reset, Stripe charges under $0.50, missing cost_ledger.json budget aborts, any path where origin_country "
    "is not exactly 'USA' could reach the storefront, broken /go/[productId] redirects, malformed JSON-LD. No style nits. "
    'Reply with JSON: {"defects":[{"line":int,"severity":"CRITICAL|HIGH|MEDIUM|LOW","category":str,"title":str,"detail":str}]}. '
    "Return an empty list if you find nothing you can justify."
)
SECRET_LINE = re.compile(r"(?i)(secret|token|password|api[_-]?key|private[_-]?key)\s*[:=]\s*[\"'][^\"']{8,}[\"']")


def redact_secret_line(line: str) -> str:
    """Never send credential-looking literals to the LLM provider."""
    return SECRET_LINE.sub(lambda m: f'{m.group(1)} = "[REDACTED]"', line)


def llm_candidates(files: list[SourceFile]) -> list[SourceFile]:
    return [f for f in files if f.ext in (JS_EXTS | {".py", ".yml", ".yaml", ".prisma"}) and not f.is_test
            and 0 < len(f.text.encode("utf-8")) <= MAX_LLM_FILE_BYTES]


def call_llm(api_key: str, prompt: str) -> tuple[dict, int, int]:
    body = json.dumps({"model": MODEL, "temperature": 0, "max_tokens": MAX_OUTPUT_TOKENS, "response_format": {"type": "json_object"},
                       "messages": [{"role": "system", "content": LLM_SYSTEM_PROMPT}, {"role": "user", "content": prompt}]}).encode("utf-8")
    request = urllib.request.Request("https://api.openai.com/v1/chat/completions", data=body, method="POST",
                                     headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"})
    with urllib.request.urlopen(request, timeout=90) as response:
        payload = json.loads(response.read().decode("utf-8"))
    usage = payload.get("usage") or {}
    content = json.loads(payload["choices"][0]["message"]["content"])
    return content, int(usage.get("prompt_tokens", 0)), int(usage.get("completion_tokens", 0))


def llm_review(root: Path, files: list[SourceFile], api_key: str, limit: Decimal, run_cap: Decimal, max_files: int,
               caller=call_llm) -> tuple[list[dict], dict]:
    stats = {"enabled": True, "files_reviewed": 0, "spent_usd": "0", "stopped": ""}
    findings: list[dict] = []
    spent = Decimal("0")
    run_id = str(uuid4())
    for sf in llm_candidates(files)[:max_files]:
        numbered = "\n".join(f"{n}: {redact_secret_line(line)}" for n, line in enumerate(sf.lines, 1))
        prompt = f"File: {sf.rel}\n\n{numbered}"
        in_tokens = math.ceil(len(prompt.encode("utf-8")) / 2)
        cost = in_tokens * INPUT_RATE + MAX_OUTPUT_TOKENS * OUTPUT_RATE
        if spent + cost > run_cap:
            stats["stopped"] = f"per-run LLM cap ${run_cap} reached"
            break
        try:
            reservation = reserve_budget(root, cost, limit, f"bug-hunter:{sf.rel}", run_id)
        except BudgetExceeded as error:
            stats["stopped"] = str(error)
            break
        spent += cost
        try:
            content, prompt_tokens, completion_tokens = caller(api_key, prompt)
        except (urllib.error.URLError, OSError, ValueError, KeyError) as error:
            stats["stopped"] = f"LLM request failed ({type(error).__name__}); reservation retained"
            LOG.warning("LLM review failed for %s: %s", sf.rel, error)
            continue
        settle_budget(root, reservation, prompt_tokens, completion_tokens)
        spent += min(Decimal(prompt_tokens) * INPUT_RATE + Decimal(completion_tokens) * OUTPUT_RATE, cost) - cost
        stats["files_reviewed"] += 1
        for defect in (content.get("defects") if isinstance(content, dict) else None) or []:
            try:
                line = int(defect["line"])
                severity = str(defect["severity"]).upper()
                if not 1 <= line <= len(sf.lines) or severity not in SEVERITIES:
                    continue
                category = defect.get("category") if defect.get("category") in CATEGORIES else CAT_DATA
                title = clip(str(defect["title"]), 140)
                findings.append(finding("LLM-REVIEW", severity, category, sf.rel, line, title, clip(str(defect.get("detail", "")), 600),
                                        sf.lines[line - 1], key=f"{title.lower()}|{clip(sf.lines[line - 1], 80)}", scope="file", tool="llm"))
            except (KeyError, TypeError, ValueError):
                continue
    stats["spent_usd"] = str(spent.quantize(Decimal("0.000001")))
    return assign_ids(findings), stats


# --------------------------------------------------------------------------------------------
# State, merge and report
# --------------------------------------------------------------------------------------------

def iter_files(root: Path):
    for current, dirs, files in os.walk(root):
        dirs[:] = sorted(d for d in dirs if d not in SKIP_DIRS)
        for name in sorted(files):
            path = Path(current) / name
            if path.suffix.lower() in SCAN_EXTENSIONS and name not in SKIP_FILES and not name.endswith(".tmp"):
                yield path


def new_state() -> dict:
    return {"version": STATE_VERSION, "session_id": "", "session_count": 0, "last_run_timestamp": "", "scanned_file_hashes": {},
            "route_fingerprints": {}, "tool_runs": {}, "llm": {}, "open_defects": [], "resolved_defects": [], "content_fingerprint": ""}


def load_state(root: Path) -> dict:
    path = root / STATE_PATH
    if not path.is_file():
        return new_state()
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        if isinstance(data, dict) and data.get("version") == STATE_VERSION:
            return {**new_state(), **data}
    except ValueError:
        LOG.warning("State file is corrupt; starting a fresh session history.")
    return new_state()


def public(defect: dict) -> dict:
    return {k: v for k, v in defect.items() if not k.startswith("_")}


def merge_defects(previous: dict, fresh: list[dict], rescanned: set[str], deleted: set[str], tools_run: set[str],
                  autofixed: list[dict], now: str, session_id: str) -> tuple[list[dict], list[dict]]:
    prev_open = {d["id"]: d for d in previous["open_defects"]}
    resolved = {d["id"]: d for d in previous["resolved_defects"]}
    fresh_by_id = {f["id"]: public(f) for f in fresh}
    autofixed_ids = {f["id"] for f in autofixed}
    open_out: dict[str, dict] = {}

    for defect_id, defect in prev_open.items():
        reevaluated = (defect.get("tool") in tools_run) if defect.get("scope") == "global" else (defect["file"] in rescanned or defect["file"] in deleted)
        if not reevaluated:
            open_out[defect_id] = defect
        elif defect_id not in fresh_by_id and defect_id not in autofixed_ids:
            resolved[defect_id] = {**defect, "status": "VERIFIED", "resolved_at": now, "resolved_session": session_id}
    for defect_id, defect in fresh_by_id.items():
        origin = prev_open.get(defect_id) or resolved.pop(defect_id, None)
        merged = {**defect, "status": "OPEN", "first_seen": origin["first_seen"] if origin else now,
                  "first_session": origin["first_session"] if origin else session_id, "last_seen": now}
        if origin and defect_id not in prev_open:
            merged["reopened"] = True
        open_out[defect_id] = merged
    for defect_id, defect in list(resolved.items()):
        if defect.get("status") == "AUTO-FIXED" and defect["file"] in rescanned and defect_id not in fresh_by_id and defect_id not in autofixed_ids:
            resolved[defect_id] = {**defect, "status": "VERIFIED", "resolved_at": now, "resolved_session": session_id}
    for item in autofixed:
        origin = prev_open.get(item["id"])
        resolved[item["id"]] = {**public(item), "status": "AUTO-FIXED", "first_seen": origin["first_seen"] if origin else now,
                                "first_session": origin["first_session"] if origin else session_id, "last_seen": now, "resolved_at": now, "resolved_session": session_id}
        open_out.pop(item["id"], None)
    history = sorted(resolved.values(), key=lambda d: d.get("resolved_at", ""), reverse=True)[:MAX_RESOLVED_HISTORY]
    return sorted(open_out.values(), key=defect_order), history


def defect_order(d: dict):
    return (SEVERITIES.index(d["severity"]), d["file"], d["line"], d["id"])


def cell(value: str) -> str:
    return str(value).replace("|", "\\|").replace("\n", "<br>")


def render_report(state: dict, summary: dict) -> str:
    open_defects = [d for d in state["open_defects"]]
    fixed = [d for d in state["resolved_defects"] if d["status"] == "AUTO-FIXED"]
    verified = [d for d in state["resolved_defects"] if d["status"] == "VERIFIED"]
    lines = [
        "# BUG REPORT", "",
        "_Generated by `agents/bug_hunter_agent.py`. Do not edit by hand: state lives in `data/qa_session_state.json`._", "",
        f"- **Session:** `{state['session_id']}` (#{state['session_count']})",
        f"- **Last run:** {state['last_run_timestamp']}",
        f"- **Scan mode:** {summary['mode']} - {summary['scanned']} of {summary['total']} files scanned, {summary['skipped']} unchanged (SHA-256), {summary['deleted']} removed",
        f"- **Open defects:** {len(open_defects)} | **Auto-fixed:** {len(fixed)} | **Verified resolved:** {len(verified)}", "",
        "## Summary", "", "| Severity | OPEN | AUTO-FIXED | VERIFIED |", "|---|---|---|---|",
    ]
    for severity in SEVERITIES:
        lines.append(f"| {severity} | {sum(d['severity'] == severity for d in open_defects)} | {sum(d['severity'] == severity for d in fixed)} | {sum(d['severity'] == severity for d in verified)} |")
    lines += ["", "## Compiler, schema and budget checks", "", "| Check | Result | Detail |", "|---|---|---|"]
    for name, run in sorted(state["tool_runs"].items()):
        lines.append(f"| `{name}` | {run['status']} | {cell(run.get('detail', ''))} |")
    llm = state.get("llm") or {}
    if llm.get("enabled"):
        lines.append(f"| LLM review | {llm.get('files_reviewed', 0)} file(s) | spent ${llm.get('spent_usd', '0')} (ledger: `data/cost_ledger.json`){'; ' + cell(llm['stopped']) if llm.get('stopped') else ''} |")
    else:
        lines.append("| LLM review | SKIPPED | enable with `--llm` and `LLM_API_KEY`; spend is reserved in `data/cost_ledger.json` and capped at $1,000/month |")
    for note in summary.get("autofix_notes", []):
        lines.append(f"| Auto-fix | NOTE | {cell(note)} |")

    shown = open_defects + fixed
    for severity in SEVERITIES:
        group = sorted((d for d in shown if d["severity"] == severity), key=defect_order)
        lines += ["", f"## {severity} ({sum(d['status'] == 'OPEN' for d in group)} open)", ""]
        if not group:
            lines.append("_None._")
            continue
        lines += ["| ID | File : Line | Category | Status | Root cause / reproduction |", "|---|---|---|---|---|"]
        for d in group:
            detail = f"**{cell(d['title'])}**<br>{cell(d['detail'])}"
            if d.get("snippet"):
                detail += f"<br>`{cell(d['snippet']).replace('`', chr(39))}`"
            if d.get("fix"):
                detail += f"<br>_Fix:_ {cell(d['fix'])}"
            if d.get("reopened"):
                detail += "<br>_Regressed: previously resolved._"
            lines.append(f"| `{d['id']}` | `{d['file']}:{d['line']}` | {d['category']} | {d['status']} | {detail} |")
    lines += ["", "## Recently verified (fixed and confirmed by rescan)", ""]
    if verified:
        lines += ["| ID | File | Category | Severity | Resolved |", "|---|---|---|---|---|"]
        for d in verified[:25]:
            lines.append(f"| `{d['id']}` | `{d['file']}:{d['line']}` | {d['category']} | {d['severity']} | {d.get('resolved_at', '')} |")
    else:
        lines.append("_Nothing verified yet._")
    return "\n".join(lines) + "\n"


def fingerprint(state: dict) -> str:
    material = {
        "hashes": state["scanned_file_hashes"],
        "open": [(d["id"], d["line"], d["status"]) for d in state["open_defects"]],
        "resolved": [(d["id"], d["status"]) for d in state["resolved_defects"]],
        "tools": {k: v["status"] for k, v in state["tool_runs"].items()},
        "routes": state["route_fingerprints"],
    }
    return sha256_bytes(json.dumps(material, sort_keys=True).encode("utf-8"))


# --------------------------------------------------------------------------------------------
# Orchestration
# --------------------------------------------------------------------------------------------

def read_source(root: Path, path: Path) -> SourceFile | None:
    try:
        return SourceFile(path.relative_to(root).as_posix(), path.read_bytes().decode("utf-8", errors="replace").replace("\r\n", "\n"))
    except OSError:
        return None


def run_audit(root: Path, *, full_scan: bool = False, auto_fix: bool = False, llm: bool = False, run_tools: bool = True,
              tools: Tools | None = None, llm_run_cap: Decimal = Decimal("1.00"), llm_max_files: int = 20, llm_caller=call_llm,
              force_write: bool = False) -> dict:
    root = root.resolve()
    started = time.monotonic()
    state = load_state(root)
    now = utc_now()
    session_id = str(uuid4())
    tools = tools or Tools(root)
    ctx = Context(root)
    try:
        ctx.budget_limit = budget_limit(os.environ.get("MONTHLY_BUDGET_USD", "1000"))
    except BudgetExceeded as error:
        LOG.warning("%s Using the $1000 hard cap.", error)

    files = list(iter_files(root))
    hashes: dict[str, str] = {}
    for path in files:
        try:
            hashes[path.relative_to(root).as_posix()] = sha256_bytes(path.read_bytes())
        except OSError:
            continue
    previous_hashes = {} if full_scan else state["scanned_file_hashes"]
    changed = {rel for rel, digest in hashes.items() if previous_hashes.get(rel) != digest}
    deleted = set(state["scanned_file_hashes"]) - set(hashes)
    for app, digest in ctx.route_fingerprints.items():
        if state["route_fingerprints"].get(app) != digest:
            changed |= {rel for rel in hashes if rel.startswith(f"apps/{app}/")}
    changed |= {d["file"] for d in state["resolved_defects"] if d["status"] == "AUTO-FIXED" and d["file"] in hashes}
    mode = "FULL" if full_scan or not state["scanned_file_hashes"] else "INCREMENTAL"

    sources = {rel: sf for rel in sorted(changed) if (sf := read_source(root, root / rel))}
    fresh: list[dict] = []
    for sf in sources.values():
        fresh.extend(scan_source(sf, ctx))

    tool_results: dict[str, ToolResult] = {}
    relevant = full_scan or not state["scanned_file_hashes"] or bool(changed | deleted)
    if run_tools and relevant:
        if full_scan or any(Path(r).suffix in JS_EXTS | {".json"} for r in changed | deleted):
            tool_results["tsc"] = tools.run_tsc()
        if full_scan or any(r.endswith(".prisma") for r in changed | deleted):
            tool_results["prisma"] = tools.run_prisma()
        if full_scan or any(r.endswith(".py") for r in changed | deleted):
            tool_results["py_compile"] = tools.run_pycompile()
    if run_tools and not tool_results and not state["tool_runs"]:
        tool_results = {"tsc": tools.run_tsc(), "prisma": tools.run_prisma(), "py_compile": tools.run_pycompile()}
    for result in tool_results.values():
        fresh.extend(result.findings)

    llm_stats: dict = state.get("llm") or {}
    if llm:
        api_key = os.environ.get("LLM_API_KEY", "").strip()
        if not api_key:
            llm_stats = {"enabled": False, "stopped": "LLM_API_KEY is not set"}
        elif not (root / LEDGER_PATH).is_file():
            llm_stats = {"enabled": False, "stopped": "cost_ledger.json is missing; refusing to spend without a ledger"}
        else:
            llm_findings, llm_stats = llm_review(root, list(sources.values()), api_key, ctx.budget_limit, llm_run_cap, llm_max_files, llm_caller)
            fresh.extend(llm_findings)

    autofixed: list[dict] = []
    autofix_notes: list[str] = []
    if auto_fix:
        autofixed, autofix_notes = run_auto_fix(root, ctx, fresh, tools)
        if autofixed:
            patched = {f["file"] for f in autofixed}
            for rel in patched:
                path = root / rel
                hashes[rel] = sha256_bytes(path.read_bytes())
                sf = read_source(root, path)
                fresh = [f for f in fresh if not (f["file"] == rel and f.get("scope") == "file")]
                if sf:
                    fresh.extend(scan_source(sf, ctx))
            if run_tools and any(Path(r).suffix in JS_EXTS for r in patched):
                tool_results["tsc"] = tools.run_tsc()
                fresh = [f for f in fresh if f.get("tool") != "tsc"] + tool_results["tsc"].findings
            assign_ids(fresh)
            rescanned_ids = {f["id"] for f in fresh}
            autofixed = [f for f in autofixed if f["id"] not in rescanned_ids]
            changed |= patched
            sources.update({rel: sf for rel in patched if (sf := read_source(root, root / rel))})
        assign_ids(fresh)

    tools_run = set(tool_results)
    open_defects, resolved = merge_defects(state, fresh, set(sources) | deleted, deleted, tools_run, autofixed, now, session_id)
    tool_runs = dict(state["tool_runs"])
    for name, result in tool_results.items():
        tool_runs[name] = {"status": result.status, "detail": result.detail, "timestamp": now}

    new = {
        "version": STATE_VERSION, "session_id": session_id, "session_count": state["session_count"] + 1, "last_run_timestamp": now,
        "scanned_file_hashes": dict(sorted(hashes.items())), "route_fingerprints": ctx.route_fingerprints, "tool_runs": tool_runs,
        "llm": llm_stats, "open_defects": open_defects, "resolved_defects": resolved, "content_fingerprint": "",
    }
    new["content_fingerprint"] = fingerprint(new)
    summary = {"mode": mode, "scanned": len(sources), "total": len(hashes), "skipped": len(hashes) - len(sources), "deleted": len(deleted),
               "autofix_notes": autofix_notes, "autofixed": len(autofixed), "wrote": False, "seconds": round(time.monotonic() - started, 1)}
    unchanged = new["content_fingerprint"] == state.get("content_fingerprint") and (root / REPORT_PATH).is_file() and not autofix_notes
    if unchanged and not full_scan and not force_write:
        summary["note"] = "No material change since the previous session; state and report left untouched."
        summary["open"], summary["state"] = len(state["open_defects"]), state
        return summary
    atomic_write_json(root / STATE_PATH, new)
    atomic_write_text(root / REPORT_PATH, render_report(new, summary))
    summary.update(wrote=True, open=len(open_defects), state=new)
    return summary


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Persistent bug-hunter and defect audit agent.")
    parser.add_argument("--full-scan", action="store_true", help="Rescan every file instead of only SHA-256 changes.")
    parser.add_argument("--auto-fix", action="store_true", help="Patch deterministic bugs and verify with tsc --noEmit.")
    parser.add_argument("--llm", action="store_true", help="Add budget-guarded LLM review (needs LLM_API_KEY).")
    parser.add_argument("--llm-budget-usd", default="1.00", help="Maximum LLM spend for this run (default $1.00).")
    parser.add_argument("--llm-max-files", type=int, default=20)
    parser.add_argument("--no-tools", action="store_true", help="Skip tsc/prisma/py_compile.")
    parser.add_argument("--root", default=str(ROOT))
    parser.add_argument("--fail-on", choices=SEVERITIES, help="Exit 1 if an open defect of this severity or worse exists.")
    args = parser.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
    try:
        cap = Decimal(args.llm_budget_usd)
    except InvalidOperation:
        parser.error("--llm-budget-usd must be a number")
    summary = run_audit(Path(args.root), full_scan=args.full_scan, auto_fix=args.auto_fix, llm=args.llm, run_tools=not args.no_tools,
                        llm_run_cap=cap, llm_max_files=args.llm_max_files)
    state = summary["state"]
    counts = {s: sum(d["severity"] == s for d in state["open_defects"]) for s in SEVERITIES}
    print(f"Bug hunter: {summary['mode']} scan, {summary['scanned']}/{summary['total']} files in {summary['seconds']}s; "
          f"open defects: " + ", ".join(f"{k}={v}" for k, v in counts.items()))
    for note in summary.get("autofix_notes", []):
        print(f"  auto-fix: {note}")
    print(summary.get("note") or f"Wrote {REPORT_PATH} and {STATE_PATH}.")
    if args.fail_on:
        limit = SEVERITIES.index(args.fail_on)
        if any(SEVERITIES.index(d["severity"]) <= limit for d in state["open_defects"]):
            return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
