import { strict as assert } from "node:assert";
import { test } from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { filterUsaProducts, isUsaProduct } from "./usaFilter.ts";
import { ingest } from "../../../scripts/ingest-products.mjs";

const approved = {
  id: "example", name: "Example", description: "An example", price_cents: 500,
  origin_country: "USA", verified_usa_manufacturing: true, verification_source: "https://example.com/evidence",
  review_status: "approved", categories: ["Holiday Gift Bundles"], goals: ["Winter Wellness"],
  image_url: "https://example.com/product.png", image_width: 800, image_height: 800,
};

test("only exact verified USA and approved products pass", () => {
  assert.equal(isUsaProduct(approved), true);
  for (const patch of [
    { origin_country: "Canada" }, { origin_country: "usa" }, { origin_country: "US" },
    { verified_usa_manufacturing: false }, { verified_usa_manufacturing: "true" },
    { review_status: "draft" }, { verification_source: "http://example.com" },
    { price_cents: -1 }, { id: "../bad" },
    { affiliate_url: "javascript:alert(1)" },
    { aggregate_rating: { rating_value: 6, review_count: 7, source_url: "https://example.com/reviews" } },
    { fda_cleared_otc: "true" },
    { fda_cleared_otc: true },
    { fda_cleared_otc: false, fda_510k_number: "K123456" },
    { discreet_gift_box_available: true },
    { delivery: { in_stock: true, express: true, estimated_delivery_days: 3, timezone: "Invalid/Zone", shipping_source: "https://example.com/shipping" } },
  ]) assert.equal(isUsaProduct({ ...approved, ...patch }), false);
  assert.deepEqual(filterUsaProducts([approved, null, { ...approved, origin_country: "Canada" }]), [approved]);
});

test("FDA clearance requires reviewed device-specific evidence and valid optional 510(k)", () => {
  const kit = { ...approved, categories: ["family-planning-bundles"], fda_cleared_otc: true,
    fda_device_type: "pregnancy_test", fda_device_name: "Test device", fda_clearance_source: "https://example.com/fda",
    fda_510k_number: "K123456", discreet_gift_box_available: true };
  assert.equal(isUsaProduct(kit), true);
  assert.equal(isUsaProduct({ ...kit, fda_510k_number: "K123" }), false);
  assert.equal(isUsaProduct({ ...kit, fda_clearance_source: "http://example.com" }), false);
  assert.equal(isUsaProduct({ ...kit, origin_country: "Canada" }), false);
  assert.equal(isUsaProduct({ ...kit, verified_usa_manufacturing: false }), false);
  const { fda_510k_number, ...withoutNumber } = kit;
  assert.equal(isUsaProduct(withoutNumber), true);
});

test("ingestion rejects an entire batch containing a non-USA or unverified product", async () => {
  const dir = await mkdtemp(join(tmpdir(), "usa-ingest-"));
  try {
    const candidates = join(dir, "candidates.json");
    const catalog = join(dir, "catalog.json");
    await writeFile(catalog, "[]");
    await writeFile(candidates, JSON.stringify([approved, { ...approved, id: "foreign", origin_country: "Canada" }]));
    await assert.rejects(ingest(candidates, catalog), /Rejected/);
    assert.deepEqual(JSON.parse(await readFile(catalog, "utf8")), []);
    await writeFile(candidates, JSON.stringify([approved]));
    assert.equal(await ingest(candidates, catalog), 1);
    assert.deepEqual(JSON.parse(await readFile(catalog, "utf8")), [approved]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("ingestion requires measured image dimensions and deduplicates titles and SKUs", async () => {
  const dir = await mkdtemp(join(tmpdir(), "usa-ingest-"));
  try {
    const candidates = join(dir, "candidates.json");
    const catalog = join(dir, "catalog.json");
    await writeFile(catalog, "[]");
    await writeFile(candidates, JSON.stringify([{ ...approved, image_width: 0 }]));
    await assert.rejects(ingest(candidates, catalog), /image dimensions/);
    await writeFile(candidates, JSON.stringify([approved, { ...approved, id: "same-title", sku: "other", name: "Example!" }]));
    await assert.rejects(ingest(candidates, catalog), /duplicate product titles/);
    await writeFile(candidates, JSON.stringify([
      approved,
      { ...approved, id: "same-sku", sku: "SKU-1", name: "SKU Candidate One" },
      { ...approved, id: "sku-one", sku: "sku 1", name: "SKU Candidate Two" },
    ]));
    await assert.rejects(ingest(candidates, catalog), /duplicate product SKUs/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
