import { catalog } from "../../../../lib/catalog";
import { parseCategories } from "../../../../lib/categories";
import { db } from "../../../../lib/db";
import { favoriteSnapshot, json, MAX_FAVORITES, PRODUCT_ID, readJson, resolveCategory } from "../../../../lib/favoriteRequests";
import { currentUserId } from "../../../../lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_GUEST_ITEMS = 100;

// Merges what a visitor tapped before signing in. Existing account data always wins: guest taps only ever add.
export async function POST(request: Request) {
  const userId = await currentUserId();
  if (!userId) return json({ error: "Sign in to sync favorites." }, 401);
  const body = await readJson(request);
  if (!body) return json({ error: "Invalid request." }, 400);
  const guestProducts = (Array.isArray(body.products) ? body.products : []).slice(0, MAX_GUEST_ITEMS)
    .filter((entry): entry is { productId: string; category?: unknown } => Boolean(entry) && typeof entry.productId === "string" && PRODUCT_ID.test(entry.productId));
  const guestCategories = parseCategories(body.categories);

  const products = await catalog();
  const byId = new Map(products.map((product) => [product.id, product]));

  // Read and write in one transaction so concurrent syncs cannot overshoot the favorites limit or lose category updates.
  const outcome = await db.$transaction(async (tx) => {
    const [existing, user] = await Promise.all([
      tx.favorite.findMany({ where: { userId }, select: { productId: true } }),
      tx.user.findUnique({ where: { id: userId }, select: { favoriteCategories: true } }),
    ]);
    if (!user) return null;
    const known = new Set(existing.map((favorite) => favorite.productId));
    const additions = new Map<string, string>();
    for (const entry of guestProducts) {
      const product = byId.get(entry.productId);
      if (product && !known.has(product.id) && !additions.has(product.id) && known.size + additions.size < MAX_FAVORITES) additions.set(product.id, resolveCategory(product, entry.category));
    }
    const previous = parseCategories(user.favoriteCategories);
    const merged = parseCategories([...previous, ...guestCategories]);
    for (const [productId, category] of additions) {
      await tx.favorite.upsert({ where: { userId_productId: { userId, productId } }, create: { userId, productId, category }, update: {} });
    }
    await tx.user.update({ where: { id: userId }, data: { favoriteCategories: merged } });
    return { products: additions.size, categories: merged.length - previous.length };
  }).catch((error: unknown) => {
    if ((error as { code?: string }).code === "P2003") return null;
    throw error;
  });
  if (!outcome) return json({ error: "Sign in again." }, 401);
  return json({ ...(await favoriteSnapshot(userId)), merged: outcome });
}
