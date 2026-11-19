import type { Product } from "./usaFilter.ts";

export function deliveryEstimate(product: Product, now = new Date()): string | null {
  const delivery = product.delivery;
  if (!delivery?.in_stock) return null;
  if (delivery.estimated_delivery_days && delivery.timezone) {
    const parts = new Intl.DateTimeFormat("en-US", { timeZone: delivery.timezone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
    const part = (name: string) => Number(parts.find((value) => value.type === name)?.value);
    return new Date(Date.UTC(part("year"), part("month") - 1, part("day") + delivery.estimated_delivery_days)).toISOString().slice(0, 10);
  }
  const value = product.delivery?.estimated_arrival_date;
  if (!value || value < now.toISOString().slice(0, 10)) return null;
  return value;
}

export function verifiedCutoff(products: Product[], now = new Date()) {
  const year = now.getUTCFullYear();
  const start = Date.UTC(year, 11, 1);
  const end = Date.UTC(year, 11, 24);
  if (now.getTime() < start || now.getTime() >= end) return null;
  const options = products.flatMap((p) => {
    const g = p.delivery?.guarantee;
    if (!p.delivery?.in_stock || !p.delivery.express || !p.categories.some((category) => ["Holiday Gift Bundles", "family-planning-bundles"].includes(category)) || !g) return [];
    if (Date.parse(g.cutoff_at) <= now.getTime() || Date.parse(g.cutoff_at) >= end ||
        !g.arrival_date.startsWith(`${year}-12-`) || g.arrival_date >= `${year}-12-24`) return [];
    return [{ ...g, productId: p.id }];
  });
  return options.sort((a, b) => Date.parse(a.cutoff_at) - Date.parse(b.cutoff_at))[0] || null;
}
