import { strict as assert } from "node:assert";
import { test } from "node:test";
import { discoveryItem, matchesItem, safeStoreLinks, searchKeywords, suggest, topUsedFor, usedForTags } from "./discovery.ts";
import { parseFeatured, selectTopPicks, topPicks, trendingSearches } from "./dailyFeatured.ts";
import type { Product } from "./usaFilter.ts";

const item = (index: number, extra: Record<string, unknown> = {}) => ({
  id: `item-${index}`, name: `Item ${index}`, description: "Description", price_cents: 500,
  origin_country: "USA", verified_usa_manufacturing: true, review_status: "approved",
  verification_source: "https://example.com/evidence",
  categories: [[], ["Holiday Gift Bundles"], ["family-planning-bundles"]][index % 3], goals: [], ...extra,
}) as unknown as Product;

test("store links are limited to the expected Amazon and Alza search pages", () => {
  const links = safeStoreLinks(item(0, { store_links: {
    amazon: "https://www.amazon.com/s?k=Item+0&tag=winterwell-20", alza: "https://www.alza.sk/search.htm?exps=Item+0", direct: "https://evil.example/" } }));
  assert.deepEqual(links, {
    direct: "/go/item-0",
    amazon: { href: "https://www.amazon.com/s?k=Item+0&tag=winterwell-20", affiliate: true },
    alza: { href: "https://www.alza.sk/search.htm?exps=Item+0", affiliate: false },
  });
  for (const amazon of ["https://www.amazon.com.evil.example/s?k=x", "http://www.amazon.com/s?k=x", "https://www.amazon.com/dp/B000?k=x",
    "https://user@www.amazon.com/s?k=x", "https://www.amazon.com/s?tag=only", "javascript:alert(1)", 7]) {
    assert.equal(safeStoreLinks(item(0, { store_links: { amazon } })).amazon, undefined);
  }
  assert.equal(safeStoreLinks(item(0, { store_links: { alza: "https://www.alza.sk/other.htm?exps=x" } })).alza, undefined);
  assert.deepEqual(safeStoreLinks(item(0, { store_links: "nope" })), { direct: "/go/item-0", amazon: undefined, alza: undefined });
});

test("used-for pills, search matching and autocomplete use sanitized metadata", () => {
  const products = [
    item(0, { name: "Vitamin C Gummies", used_for: ["Immunity Boost", "Winter Energy"], search_keywords: ["vitamin c gummies", "immune support gummies"] }),
    item(1, { name: "Winter Gift Box", used_for: ["Holiday Gift Box", "Immunity Boost", "<img onerror=x>"], search_keywords: ["christmas wellness gift", "NOT LOWERCASE"] }),
    item(2, { name: "Early Result Test Kit", goals: ["Family Planning"], used_for: "broken" }),
  ];
  assert.deepEqual(topUsedFor(products), ["Immunity Boost", "Family Planning", "Holiday Gift Box", "Winter Energy"]);
  assert.deepEqual(usedForTags(products[1]), ["Holiday Gift Box", "Immunity Boost"]);
  assert.deepEqual(searchKeywords(products[1]), ["christmas wellness gift"]);
  const items = products.map(discoveryItem);
  const ids = (query: string, tag: string) => items.filter((entry) => matchesItem(entry, query, tag)).map((entry) => entry.id);
  assert.deepEqual(ids("", ""), ["item-0", "item-1", "item-2"]);
  assert.deepEqual(ids("", "immunity boost"), ["item-0", "item-1"]);
  assert.deepEqual(ids("  GIFT christmas ", ""), ["item-1"]);
  assert.deepEqual(ids("gummies", "Holiday Gift Box"), []);
  assert.deepEqual(ids("", "Holiday Gift Bundles"), ["item-1"]);
  assert.deepEqual(suggest(items, "imm"), [
    { type: "used_for", label: "Immunity Boost", value: "Immunity Boost" },
    { type: "search", label: "immune support gummies", value: "immune support gummies" },
  ]);
  assert.deepEqual(suggest(items, "WINTER").map((entry) => [entry.type, entry.value]), [["used_for", "Winter Energy"], ["product", "item-1"]]);
  assert.deepEqual(suggest(items, "  "), []);
});

test("daily picks match the agent's order and only use a current agent file", () => {
  const products = Array.from({ length: 12 }, (_, index) => item(index, { search_keywords: [`keyword ${index}`] }));
  // tests/test_catalog_linker.py asserts this same order for the Python agent.
  const expected = ["item-5", "item-6", "item-1", "item-2", "item-9", "item-4", "item-8", "item-0"];
  assert.deepEqual(selectTopPicks([...products, item(20, { origin_country: "Canada" })], "2026-11-19").map((p) => p.id), expected);
  const soldOut = products.map((p) => p.id === "item-5" ? { ...p, delivery: { in_stock: false, express: false } } : p);
  assert.ok(!selectTopPicks(soldOut, "2026-11-19").some((p) => p.id === "item-5"));

  const featured = parseFeatured({ version: 1, date: "2026-11-19", top_picks: ["item-3", "missing", "item-3", "item-7"],
    trending_searches: ["keyword 7", "no such product", "<b>bad</b>", "keyword 3"] });
  assert.ok(featured);
  const now = new Date("2026-11-19T23:59:00Z");
  assert.deepEqual(topPicks(products, featured, now).map((p) => p.id), ["item-3", "item-7"]);
  assert.deepEqual(topPicks(products, featured, new Date("2026-11-20T00:00:00Z")).map((p) => p.id), selectTopPicks(products, "2026-11-20").map((p) => p.id));
  assert.deepEqual(topPicks(products, null, now).map((p) => p.id), expected);
  assert.deepEqual(trendingSearches(products, featured), ["keyword 7", "keyword 3"]);
  assert.deepEqual(trendingSearches(products.slice(0, 2), null), ["keyword 0", "keyword 1"]);
  for (const invalid of [null, [], { version: 2, date: "2026-11-19", top_picks: [], trending_searches: [] },
    { version: 1, date: "today", top_picks: [], trending_searches: [] }, { version: 1, date: "2026-11-19", top_picks: [1], trending_searches: [] }]) {
    assert.equal(parseFeatured(invalid), null);
  }
});
