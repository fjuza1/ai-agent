export type Product = {
  id: string;
  sku?: string;
  name: string;
  description: string;
  image_url?: string;
  image_width?: number;
  image_height?: number;
  price_cents: number;
  origin_country: "USA";
  verified_usa_manufacturing: true;
  verification_source: string;
  review_status: "approved";
  categories: string[];
  goals: string[];
  discreet_gift_box_available?: boolean;
  fda_cleared_otc?: boolean;
  fda_device_type?: "pregnancy_test";
  fda_device_name?: string;
  fda_clearance_source?: string;
  fda_510k_number?: string;
  affiliate_url?: string;
  affiliate_type?: "amazon" | "direct";
  checkout_url?: string;
  aggregate_rating?: { rating_value: number; review_count: number; source_url: string };
  // Unreviewed discovery metadata from agents/daily_catalog_linker.py; read it through lib/discovery.ts.
  used_for?: string[];
  search_keywords?: string[];
  store_links?: { amazon?: string; alza?: string; direct?: string };
  discovery_meta?: { source: "rules" | "llm" | "manual"; content_hash?: string; updated_at?: string };
  delivery?: {
    in_stock: boolean;
    express: boolean;
    estimated_arrival_date?: string;
    estimated_delivery_days?: number;
    timezone?: string;
    shipping_source?: string;
    guarantee?: { verified: true; cutoff_at: string; arrival_date: string; evidence_url: string; timezone: string };
  };
};

function validDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function httpsUrl(value: unknown): boolean {
  try {
    if (typeof value !== "string") return false;
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password;
  } catch { return false; }
}

export function isUsaProduct(value: unknown): value is Product {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const product = value as Record<string, unknown>;
  if (product.origin_country !== "USA" || product.verified_usa_manufacturing !== true || product.review_status !== "approved") return false;
  if (typeof product.id !== "string" || !/^[a-z0-9-]{1,80}$/.test(product.id)) return false;
  if (typeof product.name !== "string" || !product.name.trim() || typeof product.description !== "string" || !product.description.trim()) return false;
  if (product.sku !== undefined && (typeof product.sku !== "string" || !product.sku.trim() || product.sku.length > 100)) return false;
  if (product.image_url !== undefined && !httpsUrl(product.image_url)) return false;
  if (product.image_width !== undefined || product.image_height !== undefined || product.image_url !== undefined) {
    if (!httpsUrl(product.image_url) || typeof product.image_width !== "number" || !Number.isSafeInteger(product.image_width) ||
        product.image_width < 1 || product.image_width > 12000 || typeof product.image_height !== "number" ||
        !Number.isSafeInteger(product.image_height) || product.image_height < 1 || product.image_height > 12000) return false;
  }
  if (product.checkout_url !== undefined && !httpsUrl(product.checkout_url)) return false;
  if (typeof product.price_cents !== "number" || !Number.isSafeInteger(product.price_cents) || product.price_cents < 50 || product.price_cents > 1_000_000) return false;
  if (!Array.isArray(product.categories) || !product.categories.every((v) => typeof v === "string")) return false;
  if (!Array.isArray(product.goals) || !product.goals.every((v) => typeof v === "string")) return false;
  if (!httpsUrl(product.verification_source)) return false;
  if (product.discreet_gift_box_available !== undefined && typeof product.discreet_gift_box_available !== "boolean") return false;
  if (product.discreet_gift_box_available === true && !product.categories.includes("family-planning-bundles")) return false;
  if (product.fda_cleared_otc !== undefined && typeof product.fda_cleared_otc !== "boolean") return false;
  if (product.fda_cleared_otc === true) {
    if (!product.categories.includes("family-planning-bundles") || product.fda_device_type !== "pregnancy_test" ||
        typeof product.fda_device_name !== "string" || !product.fda_device_name.trim() || !httpsUrl(product.fda_clearance_source)) return false;
    if (product.fda_510k_number !== undefined && (typeof product.fda_510k_number !== "string" || !/^K\d{6}$/.test(product.fda_510k_number))) return false;
  } else if (product.fda_device_type !== undefined || product.fda_device_name !== undefined ||
      product.fda_clearance_source !== undefined || product.fda_510k_number !== undefined) return false;
  if (product.affiliate_url !== undefined && !httpsUrl(product.affiliate_url)) return false;
  if (product.affiliate_type !== undefined && !["amazon", "direct"].includes(String(product.affiliate_type))) return false;
  if (product.affiliate_type !== undefined && product.affiliate_url === undefined) return false;
  if (product.aggregate_rating !== undefined) {
    if (!product.aggregate_rating || typeof product.aggregate_rating !== "object" || Array.isArray(product.aggregate_rating)) return false;
    const rating = product.aggregate_rating as Record<string, unknown>;
    if (typeof rating.rating_value !== "number" || !Number.isFinite(rating.rating_value) || rating.rating_value < 1 || rating.rating_value > 5) return false;
    if (typeof rating.review_count !== "number" || !Number.isSafeInteger(rating.review_count) || rating.review_count < 1 || !httpsUrl(rating.source_url)) return false;
  }
  if (product.delivery !== undefined) {
    if (!product.delivery || typeof product.delivery !== "object" || Array.isArray(product.delivery)) return false;
    const delivery = product.delivery as Record<string, unknown>;
    if (typeof delivery.in_stock !== "boolean" || typeof delivery.express !== "boolean") return false;
    if (delivery.estimated_arrival_date !== undefined && !validDate(delivery.estimated_arrival_date)) return false;
    if (delivery.estimated_delivery_days !== undefined) {
      if (typeof delivery.estimated_delivery_days !== "number" || !Number.isSafeInteger(delivery.estimated_delivery_days) || delivery.estimated_delivery_days < 1 || delivery.estimated_delivery_days > 60 || !httpsUrl(delivery.shipping_source) || typeof delivery.timezone !== "string") return false;
      try { new Intl.DateTimeFormat("en", { timeZone: delivery.timezone }); } catch { return false; }
    }
    if (delivery.guarantee !== undefined) {
      if (!delivery.guarantee || typeof delivery.guarantee !== "object" || Array.isArray(delivery.guarantee)) return false;
      const guarantee = delivery.guarantee as Record<string, unknown>;
      if (guarantee.verified !== true || !validDate(guarantee.arrival_date) || !httpsUrl(guarantee.evidence_url)) return false;
      if (typeof guarantee.cutoff_at !== "string" || !/(Z|[+-]\d\d:\d\d)$/.test(guarantee.cutoff_at) || !Number.isFinite(Date.parse(guarantee.cutoff_at))) return false;
      if (typeof guarantee.timezone !== "string") return false;
      try { new Intl.DateTimeFormat("en", { timeZone: guarantee.timezone }); } catch { return false; }
    }
  }
  return true;
}

export function filterUsaProducts(values: unknown[]): Product[] {
  return values.filter(isUsaProduct);
}
