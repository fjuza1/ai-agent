import { createHash } from "node:crypto";
import { filterUsaProducts, type Product } from "./usaFilter.ts";
import { discoveryItem, isSearchKeyword, matchesItem, searchKeywords } from "./discovery.ts";

export type DailyFeatured = { date: string; top_picks: string[]; trending_searches: string[] };

const GROUPS = ["supplement", "holiday", "family-planning"] as const;

function seeded(day: string, key: string): string {
  return createHash("sha256").update(`${day}:${key}`).digest("hex");
}

function group(product: Product): (typeof GROUPS)[number] {
  if (product.categories.includes("family-planning-bundles")) return "family-planning";
  return product.categories.includes("Holiday Gift Bundles") ? "holiday" : "supplement";
}

function available(product: Product): boolean {
  return product.delivery?.in_stock !== false;
}

export function utcDay(now: Date): string {
  if (!Number.isFinite(now.getTime())) throw new Error("Invalid rotation date.");
  return now.toISOString().slice(0, 10);
}

// Same date-seeded round robin as agents/daily_catalog_linker.py, used when the agent's file is missing or stale.
export function selectTopPicks(values: unknown[], day: string, limit = 8): Product[] {
  const products = filterUsaProducts(values).filter(available);
  const buckets = GROUPS.map((name) => products.filter((product) => group(product) === name).sort((a, b) => {
    const [left, right] = [seeded(day, a.id), seeded(day, b.id)];
    return left < right ? -1 : left > right ? 1 : a.id < b.id ? -1 : 1;
  }));
  const start = parseInt(seeded(day, "group-order").slice(0, 8), 16) % GROUPS.length;
  const order = [...buckets.slice(start), ...buckets.slice(0, start)];
  const picks: Product[] = [];
  while (picks.length < limit && order.some((bucket) => bucket.length)) {
    for (const bucket of order) {
      const next = picks.length < limit ? bucket.shift() : undefined;
      if (next) picks.push(next);
    }
  }
  return picks;
}

export function parseFeatured(value: unknown): DailyFeatured | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const featured = value as Record<string, unknown>;
  const strings = (list: unknown): list is string[] => Array.isArray(list) && list.every((entry) => typeof entry === "string");
  if (featured.version !== 1 || typeof featured.date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(featured.date)) return null;
  if (!strings(featured.top_picks) || !strings(featured.trending_searches)) return null;
  return { date: featured.date, top_picks: featured.top_picks, trending_searches: featured.trending_searches };
}

export function topPicks(values: unknown[], featured: DailyFeatured | null, now = new Date(), limit = 8): Product[] {
  const day = utcDay(now);
  if (featured?.date === day) {
    const products = filterUsaProducts(values).filter(available);
    const picks = [...new Set(featured.top_picks)].flatMap((id) => products.filter((product) => product.id === id)).slice(0, limit);
    if (picks.length) return picks;
  }
  return selectTopPicks(values, day, limit);
}

export function trendingSearches(values: unknown[], featured: DailyFeatured | null, limit = 8): string[] {
  const products = filterUsaProducts(values);
  const items = products.map(discoveryItem);
  const fromAgent = (featured?.trending_searches ?? []).filter((keyword) => isSearchKeyword(keyword) && items.some((item) => matchesItem(item, keyword, "")));
  const keywords = fromAgent.length ? fromAgent : products.filter(available).flatMap((product) => searchKeywords(product).slice(0, 1));
  return [...new Set(keywords)].slice(0, limit);
}
