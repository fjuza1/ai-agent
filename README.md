# Commerce and agent fleet monorepo

Two Next.js applications, a reviewed product catalog and an asyncio worker fleet.
The stores have empty catalogs until you supply real products and credentials.

> **Not production-ready yet.** The payment and ownership paths are implemented
> and tested locally, but launch requires live Stripe/Connect and webhook testing,
> account security and abuse controls, durable production database and backups,
> order fulfillment/refunds/disputes, legal and product-label review, a certified
> consent platform, and actual hosting. Do not process real payments until those
> items are complete. No repository alone can guarantee a combined $1,000 bill
> across GitHub, OpenAI, Stripe, hosting, and other providers.

## Requirements and local setup

Node 22.19+, npm, Python 3.12+, Git and a Stripe account are required. On Windows,
use PowerShell or Git Bash. Create `.env` from `.env.example`, populate the
variables, and keep it private. Both apps and the fleet load the root `.env`;
process environment variables take precedence.

```bash
npm install
python -m venv .venv
# Linux/macOS:
. .venv/bin/activate
# Windows PowerShell instead: .venv\Scripts\Activate.ps1
pip install -r requirements.txt
npm run db:push
npm test
npm run typecheck -w usa-christmas-supplements
npm run test:contact
python -m unittest discover -s tests -v
npm run build
npm run test:integration -w sticker-market
npm run test:integration -w usa-christmas-supplements
```

In separate terminals:

```bash
npm run dev -w sticker-market
npm run dev -w usa-christmas-supplements
```

Visit <http://localhost:3000> and <http://localhost:3001>. The `DATABASE_URL`
in `.env.example` uses SQLite at `apps/sticker-market/prisma/dev.db`. `db:push`
is for local development; use reviewed migrations and backups in production.
SQLite requires a persistent disk and a single controlled writer deployment;
it is **not suitable for serverless or multiple ephemeral instances**. Migrate
the Prisma schema to a managed transactional database before scaling.
For a database created from the previous schema, back it up and apply
`apps/sticker-market/prisma/upgrade-existing.sql` **once** before starting the
upgraded app; check the migration on a copy first. A new development database
can instead be created with `npm run db:push`. Existing pre-upgrade pending
pack payments are fulfilled as legacy orders without a retroactive quota debit.

## Deploy both apps to Render

The root `render.yaml` defines two independent Node web services, each with its
own persistent disk and SQLite database. In Render, create a Blueprint from this
repository and apply the `render.yaml` configuration. Persistent disks require
paid web services; the starter plan and 1 GB disk are initial settings, not a
production capacity recommendation. Keep each SQLite database on its service's
disk and run only one instance per service.

Set the `sync: false` variables in each service's Render dashboard before
launching features that need them. Add Stripe keys and configure the sticker
market's `/api/stripe/webhook` endpoint; add email provider credentials for
email features. Set `AUTH_SECRET` to a strong random value for supplement-store
authentication. Update `STICKER_APP_URL`, `SUPPLEMENT_APP_URL`, and `AUTH_URL`
if Render assigns different public service URLs. Each service initializes its
schema on first startup when its database file is absent; use reviewed
migrations and backups for subsequent production schema changes. The apps are
server-rendered and require a server-capable host; GitHub Pages cannot run them.

## Product inquiries

Both product-detail pages offer a contact form. Configure `SENDGRID_API_KEY`,
`SENDGRID_FROM_EMAIL` (a verified SendGrid sender), `SENDGRID_SUPPORT_TO_EMAIL`,
and `SENDGRID_IP_POOL` (an existing dedicated IP pool enabled for the account).
Set `STICKER_APP_URL` and `SUPPLEMENT_APP_URL` to the public origins: these
determine the product links included in inquiries. Keep the API key server-side.

Messages use product-ID categories and enable SendGrid click and open tracking;
consider the privacy implications and any applicable consent requirements. A
successful response means SendGrid accepted the message, not that it was
delivered. HTTP 429 and 5xx responses are retried twice with exponential backoff;
ambiguous failures are not retried, and even a 5xx retry can produce duplicates.
Retries are in-process, not a durable queue. The honeypot and input validation
are basic spam controls, not enterprise abuse protection; deploy shared rate
limits, monitoring, and durable delivery/reconciliation before production.

## Sticker marketplace

- Register/sign in, purchase a three-sticker pack, view serials in `/vault`,
  connect a Stripe Express seller account, list at a custom price, or create a
  seven-day bearer gift link. Share gift links privately. An outstanding gift or
  listing locks that sticker against other transfers. Cancel it in the vault.
- Resales use Stripe Connect destination charges; the buyer pays the listed
  amount, Stripe transfers it to the seller's connected account and the platform
  is responsible for Stripe processing fees. Account onboarding and transfers
  must be enabled in the Stripe dashboard. Prices are in USD.
- Stripe Checkout confirmation is **not** fulfillment. Configure the endpoint
  `/api/stripe/webhook` for `checkout.session.completed` and
  `checkout.session.expired`, set `STRIPE_WEBHOOK_SECRET`, and use the same
  Stripe account and environment as `STRIPE_SECRET_KEY`. Webhooks validate
  signatures and amounts, then atomically fulfill idempotently. Checkout reserves
  listings until payment or expiry. Monitor webhook failures and retry from Stripe.
- On a network failure during checkout creation, the purchase/listing remains
  reserved rather than risk a second sale. Reconcile with Stripe before manually
  releasing it. Refunds, chargebacks, lost links, expired gift cleanup, support
  tooling and automated reconciliation are not yet implemented.
- The starter pack is a simple demonstration product; add artwork, inventory,
  licensing terms, customer support, privacy/terms/refund policies, email
  verification, password recovery, account rate limits, monitoring and security
  review before launch. The cookie-backed password login is a starter, not a
  replacement for a hardened identity provider.

The included 50 original 1024×1024 transparent PNGs are generated locally
without an LLM or network calls:

```bash
python scripts/generate_50_stickers.py
```

New starter packs select three random catalog designs and assign unique serials.
Designs 41–50 cover baby announcements and milestones. Artwork replaced by the
new assortment is retained under `public/stickers/legacy`; existing owned
stickers with the original ID and name continue to display and export that art.
Older stickers without an artwork ID show labeled fallback artwork. Users can
save or share owned artwork from the vault; supported mobile browsers use the
Web Share API with an attached PNG, otherwise the download link is available.

For gift email, configure a verified Resend sender in `GIFT_EMAIL_FROM` and
`RESEND_API_KEY`; leave the optional recipient field blank for a manual claim
link. Email acceptance by the provider does not guarantee delivery. Claim links
expire after seven days and require an explicit signed-in confirmation to avoid
email security scanners claiming gifts. If email submission fails, the sender
gets a clear failure notice and can share the generated link manually.

Sends, gift claims and generated pack stickers share a per-user UTC calendar-day
allowance of 20; the UTC day resets every 24 hours. Paid overages consume one
credit per sticker. A pack reserves three units before Stripe Checkout and its
reservation is released if Checkout expires; ambiguous creation failures remain
reserved for manual reconciliation. Stripe requires a minimum **$0.50 USD**
payment, so a separate two-cent Checkout charge is not supported. Instead,
customers can purchase at least 25 prepaid credits at $0.02 each, with unused
credits retained. Credit purchase and fulfillment use signed, idempotent
webhooks; retry the original action after Stripe confirms payment. See
[Stripe minimum charges](https://docs.stripe.com/currencies#minimum-and-maximum-charge-amounts).
The app requires the configured limit and unit price to remain 20 and 2 cents.

## USA-made supplements

`data/supplements.json` is the published catalog. Every entry must satisfy
`origin_country === "USA"` **and** `verified_usa_manufacturing === true`, have
`review_status: "approved"`, valid price and HTTPS verification evidence.
The storefront and checkout independently filter the catalog; malformed,
foreign, unverified or unapproved products cannot be displayed or purchased.
The ingest command rejects an entire batch if any product fails:

```bash
npm run products:ingest -- path/to/reviewed-products.json
```

Input is a JSON array, for example (values shown are illustrative; do **not**
publish without real evidence and review):

```json
[
  {
    "id": "reviewed-gift",
    "name": "Reviewed wellness gift",
    "description": "A label-reviewed gift package.",
    "price_cents": 2500,
    "image_url": "https://manufacturer.example/product.png",
    "image_width": 800,
    "image_height": 800,
    "origin_country": "USA",
    "verified_usa_manufacturing": true,
    "verification_source": "https://manufacturer.example/evidence",
    "review_status": "approved",
    "categories": ["Holiday Gift Bundles"],
    "goals": ["Winter Wellness"]
  }
]
```

The flags are **assertions, not proof**. A qualified human must independently
verify the manufacturer and evidence, product safety, labels, supply chain,
claims, fulfillment, pricing, and all applicable FTC/FDA and state requirements.
Neither model output nor a company's own unverified claim is automatic proof.
The catalog is initially empty, including the family-planning category: do not
publish sample pregnancy tests or other products without independent review.
Checkout creates a Stripe payment for selected
items and collects a US shipping address; shipping rates, tax, inventory,
order management, fulfillment, refunds and webhook processing must be added
before accepting orders. The package builder sells selected items individually,
not as a pre-priced bundled SKU.

The daily `agents/product_expander_agent.py` reads an optional public JSON feed
from `PRODUCT_DISCOVERY_FEED_URL`, validates public HTTPS product/evidence and
purchase links, fetches and inspects raster image dimensions, and writes only
unapproved entries to `data/product_candidate_drafts.json`. It never writes the
published catalog. Human reviewers must independently verify every claim and
then ingest a reviewed JSON array with `npm run products:ingest`; the importer
requires verified/approved USA manufacturing, measured image dimensions, and
unique product IDs, SKUs, and normalized titles. The actual catalog filename
used by the app is `data/supplements.json`.

### Family planning and FDA claims

Use the category `family-planning-bundles` for reviewed pregnancy test kits and
family-planning gifts. The usual USA-manufacturing and approval checks apply.
Only set `fda_cleared_otc: true` for a pregnancy test device after a qualified
reviewer confirms its FDA clearance, over-the-counter use, and applicability
to the exact named device in the product. Also supply
`fda_device_type: "pregnancy_test"`, `fda_device_name`, and an HTTPS
`fda_clearance_source` linking to the supporting record. An optional
`fda_510k_number` must use the format `K123456`. The badge applies to the named
device, not other contents of a bundle; a URL and flag are assertions, not
automatic verification of clearance. Do not mark vitamins or an entire bundle
as FDA-cleared merely because it contains a cleared device.

Set `discreet_gift_box_available: true` only when the direct seller can fulfill
the unbranded box request. It appears at direct checkout, and the request is
recorded in Stripe Checkout session metadata for fulfillment. External merchants
control their own packaging. The operator must implement and test order
fulfillment before accepting payments, including honoring this preference.

### Hourly spotlight, links and shipping

The home page selects up to ten approved USA products from a deterministic UTC
hour bucket and refreshes the page at the hour boundary. It shows fewer than ten
when the reviewed catalog has fewer; it does not invent products. In December,
in-stock express holiday and family-planning bundles are prioritized. Set optional product fields
`affiliate_url` (HTTPS) and `affiliate_type` (`amazon` or `direct`) and set the
corresponding `AFFILIATE_TAG_AMAZON` or `AFFILIATE_TAG_DIRECT` in `.env`.
`/go/ID` logs a timestamp, product ID and destination type before redirecting;
it stores neither IP addresses nor user agents. Logs default to the ignored
`data/affiliate_clicks.jsonl`; set `AFFILIATE_CLICK_LOG` to an absolute path
on persistent writable storage. Logging is best-effort: a failed write is
logged server-side and the visitor is still redirected. Writes are throttled
to 30 clicks per minute per client using in-memory counters (addresses are not
persisted). Configure
retention, access controls and applicable privacy disclosures before launch.
Amazon links accept only `amazon.com` and its subdomains. Products with an
affiliate URL go to the merchant and cannot be purchased in the local builder.

Optional `delivery` fields include `in_stock`, `express`, and either a reviewed
`estimated_arrival_date` (`YYYY-MM-DD`) or `estimated_delivery_days` (calendar
days, 1–60), an IANA `timezone`, and HTTPS `shipping_source`. The latter computes
an estimate from the current local date, not a guaranteed delivery date. A
countdown is shown **only** for an in-stock express holiday or family-planning bundle with a reviewed
`delivery.guarantee` containing `verified: true`, an ISO `cutoff_at` with timezone
offset, an `arrival_date` before December 24 of the current year, an HTTPS
`evidence_url`, and an IANA `timezone`. Review actual seller terms, capacity,
location restrictions and shipping holidays; do not enable the guarantee based
only on AI output. No cutoff or arrival claim is shown without supporting data.
`SUPPLEMENT_CATALOG_PATH` optionally points to a different absolute catalog path.

Product ratings may be supplied only when supported by real reviews using
`aggregate_rating: { "rating_value": 4.5, "review_count": 7, "source_url":
"https://example.com/reviews" }`. The page displays the same rating and source
used by JSON-LD. Missing ratings and unavailable offers are omitted rather than
fabricated. Both apps expose dynamic sitemaps and robots files and noindex private
gift, account and checkout flows. Set `STICKER_APP_URL` and `SUPPLEMENT_APP_URL`
to the public HTTPS origins in deployment for correct canonical links. Lighthouse
scores depend on deployment, device, third-party ads and real catalog content;
no fixed score can be guaranteed without measuring the deployed sites.

### Daily picks, search and store comparison

`agents/daily_catalog_linker.py` runs daily in the workflow and on demand:

```bash
python agents/daily_catalog_linker.py                       # today (UTC)
python agents/daily_catalog_linker.py --date 2026-12-01     # a specific day
python agents/daily_catalog_linker.py --refresh             # request model labels again
```

- **Top Picks of the Day.** Up to eight in-stock reviewed products are chosen by
  a date-seeded SHA-256 round robin across supplements, `Holiday Gift Bundles`
  and `family-planning-bundles`, and written to `data/daily_featured.json`. The
  storefront uses that file when it is dated today (UTC) and otherwise computes
  the identical rotation itself, so picks still change every 24 hours if a run
  is missed. The file lives next to the catalog (`SUPPLEMENT_CATALOG_PATH`).
- **Discovery metadata.** Each reviewed product in `data/supplements.json` gets
  `used_for`, `search_keywords`, `store_links` and `discovery_meta`. With
  `LLM_API_KEY`, products are labelled in batches of eight; every batch reserves
  its full bounded cost ($0.0088) in `data/cost_ledger.json` before the request
  and counts against `MONTHLY_BUDGET_USD` together with the fleet. At the cap,
  without a key, or when a response is unusable, deterministic labels are built
  from the reviewed `goals` and `categories` instead, and the rotation still
  runs. Model labels are requested again only when a product's name,
  description, categories or goals change, or with `--refresh`.
- **These labels are not human-reviewed.** The agent and the storefront both
  discard labels with unexpected characters or disease and regulatory claim
  wording, but that filter is not a compliance review: read the generated labels
  before relying on them. To pin your own, edit `used_for` and
  `search_keywords` and set `discovery_meta` to `{"source": "manual"}`. The
  agent never changes review or verification fields and never touches products
  that fail the USA approval gate.
- **Store links.** `store_links.amazon` is
  `https://www.amazon.com/s?k=NAME&tag=AFFILIATE_TAG_AMAZON`, `store_links.alza`
  is `https://www.alza.sk/search.htm?exps=NAME` plus the optional
  `ALZA_AFFILIATE_PARAM` (one `name=value` pair), and `store_links.direct` is
  `/go/ID`. The storefront renders only links on exactly those hosts and paths.
  They are **name searches on third-party stores**: the results are not
  reviewed by you and may not be made in the USA, which the buttons state.
  External buttons open in a new tab, are marked Affiliate or External, and use
  `rel="nofollow"` (`sponsored` when tagged). Confirm each affiliate program's
  terms and disclosure rules before enabling tags. The tag is written into the
  committed catalog, so configure it as a repository variable, not a secret.
- **Most Searched Right Now.** Chips are catalog search keywords ordered by
  `/go/` clicks from the last seven days when the agent can read
  `AFFILIATE_CLICK_LOG`, otherwise by a date-seeded order. The storefront does
  not record search queries, and the click log normally lives on the host rather
  than in Actions, so treat the heading as merchandising copy unless you feed
  the agent real analytics.
- **Search and filters.** `components/SmartDiscoveryBar.tsx` filters instantly
  in the browser and keeps `?q=` and `?used_for=` in the URL; without JavaScript
  the same form submits as a normal GET request. Product pages expose the labels
  in `<meta name="keywords">` and in the JSON-LD `Product` (`keywords` and
  `additionalProperty` "Used for").

### Lighthouse SEO gate

Install dependencies, build both apps with `npm run build`, then run
`npm run audit:seo` with Chrome installed and ports 3001 and 3002 available.
Set `CHROME_PATH` if Chrome cannot be found automatically. The audit uses an
isolated test database and fictional catalog, writes HTML and JSON reports to
`reports/lighthouse/`, and exits nonzero if any audited route scores below 97
for SEO or 95 for Accessibility, or cannot be audited. Best practices and
performance are reported but not gated. The push/PR workflow runs the gate, and
the fleet rebuild workflow runs it before publishing build artifacts. Configure branch
protection and your external host to require the gate; this repository does not
deploy the apps and cannot independently block external deployments. Audit results
are not a substitute for testing the real deployed site, products, ads, or
third-party services.

### Accounts, favorites and workday alerts

The supplement store has its own SQLite database (`apps/usa-christmas-supplements/prisma/dev.db`,
same persistence caveats as above) and Auth.js v5 sign-in at `/login` and `/signup`:
email + password (bcrypt) and, when `SENDGRID_API_KEY`/`SENDGRID_FROM_EMAIL` are set, an
email magic link. Set `AUTH_SECRET` (and `AUTH_URL` in production). `npm run dev`/`start` for
the app push the schema automatically; `npm run db:push` does it for both apps.

- `/account/favorites` lists saved products grouped by category. `FavoritePills`
  (`components/FavoritePills.tsx`) is the tap-to-toggle UI: `mode="product"` ("⭐ Save" / "💖 Saved") sits
  on every product card and detail page, `mode="category"` pills appear in a sticky ribbon under the navbar,
  on product pages and in the sign-up/settings forms, and a floating "💖 My Saved Picks" drawer lists saved
  products by category. Taps update the UI optimistically and call `POST /api/favorites/toggle`
  (`{ type: "product", productId, category }` or `{ type: "category", category }`, optional `saved` for
  idempotency). Guests are stored in `localStorage` and merged into the account by `POST /api/favorites/sync`
  on the first page load after sign-in or sign-up. `/account/settings` stores favorite categories, the alert opt-in,
  click tracking opt-in, a GDPR JSON export (`/api/account/export`) and a one-click unsubscribe.
- `.github/workflows/send-product-alerts.yml` calls `POST /api/cron/send-product-alerts` with
  `Authorization: Bearer $CRON_SECRET` at 07/11/15/19 UTC, Mon–Fri. Add the `CRON_SECRET`
  Actions secret and the `SUPPLEMENT_APP_URL` variable. The job emails only verified,
  opted-in users who are due (4 hours minus 15 minutes of scheduler slack), with up to 3
  top-rated products from their categories that were not sent in the last 7 days. Clicks
  (`/api/track/click`, HMAC-signed with `AUTH_SECRET`) are logged in `EmailEngagementLog` only
  for users with tracking enabled and boost those categories; other users get plain links and
  SendGrid tracking disabled. Every email has an unsubscribe link plus RFC 8058 one-click headers.
- Email alerts require a verified address. Verifying through the magic link on an account that
  was created with a password while unverified clears that password (set a new one in Settings),
  so nobody can pre-register someone else's address and keep access to it.

## AdSense and consent

Set `ADSENSE_CLIENT_ID` to `ca-pub-` followed by 16 digits and
`ADSENSE_SLOT_ID` to the numeric ad unit ID. Run `npm run ads:generate` to
generate both `public/ads.txt` files; publish the resulting files at each
domain's root and verify them in AdSense. The script loads only when an ID and
slot are valid **and** the visitor has opted in; browse and marketplace pages
contain responsive placements. The built-in consent banner is only a stub: it
does not implement regional rules, TCF/GPP, opt-out signals, or a certified CMP.
Configure a Google-certified CMP and applicable privacy/cookie notices before
serving ads, especially in the EEA, UK, Switzerland, and US states.

### Collecting public dashboard identifiers

`python agents/browser_key_collector.py` attaches to an open Chrome session and
can save allowlisted public identifiers and a verified SendGrid sender to the
ignored `.env.local` file; API keys and other secrets are excluded from its
output. To
keep dashboard content off hosted model services, configure a local
OpenAI-compatible model with `BROWSER_KEY_COLLECTOR_BASE_URL` (defaults to
`http://127.0.0.1:1234/v1`) and `BROWSER_KEY_COLLECTOR_MODEL` (defaults to
`local-model`). Start the local model server and load a model before running the
script; installing `browser-use` alone does not provide a model server. The
model must support browser-use's structured output and tool calls. The script
rejects non-loopback model URLs. Complete any login
or 2FA prompts in Chrome when asked; extracted values are not printed.

## Daily visual themes and verification

`data/daily_visual_theme.json` is the visual-only theme contract used by both
apps. Its five curated presets and generated active theme are checked for safe
CSS values, card radii, and WCAG AA text contrast (at least 4.5:1). App layouts
map this JSON to CSS custom properties; daily theme updates do not rewrite
application components. The trend agent's visual outputs are limited to this
file and the two generated `public/og/daily-theme.svg` assets (budget
reservations and usage are recorded in the existing fleet ledger). Configure `TREND_FEED_URL` as a
public HTTPS JSON ranking/trend feed; entries may contain shop names, domains,
categories, aesthetics, descriptions, or signal tags. Without usable signals,
the agent explicitly uses a curated preset and does not claim measured trends.
When both the feed and `LLM_API_KEY` are available, the bounded theme request
uses the existing monthly cost ledger and the same public-source network
restrictions as the fleet.

`npm run verify:zero-mistakes` runs TypeScript checks, ESLint on both apps,
theme and catalog validation, production builds, and Lighthouse gates of at
least 97% SEO and 95% Accessibility on every audited route. The scheduled
workflow passes visual and product-candidate artifacts through this gate and
commits them only after all checks pass. It does not use destructive checkout
rollback; failed artifacts are not published. Product candidates are never
automatically promoted into `data/supplements.json`.

## 1,000-agent fleet

`agents/fleet_runner.py` creates 1,000 asyncio workers: 400 source scouts,
300 sticker analysts, and 300 marketing specialists. Network concurrency is
capped at 50. Add uniquely identified jobs to `data/agent_queue.json`:

```json
[
  {"id":"source-001","role":"scout","topic":"Extract manufacturing evidence","source_url":"https://manufacturer.example/product"},
  {"id":"trend-001","role":"analyst","topic":"Seasonal sticker concept"},
  {"id":"guide-001","role":"marketing","topic":"Holiday gift guide","publish_url":"https://your-site.example/already-published-guide"}
]
```

Scouts fetch only the supplied public HTTPS page (no redirects), reject private
DNS destinations, limit the response size, and analyze the text. The fleet does
not autonomously discover new sources, certify manufacturing, publish content,
or create clinical claims. Model outputs are always unapproved drafts in
`data/agent_drafts.json`; reviewers must separately vet and ingest products.
Sticker ideas remain drafts until a human publishes them. Each job ID runs once
after a successful draft; change the ID to request a new analysis.

```bash
python agents/fleet_runner.py --agents 1000 --max-hours 2
```

The maximum allocation is **7,200 seconds per UTC day**. Tasks are cancelled at
the deadline and checkpoints are saved to `data/agent_state.json`; cancellation
is a clean exit with `timed_out` in the checkpoint. Each run reserves its full
requested time upfront, so a crash cannot free time for another run the same
day; smaller subsequent runs are permitted only within the remaining allocation.
Runs crossing UTC midnight reserve time against both calendar days.
The Actions workflow uses a two-minute shutdown buffer to allow checkpointing
before its 120-minute job timeout. A machine or runner killed without warning
can still lose final drafts; the pre-run allocation remains on the remote.

Optional IndexNow pings only run for marketing jobs with `publish_url` on the
explicitly configured `INDEXNOW_HOST` when `INDEXNOW_ENABLED=true` and
`INDEXNOW_KEY` is set. You must serve `https://HOST/KEY.txt` containing that
key and only submit pages you control that are already published. Use GitHub
Actions variables for the host and enable flag, and a secret for the key.

### Cost guardrails and limitations

`MONTHLY_BUDGET_USD` defaults to 1000 and may be lowered but cannot exceed it.
Every queued model request reserves its **full** maximum context and output
cost before any calls. A batch that would reach or exceed the monthly limit
aborts before requests; at the limit the runner exits with code 1. Reservations
are replaced by reported token usage; errors, missing usage, and ambiguous
network failures retain the full reservation. Requests are not retried.
If a run crosses a UTC month boundary, its reservations and reported usage
are conservatively counted in both months, so it may stop earlier than required.

The pinned model `gpt-4.1-mini-2025-04-14` is deprecated but documented with
Structured Outputs support. Rates assumed are $0.40 per million input tokens
and $1.60 per million output tokens. Verify
[current model availability and pricing](https://developers.openai.com/api/docs/models/gpt-4.1-mini)
before running. Changing pricing or the model requires updating code and tests.
There is no automatic model fallback.

The UTC ledger and runtime checkpoints are committed and pushed **before**
paid requests in Actions (`--persist-reservations`); if that push fails, no call
is made. Final actual charges and drafts are then committed, including on errors,
and recovery artifacts are uploaded. Never delete or rewrite ledger history.
Use a dedicated API key and a single canonical main branch: concurrent clones,
other API clients, force-pushes, clock differences, provider pricing/taxes and
other paid services are outside the ledger. Configure a provider-enforced
project cap where available; alerts alone are not necessarily a hard stop.
GitHub Actions, hosting and Stripe have separate billing controls and cannot
be capped by this ledger. A strict overall $1,000 invoice guarantee is not
possible without provider-side caps and accounting for all services.

## GitHub Actions

`.github/workflows/daily-agent-fleet.yml` runs at 02:00 UTC and manually, with
`timeout-minutes: 120`, serialized runs, and a checkpoint artifact. It also runs
on pushes to `main`, but only the free `bug-hunter` job runs then; the paid fleet,
catalog-linker and rebuild jobs are skipped. Configure
`LLM_API_KEY` and `MONTHLY_BUDGET_USD` as repository secrets, permit the
workflow bot to push commits to `main`, and keep `data/cost_ledger.json` and
`data/agent_state.json` intact. The workflow saves checkpoints and unapproved drafts, then validates candidate
visual updates before committing them. Set optional
`TREND_FEED_URL` and `PRODUCT_DISCOVERY_FEED_URL` repository variables to
public JSON feed URLs. The workflow runs the fleet for at most 1.5 hours,
leaving time for builds and Lighthouse within its two-hour job timeout. It does
**not** deploy either site: connect
each Next.js app to an appropriate persistent host and deploy the tested build.
If the final push fails, reconcile the uploaded checkpoint against the remote
reservation before rerunning. GitHub-triggered bot commits do not automatically
trigger other push workflows.

The `catalog-linker` job then rotates the daily picks and refreshes discovery
metadata, committing `data/cost_ledger.json`, `data/supplements.json` and
`data/daily_featured.json`. It runs even when the fleet job fails or stops at
its budget, because the rotation makes no paid requests. Set the optional
repository variables `AFFILIATE_TAG_AMAZON` and `ALZA_AFFILIATE_PARAM` for
tagged store links.

### Bug-hunter and defect audit

`agents/bug_hunter_agent.py` keeps `BUG_REPORT.md` (defects by severity) and
`data/qa_session_state.json` (session id, last run, SHA-256 of every scanned
file, open and resolved defects) current across sessions:

```powershell
python agents/bug_hunter_agent.py              # only files whose SHA-256 changed
python agents/bug_hunter_agent.py --full-scan  # rescan everything
python agents/bug_hunter_agent.py --auto-fix   # patch deterministic bugs, verify with tsc --noEmit
python agents/bug_hunter_agent.py --llm        # add budget-reserved LLM review (LLM_API_KEY)
```

It scans `.ts/.tsx/.js/.jsx/.mjs/.py/.json/.yml/.prisma` for auth and privacy
leaks, Stripe/billing and timezone edge cases, Prisma/SQLite races, broken links
and JSON-LD, USA-origin filter bypasses and Python async/budget guardrails, and
runs `npx tsc --noEmit`, `npx prisma validate` and `python -m py_compile` on
`agents/*.py`; their errors become defects. Defects are `OPEN`, `AUTO-FIXED` (patched
and verified this session) or `VERIFIED` (a later rescan confirmed the fix);
fixed defects that reappear are reopened. `--auto-fix` only applies mechanical
patches (UTF-8 mojibake, `process.env.X.method()` fallbacks, unchecked
`.find()` results, `?.` for TypeScript "possibly undefined", explicit `encoding`)
and reverts any file whose `tsc` error count grows. Run it on a clean working tree.

The LLM review is off by default. With `--llm` each request reserves its cost in
`data/cost_ledger.json` first, secret-looking literals are redacted from the
prompt, the run aborts before `MONTHLY_BUDGET_USD` (maximum $1000) is reached and
spend per run is capped by `--llm-budget-usd` (default $1.00). Unchanged
sessions write nothing, so the report only changes when defects, hashes or
compiler results change. In Actions the `bug-hunter` job runs on every push to
`main` (no LLM, no fleet jobs) and after the daily fleet jobs (with `--llm`), and
commits `BUG_REPORT.md`, `data/qa_session_state.json` and the ledger with
`[skip ci]`.
