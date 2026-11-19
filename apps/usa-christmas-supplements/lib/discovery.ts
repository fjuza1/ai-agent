import type { Product } from "./usaFilter.ts";

export type StoreLink = { href: string; affiliate: boolean };
export type StoreLinks = { direct: string; amazon?: StoreLink; alza?: StoreLink };
export type DiscoveryItem = { id: string; name: string; usedFor: string[]; keywords: string[]; facets: string[]; text: string };
export type Suggestion = { type: "used_for" | "product" | "search"; label: string; value: string };

// Discovery metadata is written by the daily agent without human review, so it is re-validated on every read.
const TAG = /^[A-Za-z0-9][A-Za-z0-9 &'+/-]{1,39}$/;
const KEYWORD = /^[a-z0-9][a-z0-9 &'+./-]{1,79}$/;

function terms(value: unknown, pattern: RegExp, limit: number): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  if (!Array.isArray(value)) return result;
  for (const entry of value) {
    if (typeof entry !== "string" || !pattern.test(entry) || seen.has(entry.toLowerCase())) continue;
    seen.add(entry.toLowerCase());
    result.push(entry);
    if (result.length === limit) break;
  }
  return result;
}

export function fold(value: string): string {
  return value.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().replace(/\s+/g, " ").trim();
}

export function isSearchKeyword(value: unknown): value is string {
  return typeof value === "string" && KEYWORD.test(value);
}

export function usedForTags(product: Product): string[] {
  const tags = terms(product.used_for, TAG, 6);
  return tags.length ? tags : terms(product.goals, TAG, 6);
}

export function searchKeywords(product: Product): string[] {
  return terms(product.search_keywords, KEYWORD, 8);
}

function storeLink(value: unknown, host: string, pathname: string, queryKey: string): StoreLink | undefined {
  if (typeof value !== "string" || value.length > 600) return undefined;
  let url: URL;
  try { url = new URL(value); } catch { return undefined; }
  if (url.protocol !== "https:" || url.hostname !== host || url.port || url.username || url.password || url.hash || url.pathname !== pathname) return undefined;
  if (!url.searchParams.get(queryKey)) return undefined;
  return { href: url.toString(), affiliate: [...url.searchParams.keys()].some((key) => key !== queryKey) };
}

export function safeStoreLinks(product: Product): StoreLinks {
  const stored: unknown = product.store_links;
  const links = stored && typeof stored === "object" ? stored as Record<string, unknown> : {};
  return {
    direct: `/go/${encodeURIComponent(product.id)}`,
    amazon: storeLink(links.amazon, "www.amazon.com", "/s", "k"),
    alza: storeLink(links.alza, "www.alza.sk", "/search.htm", "exps"),
  };
}

export function topUsedFor(products: Product[], limit = 8): string[] {
  const counts = new Map<string, { label: string; count: number }>();
  for (const product of products) {
    for (const tag of usedForTags(product)) {
      const entry = counts.get(fold(tag)) ?? { label: tag, count: 0 };
      entry.count += 1;
      counts.set(fold(tag), entry);
    }
  }
  return [...counts.values()].sort((a, b) => b.count - a.count || (a.label < b.label ? -1 : 1)).slice(0, limit).map((entry) => entry.label);
}

export function discoveryItem(product: Product): DiscoveryItem {
  const usedFor = usedForTags(product);
  const keywords = searchKeywords(product);
  const labels = [...usedFor, ...product.goals, ...product.categories];
  return {
    id: product.id, name: product.name, usedFor, keywords,
    facets: [...new Set(labels.map(fold))],
    text: fold([product.name, product.description, ...labels, ...keywords].join(" ")),
  };
}

export function matchesItem(item: DiscoveryItem, query: string, tag: string): boolean {
  if (tag && !item.facets.includes(fold(tag))) return false;
  return fold(query).split(" ").filter(Boolean).every((token) => item.text.includes(token));
}

export function suggest(items: DiscoveryItem[], query: string, limit = 8): Suggestion[] {
  const needle = fold(query);
  const result: Suggestion[] = [];
  const seen = new Set<string>();
  if (!needle) return result;
  const add = (type: Suggestion["type"], label: string, value: string, cap = limit) => {
    const key = `${type}:${fold(label)}`;
    if (seen.has(key) || result.length >= limit || result.filter((entry) => entry.type === type).length >= cap) return;
    seen.add(key);
    result.push({ type, label, value });
  };
  for (const item of items) for (const tag of item.usedFor) if (fold(tag).includes(needle)) add("used_for", tag, tag, 3);
  const named = items.filter((item) => fold(item.name).includes(needle))
    .sort((a, b) => Number(fold(b.name).startsWith(needle)) - Number(fold(a.name).startsWith(needle)) || (a.name < b.name ? -1 : 1));
  for (const item of named) add("product", item.name, item.id, 4);
  for (const item of items) for (const keyword of item.keywords) if (keyword.includes(needle)) add("search", keyword, keyword);
  return result;
}
