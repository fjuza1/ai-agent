import { filterUsaProducts, type Product } from "./usaFilter.ts";

function hash(value: string): number {
  let result = 2166136261;
  for (let i = 0; i < value.length; i++) result = Math.imul(result ^ value.charCodeAt(i), 16777619);
  return result >>> 0;
}

export function hourBucket(now: Date): string {
  if (!Number.isFinite(now.getTime())) throw new Error("Invalid rotation date.");
  return now.toISOString().slice(0, 13);
}

export function rotateProducts(values: unknown[], now = new Date()): Product[] {
  const bucket = hourBucket(now);
  const seasonal = now.getUTCMonth() === 11 && now.getUTCDate() <= 24;
  return filterUsaProducts(values).sort((a, b) => {
    const priority = (p: Product) => seasonal && p.delivery?.in_stock && p.delivery.express && p.categories.some((category) => ["Holiday Gift Bundles", "family-planning-bundles"].includes(category)) ? 1 : 0;
    return priority(b) - priority(a) || hash(`${bucket}:${a.id}`) - hash(`${bucket}:${b.id}`) || a.id.localeCompare(b.id);
  }).slice(0, 10);
}
