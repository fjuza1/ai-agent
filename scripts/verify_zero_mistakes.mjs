import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { assertValidThemeDocument } from "../lib/themeValidator.ts";
import { isUsaProduct } from "../apps/usa-christmas-supplements/lib/usaFilter.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const productKeys = new Set([
  "id", "sku", "name", "description", "image_url", "image_width", "image_height",
  "price_cents", "origin_country", "verified_usa_manufacturing", "verification_source",
  "review_status", "categories", "goals", "discreet_gift_box_available", "fda_cleared_otc",
  "fda_device_type", "fda_device_name", "fda_clearance_source", "fda_510k_number",
  "affiliate_url", "affiliate_type", "checkout_url", "aggregate_rating", "delivery",
  "used_for", "search_keywords", "store_links", "discovery_meta",
]);
const candidateKeys = new Set([
  "id", "sku", "name", "description", "price_cents", "origin_country_claim",
  "verified_usa_manufacturing_claim", "verification_source", "source_url", "image_url",
  "image_width", "image_height", "affiliate_url", "checkout_url", "affiliate_type",
  "categories", "goals", "fda_cleared_otc_claim", "fda_device_type", "fda_device_name",
  "fda_clearance_source", "fda_510k_number", "review_status", "verified_usa_manufacturing",
  "requires_human_manufacturing_and_claim_review",
]);

function run(command, args, label) {
  console.log(`\n== ${label} ==`);
  const result = spawnSync(command, args, { cwd: root, stdio: "inherit", env: process.env });
  if (result.error) throw new Error(`${label} could not start: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`${label} failed with exit code ${result.status ?? "unknown"}.`);
}

function runNpm(args, label) {
  if (process.env.npm_execpath) {
    run(process.execPath, [process.env.npm_execpath, ...args], label);
  } else {
    run("npm", args, label);
  }
}

function pythonCommand() {
  const candidate = process.platform === "win32"
    ? path.join(root, ".venv", "Scripts", "python.exe")
    : path.join(root, ".venv", "bin", "python");
  if (process.env.PYTHON) return process.env.PYTHON;
  return existsSync(candidate) ? candidate : process.platform === "win32" ? "python" : "python3";
}

function readJson(filename) {
  return JSON.parse(readFileSync(path.join(root, filename), "utf8"));
}

function normalized(value) {
  return String(value).normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

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

function ensureUnique(values, label) {
  if (new Set(values).size !== values.length) throw new Error(`Duplicate ${label} in product data.`);
}

function validCatalogExtensions(product) {
  if (!Object.keys(product).every((key) => productKeys.has(key))) return false;
  for (const [field, pattern, limit] of [
    ["used_for", /^[A-Za-z0-9][A-Za-z0-9 &'+/-]{1,39}$/, 6],
    ["search_keywords", /^[a-z0-9][a-z0-9 &'+./-]{1,79}$/, 8],
  ]) {
    if (product[field] !== undefined &&
        (!Array.isArray(product[field]) || product[field].length > limit ||
         !product[field].every((value) => typeof value === "string" && pattern.test(value)))) return false;
  }
  if (product.store_links !== undefined) {
    const links = product.store_links;
    if (!links || typeof links !== "object" || Array.isArray(links) ||
        Object.keys(links).sort().join(",") !== "alza,amazon,direct" ||
        typeof links.amazon !== "string" || typeof links.alza !== "string" ||
        typeof links.direct !== "string" || !/^\/go\/[a-z0-9-]{1,80}$/.test(links.direct)) return false;
    const amazon = new URL(links.amazon);
    const alza = new URL(links.alza);
    if (!validHttpsUrl(links.amazon) || amazon.hash || amazon.protocol !== "https:" ||
        amazon.hostname !== "www.amazon.com" || amazon.pathname !== "/s" ||
        !amazon.searchParams.get("k") || alza.protocol !== "https:" || alza.hostname !== "www.alza.sk" ||
        !validHttpsUrl(links.alza) || alza.hash || alza.pathname !== "/search.htm" || !alza.searchParams.get("exps")) return false;
  }
  if (product.discovery_meta !== undefined) {
    const metadata = product.discovery_meta;
    if (!metadata || typeof metadata !== "object" || Array.isArray(metadata) ||
        !["rules", "llm", "manual"].includes(metadata.source) ||
        Object.keys(metadata).some((key) => !["source", "content_hash", "updated_at"].includes(key)) ||
        (metadata.content_hash !== undefined && !/^[a-f0-9]{64}$/i.test(metadata.content_hash)) ||
        (metadata.updated_at !== undefined && !Number.isFinite(Date.parse(metadata.updated_at)))) return false;
  }
  return true;
}

function validateCatalog() {
  const catalog = readJson("data/supplements.json");
  if (!Array.isArray(catalog) || !catalog.every((product) =>
    isUsaProduct(product) && validCatalogExtensions(product) &&
    typeof product.image_url === "string" && validHttpsUrl(product.image_url) &&
    Number.isSafeInteger(product.image_width) && product.image_width >= 1 && product.image_width <= 12000 &&
    Number.isSafeInteger(product.image_height) && product.image_height >= 1 && product.image_height <= 12000 &&
    (product.checkout_url === undefined || validHttpsUrl(product.checkout_url)))) {
    throw new Error("Published supplement catalog contains a product that fails the strict USA/approval schema.");
  }
  ensureUnique(catalog.map((product) => product.id), "product IDs");
  ensureUnique(catalog.map((product) => normalized(product.name)), "product titles");
  ensureUnique(catalog.map((product) => normalized(product.sku ?? "")).filter(Boolean), "product SKUs");
}

function validateProductDrafts() {
  const document = readJson("data/product_candidate_drafts.json");
  if (!document || typeof document !== "object" || Array.isArray(document) ||
      Object.keys(document).sort().join(",") !== "candidates,rejected,schema_version,source_feed,updated_at" ||
      document.schema_version !== 1 || !Number.isFinite(Date.parse(document.updated_at)) ||
      typeof document.source_feed !== "string" ||
      (document.source_feed && !validHttpsUrl(document.source_feed)) ||
      !Array.isArray(document.candidates) || !Array.isArray(document.rejected)) {
    throw new Error("Product candidate draft file does not match its schema.");
  }
  const candidates = document.candidates;
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate) ||
        !Object.keys(candidate).every((key) => candidateKeys.has(key)) ||
        typeof candidate.id !== "string" || !/^[a-z0-9-]{1,80}$/.test(candidate.id) ||
        typeof candidate.name !== "string" || !candidate.name.trim() ||
        typeof candidate.description !== "string" || !candidate.description.trim() ||
        !Number.isSafeInteger(candidate.price_cents) || candidate.price_cents < 50 || candidate.price_cents > 1_000_000 ||
        typeof candidate.sku !== "string" ||
        candidate.origin_country_claim !== "USA" ||
        candidate.verified_usa_manufacturing_claim !== true ||
        candidate.verified_usa_manufacturing !== false ||
        candidate.review_status !== "draft" ||
        candidate.requires_human_manufacturing_and_claim_review !== true ||
        !validHttpsUrl(candidate.source_url) ||
        !validHttpsUrl(candidate.verification_source) ||
        !validHttpsUrl(candidate.image_url) ||
        (candidate.affiliate_url !== null && !validHttpsUrl(candidate.affiliate_url)) ||
        (candidate.checkout_url !== null && !validHttpsUrl(candidate.checkout_url)) ||
        (candidate.affiliate_type !== null && !["amazon", "direct"].includes(candidate.affiliate_type)) ||
        !Array.isArray(candidate.categories) || !candidate.categories.every((value) => typeof value === "string") ||
        !Array.isArray(candidate.goals) || !candidate.goals.every((value) => typeof value === "string") ||
        typeof candidate.fda_cleared_otc_claim !== "boolean" ||
        !Number.isSafeInteger(candidate.image_width) || candidate.image_width < 1 || candidate.image_width > 12000 ||
        !Number.isSafeInteger(candidate.image_height) || candidate.image_height < 1 || candidate.image_height > 12000 ||
        !(candidate.affiliate_url || candidate.checkout_url) ||
        !validHttpsUrl(candidate.affiliate_url || candidate.checkout_url)) {
      throw new Error(`Product candidate ${candidate?.id ?? "(unknown)"} failed the draft schema.`);
    }
    if (candidate.fda_cleared_otc_claim &&
        (candidate.fda_device_type !== "pregnancy_test" || typeof candidate.fda_device_name !== "string" ||
         !candidate.fda_device_name.trim() || !validHttpsUrl(candidate.fda_clearance_source) ||
         (candidate.fda_510k_number !== null && !/^K\d{6}$/.test(candidate.fda_510k_number)))) {
      throw new Error(`FDA evidence is incomplete for product candidate ${candidate.id}.`);
    }
  }
  ensureUnique(candidates.map((candidate) => candidate.id), "candidate IDs");
  ensureUnique(candidates.map((candidate) => normalized(candidate.name)), "candidate titles");
  ensureUnique(candidates.map((candidate) => normalized(candidate.sku)).filter(Boolean), "candidate SKUs");
  if (!document.rejected.every((item) => item && typeof item.reason === "string")) {
    throw new Error("Rejected product records must include a reason.");
  }
}

try {
  runNpm(["run", "test:theme"], "Theme contract and Lighthouse gate tests");
  runNpm(["run", "typecheck"], "TypeScript checks for shared code and both apps");
  const tsc = path.join(root, "node_modules", "typescript", "bin", "tsc");
  run(process.execPath, [tsc, "--noEmit", "--project", path.join(root, "apps", "sticker-market", "tsconfig.json")], "Sticker marketplace TypeScript check");
  run(process.execPath, [tsc, "--noEmit", "--project", path.join(root, "apps", "usa-christmas-supplements", "tsconfig.json")], "Supplement storefront TypeScript check");
  runNpm(["run", "lint"], "ESLint checks for both apps");

  const theme = readJson("data/daily_visual_theme.json");
  assertValidThemeDocument(theme);
  run(pythonCommand(), ["agents/theme_schema.py", "data/daily_visual_theme.json"], "Python theme schema and WCAG validation");
  validateCatalog();
  validateProductDrafts();
  console.log("Theme, catalog, and product candidate schemas passed.");

  runNpm(["run", "build"], "Production builds for both apps");
  runNpm(["run", "audit:seo"], "Lighthouse SEO (97%) and Accessibility (95%) gates");
  console.log("\nZero-mistakes verification passed.");
} catch (error) {
  console.error(`\nZero-mistakes verification failed: ${error.message}`);
  process.exitCode = 1;
}
