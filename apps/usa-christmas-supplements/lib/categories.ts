import type { Product } from "./usaFilter.ts";

export const FAVORITE_CATEGORIES = [
  "Immunity",
  "Family Planning & Pregnancy Tests",
  "Winter Energy",
  "Holiday Gift Boxes",
  "Prenatal Support",
] as const;
export type FavoriteCategory = (typeof FAVORITE_CATEGORIES)[number];
export const OTHER_CATEGORY = "Other";

// Stored values stay stable (alerts, favorites and exports use them); only the pill presentation is friendlier.
export const CATEGORY_PILLS: Record<FavoriteCategory, { emoji: string; label: string }> = {
  "Immunity": { emoji: "🛡️", label: "Immunity" },
  "Family Planning & Pregnancy Tests": { emoji: "🤰", label: "Family Planning" },
  "Winter Energy": { emoji: "⚡", label: "Winter Energy" },
  "Holiday Gift Boxes": { emoji: "🎁", label: "Christmas Bundles" },
  "Prenatal Support": { emoji: "🌿", label: "Prenatal Care" },
};

export function categoryPill(category: string): { emoji: string; label: string } {
  return isFavoriteCategory(category) ? CATEGORY_PILLS[category] : { emoji: "✨", label: category };
}

// Terms are matched against the product's categories, goals, used_for tags, search keywords and name.
const RULES: Record<FavoriteCategory, string[]> = {
  "Immunity": ["immun", "vitamin c", "zinc", "elderberry"],
  "Family Planning & Pregnancy Tests": ["family planning", "pregnancy test", "early pregnancy", "ovulation", "fertility"],
  "Winter Energy": ["winter energy", "energy", "vitamin d"],
  "Holiday Gift Boxes": ["holiday", "gift box", "gift bundle", "christmas"],
  "Prenatal Support": ["prenatal", "postnatal", "folate", "folic"],
};

const fold = (value: string) => value.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().replace(/[-_\s]+/g, " ").trim();

function haystack(product: Product): string {
  const extra = product as Product & { used_for?: unknown; search_keywords?: unknown };
  const lists = [product.categories, product.goals, extra.used_for, extra.search_keywords];
  const tags = lists.flatMap((list) => (Array.isArray(list) ? list : [])).filter((tag): tag is string => typeof tag === "string");
  return fold([product.name, ...tags].join(" | "));
}

export function categoriesFor(product: Product): FavoriteCategory[] {
  const text = haystack(product);
  return FAVORITE_CATEGORIES.filter((category) => RULES[category].some((term) => text.includes(term)));
}

export function primaryCategory(product: Product): string {
  return categoriesFor(product)[0] ?? OTHER_CATEGORY;
}

export function isFavoriteCategory(value: unknown): value is FavoriteCategory {
  return typeof value === "string" && (FAVORITE_CATEGORIES as readonly string[]).includes(value);
}

export function parseCategories(value: unknown): FavoriteCategory[] {
  const list = Array.isArray(value) ? value : [];
  return FAVORITE_CATEGORIES.filter((category) => list.includes(category));
}
