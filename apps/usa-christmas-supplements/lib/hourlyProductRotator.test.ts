import { strict as assert } from "node:assert";
import { test } from "node:test";
import { hourBucket, rotateProducts } from "./hourlyProductRotator.ts";
import { deliveryEstimate, verifiedCutoff } from "./delivery.ts";

const item = (index: number) => ({
  id: `item-${index}`, name: `Item ${index}`, description: "Description", price_cents: 500,
  origin_country: "USA", verified_usa_manufacturing: true, review_status: "approved",
  verification_source: "https://example.com/evidence", categories: [], goals: [],
});

test("hourly selection is deterministic, limited to ten, and excludes unverified items", () => {
  const products = Array.from({ length: 20 }, (_, i) => item(i));
  const time = new Date("2026-06-01T10:42:00Z");
  const first = rotateProducts([...products, { ...item(30), origin_country: "Canada" }], time);
  assert.equal(first.length, 10);
  assert.deepEqual(first, rotateProducts([...products].reverse(), new Date("2026-06-01T10:59:59Z")));
  assert.notDeepEqual(first.map((p) => p.id), rotateProducts(products, new Date("2026-06-01T11:00:00Z")).map((p) => p.id));
  assert.equal(hourBucket(time), "2026-06-01T10");
});

test("December priority and delivery guarantees require explicit verified evidence", () => {
  const preferred = { ...item(1), categories: ["Holiday Gift Bundles"], delivery: { in_stock: true, express: true,
    estimated_arrival_date: "2026-12-22",
    guarantee: { verified: true, cutoff_at: "2026-12-20T17:00:00-05:00", arrival_date: "2026-12-23", evidence_url: "https://example.com/terms", timezone: "America/New_York" } } };
  const now = new Date("2026-12-19T12:00:00Z");
  assert.equal(rotateProducts([item(2), preferred], now)[0].id, preferred.id);
  assert.equal(verifiedCutoff([preferred], now)?.productId, preferred.id);
  const family = { ...preferred, categories: ["family-planning-bundles"] };
  assert.equal(rotateProducts([item(2), family], now)[0].id, family.id);
  assert.equal(verifiedCutoff([family], now)?.productId, family.id);
  assert.equal(verifiedCutoff([preferred], new Date("2026-12-21T00:00:00Z")), null);
  assert.equal(deliveryEstimate(preferred, now), "2026-12-22");
  assert.equal(deliveryEstimate(item(2), now), null);
  const calculated = { ...preferred, delivery: { in_stock: true, express: true, estimated_delivery_days: 3, timezone: "America/Los_Angeles", shipping_source: "https://example.com/shipping" } };
  assert.equal(deliveryEstimate(calculated, new Date("2026-12-19T02:00:00Z")), "2026-12-21");
});
