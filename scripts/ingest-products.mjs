import { readFile, rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { isUsaProduct } from "../apps/usa-christmas-supplements/lib/usaFilter.ts";

const PRODUCT_KEYS = new Set([
  "id", "sku", "name", "description", "image_url", "image_width", "image_height",
  "price_cents", "origin_country", "verified_usa_manufacturing", "verification_source",
  "review_status", "categories", "goals", "discreet_gift_box_available", "fda_cleared_otc",
  "fda_device_type", "fda_device_name", "fda_clearance_source", "fda_510k_number",
  "affiliate_url", "affiliate_type", "checkout_url", "aggregate_rating", "delivery",
  "used_for", "search_keywords", "store_links", "discovery_meta",
]);

function validHttpsUrl(value) {
  try {
    const url = new URL(value);
    const sensitiveKeys = new Set(["access_token", "api_key", "apikey", "auth", "authorization", "client_secret", "credential", "password", "secret", "signature", "token"]);
    return url.protocol === "https:" && !url.username && !url.password &&
      [...url.searchParams.keys()].every((key) => !sensitiveKeys.has(key.toLowerCase()));
  } catch {
    return false;
  }
}

function normalizedTitle(value) {
  return value.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function validNewProduct(product) {
  return Object.keys(product).every((key) => PRODUCT_KEYS.has(key)) &&
    isUsaProduct(product) &&
    normalizedTitle(product.name).length > 0 &&
    (product.sku === undefined || (typeof product.sku === "string" && product.sku.trim().length > 0 && product.sku.length <= 100)) &&
    typeof product.image_url === "string" && validHttpsUrl(product.image_url) &&
    Number.isSafeInteger(product.image_width) && product.image_width >= 1 && product.image_width <= 12000 &&
    Number.isSafeInteger(product.image_height) && product.image_height >= 1 && product.image_height <= 12000 &&
    (product.checkout_url === undefined || validHttpsUrl(product.checkout_url));
}

export async function ingest(candidateFile, catalogFile) {
  const candidates = JSON.parse(await readFile(candidateFile, "utf8"));
  const existing = JSON.parse(await readFile(catalogFile, "utf8"));
  if (!Array.isArray(candidates) || !Array.isArray(existing)) throw new Error("Products and catalog must be arrays.");
  if (!candidates.every(validNewProduct)) throw new Error("Rejected: every new product needs human approval, verified USA manufacturing, valid HTTPS evidence and purchase links, and measured image dimensions.");
  if (!existing.every(isUsaProduct)) throw new Error("Existing catalog contains invalid entries; correct it before ingestion.");
  const merged = [...existing, ...candidates];
  if (new Set(merged.map((product) => product.id)).size !== merged.length) throw new Error("Rejected: duplicate product IDs.");
  const titles = merged.map((product) => normalizedTitle(product.name));
  if (new Set(titles).size !== titles.length) throw new Error("Rejected: duplicate product titles.");
  const skus = merged.map((product) => normalizedTitle(product.sku ?? "")).filter(Boolean);
  if (new Set(skus).size !== skus.length) throw new Error("Rejected: duplicate product SKUs.");
  const temp = `${catalogFile}.tmp`;
  await writeFile(temp, `${JSON.stringify(merged, null, 2)}\n`, { flag: "wx" });
  await rename(temp, catalogFile);
  return candidates.length;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.length !== 3) throw new Error("Usage: node scripts/ingest-products.mjs candidates.json");
  const count = await ingest(resolve(process.argv[2]), resolve("data/supplements.json"));
  console.log(`Ingested ${count} reviewed USA-made products.`);
}
