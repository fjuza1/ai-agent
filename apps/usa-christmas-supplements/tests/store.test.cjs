const { test } = require("node:test");
const assert = require("node:assert/strict");
const { mkdtempSync, readFileSync, rmSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const net = require("node:net");

test("discreet packaging requires every selected direct item to support it", async () => {
  const { checkoutSelection } = await import("../lib/checkoutSelection.js");
  const products = [{ id: "kit", discreet_gift_box_available: true }, { id: "other" },
    { id: "external", affiliate_url: "https://example.com", discreet_gift_box_available: true }];
  const form = new FormData();
  form.append("productId", "kit");
  form.set("discreetGiftBox", "yes");
  assert.equal(checkoutSelection(products, form).discreet, true);
  form.append("productId", "other");
  assert.throws(() => checkoutSelection(products, form), /not available for every selected item/);
  form.delete("discreetGiftBox");
  assert.equal(checkoutSelection(products, form).discreet, false);
  form.append("productId", "external");
  assert.throws(() => checkoutSelection(products, form), /unavailable/);
});

test("reviewed products redirect with affiliate tags and expose accurate SEO", { timeout: 60000 }, async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "supplement-store-"));
  const app = path.resolve(__dirname, "..");
  const product = (id, extra = {}) => ({ id, name: `Item ${id}`, description: "A reviewed gift.", price_cents: 500,
    origin_country: "USA", verified_usa_manufacturing: true, review_status: "approved",
    verification_source: "https://example.com/evidence", categories: [], goals: [], ...extra });
  const catalog = path.join(dir, "catalog.json");
  const log = path.join(dir, "clicks.jsonl");
  writeFileSync(catalog, JSON.stringify([
    product("amazon", { affiliate_url: "https://www.amazon.com/dp/example?tag=old", affiliate_type: "amazon",
      aggregate_rating: { rating_value: 4.5, review_count: 7, source_url: "https://example.com/reviews" },
      used_for: ["Immunity Boost", "<script>alert(1)</script>"], search_keywords: ["vitamin c gummies"],
      store_links: { amazon: "https://www.amazon.com/s?k=Item+amazon&tag=sample-20", alza: "https://evil.example/search.htm?exps=Item+amazon" } }),
    product("direct", { affiliate_url: "https://merchant.example/item?foo=bar", affiliate_type: "direct" }),
    product("internal", { used_for: ["Winter Energy"], search_keywords: ["winter energy drops"],
      store_links: { alza: "https://www.alza.sk/search.htm?exps=Item+internal" } }),
    product("family-kit", { categories: ["family-planning-bundles"], fda_cleared_otc: true,
      fda_device_type: "pregnancy_test", fda_device_name: "Example test",
      fda_clearance_source: "https://example.com/clearance", fda_510k_number: "K123456", discreet_gift_box_available: true }),
    product("family-foreign", { categories: ["family-planning-bundles"], origin_country: "Canada" }),
    product("wronghost", { affiliate_url: "https://evil.example/item", affiliate_type: "amazon" }),
    product("foreign", { origin_country: "Canada" }),
  ]));
  writeFileSync(path.join(dir, "daily_featured.json"), JSON.stringify({ version: 1, date: new Date().toISOString().slice(0, 10),
    top_picks: ["internal"], trending_searches: ["winter energy drops", "nothing matches this"] }));
  const listener = net.createServer();
  await new Promise((resolve) => listener.listen(0, "127.0.0.1", resolve));
  const port = listener.address().port;
  await new Promise((resolve) => listener.close(resolve));
  const origin = `http://127.0.0.1:${port}`;
  const env = { ...process.env, SUPPLEMENT_CATALOG_PATH: catalog, AFFILIATE_CLICK_LOG: log,
    AFFILIATE_TAG_AMAZON: "sample-20", AFFILIATE_TAG_DIRECT: "partner-123",
    SUPPLEMENT_APP_URL: origin, NEXT_TELEMETRY_DISABLED: "1" };
  const server = spawn(process.execPath, [require.resolve("next/dist/bin/next"), "start", "-H", "127.0.0.1", "-p", String(port)], { cwd: app, env, stdio: "ignore" });
  try {
    let ready = false;
    for (let i = 0; i < 80; i++) {
      try { ready = (await fetch(origin)).ok; } catch {}
      if (ready) break;
      if (server.exitCode !== null) throw new Error(`Test server exited with ${server.exitCode}`);
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    assert.ok(ready, "test server did not start");
    const amazon = await fetch(`${origin}/go/amazon`, { redirect: "manual" });
    assert.equal(amazon.status, 302);
    assert.equal(new URL(amazon.headers.get("location")).searchParams.get("tag"), "sample-20");
    const direct = await fetch(`${origin}/go/direct`, { redirect: "manual" });
    assert.equal(direct.status, 302);
    assert.equal(new URL(direct.headers.get("location")).searchParams.get("ref"), "partner-123");
    const internal = await fetch(`${origin}/go/internal`, { redirect: "manual" });
    assert.equal(internal.status, 302);
    assert.equal(internal.headers.get("location"), "/product/internal");
    assert.equal((await fetch(`${origin}/go/wronghost`, { redirect: "manual" })).status, 422);
    assert.equal((await fetch(`${origin}/go/foreign`, { redirect: "manual" })).status, 404);
    assert.equal(readFileSync(log, "utf8").trim().split("\n").length, 3);
    const html = await (await fetch(`${origin}/product/amazon`, {
      headers: { "user-agent": "Mozilla/5.0 Chrome/157.0.0.0 Safari/537.36" },
    })).text();
    assert.match(html.split("</head>")[0], /<meta name="description" content="A reviewed gift\."\/?>/);
    assert.match(html, /rel="canonical"/);
    assert.match(html, /Affiliate disclosure/);
    assert.match(html, /Contact us/);
    assert.match(html, /name="productId" value="amazon"/);
    assert.equal((await fetch(`${origin}/api/contact-product`, { method: "POST", body: "{}" })).status, 400);
    const match = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
    assert.ok(match, "Product JSON-LD is present");
    const schemas = JSON.parse(match[1]);
    assert.equal(schemas.find((s) => s["@type"] === "Product").aggregateRating.reviewCount, 7);
    assert.ok(schemas.some((s) => s["@type"] === "FAQPage"));
    const productSchema = schemas.find((s) => s["@type"] === "Product");
    assert.match(html.split("</head>")[0], /<meta name="keywords" content="Immunity Boost,vitamin c gummies"\/?>/);
    assert.equal(productSchema.keywords, "Immunity Boost, vitamin c gummies");
    assert.deepEqual(productSchema.additionalProperty, [{ "@type": "PropertyValue", name: "Used for", value: "Immunity Boost" }]);
    assert.match(html, /href="https:\/\/www\.amazon\.com\/s\?k=Item\+amazon&amp;tag=sample-20"[^>]*rel="nofollow sponsored noopener noreferrer"/);
    assert.doesNotMatch(html, /evil\.example|alert\(1\)/);
    const home = await (await fetch(`${origin}/?used_for=Winter%20Energy`)).text();
    assert.match(home, /Top Picks of the Day/);
    assert.match(home, /Most Searched Right Now/);
    assert.match(home, /aria-pressed="true"[^>]*>Winter Energy</);
    assert.match(home, /1 of 5 products match\./);
    assert.match(home, /href="https:\/\/www\.alza\.sk\/search\.htm\?exps=Item\+internal"[^>]*rel="nofollow noopener noreferrer"/);
    assert.doesNotMatch(home, /nothing matches this/);
    const category = await (await fetch(`${origin}/category/family-planning-bundles`)).text();
    assert.match(category, /FDA-Cleared OTC Medical Device/);
    assert.match(category, /Example test/);
    assert.doesNotMatch(category, /Item family-foreign/);
    const kit = await (await fetch(`${origin}/product/family-kit`)).text();
    assert.match(kit, /FDA-Cleared OTC Medical Device/);
    assert.match(kit, /K123456/);
    assert.match(kit, /Discreet Unbranded Gift Box/);
    assert.doesNotMatch(html, /FDA-Cleared OTC Medical Device/);
    const sitemap = await (await fetch(`${origin}/sitemap.xml`)).text();
    assert.ok(sitemap.includes(`${origin}/product/amazon`));
    assert.ok(!sitemap.includes("/product/foreign"));
    assert.ok(sitemap.includes("/category/family-planning-bundles"));
  } finally {
    if (server.exitCode === null) {
      server.kill();
      await new Promise((resolve) => server.once("exit", resolve));
    }
    rmSync(dir, { recursive: true, force: true });
  }
});
