import { catalog } from "../../../../lib/catalog";
import { isFavoriteCategory, parseCategories, type FavoriteCategory } from "../../../../lib/categories";
import { db } from "../../../../lib/db";
import { json, MAX_FAVORITES, PRODUCT_ID, readJson, resolveCategory } from "../../../../lib/favoriteRequests";
import { currentUserId } from "../../../../lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Tx = Parameters<Parameters<typeof db.$transaction>[0]>[0];
class FavoriteLimitError extends Error {}

async function setCategory(userId: string, category: FavoriteCategory, on: boolean | undefined, client: Tx | typeof db = db) {
  // Callers outside a transaction get one so the read-modify-write of the category list is atomic.
  if (client === db) return db.$transaction((tx) => setCategory(userId, category, on, tx));
  const user = await client.user.findUnique({ where: { id: userId }, select: { favoriteCategories: true, emailAlertsEnabled: true, emailVerified: true } });
  if (!user) return null;
  const current = parseCategories(user.favoriteCategories);
  const active = on ?? !current.includes(category);
  const categories = parseCategories(active ? [...current, category] : current.filter((entry) => entry !== category));
  await client.user.update({ where: { id: userId }, data: { favoriteCategories: categories } });
  return { active, categories, alertsEnabled: Boolean(user.emailAlertsEnabled && user.emailVerified) };
}

// One-tap pill endpoint. `saved` makes a request idempotent (the client sends its optimistic target); without it the state flips.
export async function POST(request: Request) {
  const userId = await currentUserId();
  if (!userId) return json({ error: "Sign in to save favorites." }, 401);
  const body = await readJson(request);
  if (!body || (body.saved !== undefined && typeof body.saved !== "boolean")) return json({ error: "Invalid request." }, 400);
  const saved = body.saved as boolean | undefined;

  if (body.type === "category") {
    if (!isFavoriteCategory(body.category)) return json({ error: "Unknown category." }, 400);
    const result = await setCategory(userId, body.category, saved);
    return result ? json({ type: "category", category: body.category, ...result }) : json({ error: "Sign in again." }, 401);
  }

  if (body.type !== "product" || typeof body.productId !== "string" || !PRODUCT_ID.test(body.productId)) return json({ error: "Invalid request." }, 400);
  const product = (await catalog()).find((item) => item.id === body.productId);
  if (!product) return json({ error: "Product not found." }, 404);
  const category = resolveCategory(product, body.category);
  let active: boolean;
  try {
    active = await db.$transaction(async (tx) => {
      const existing = await tx.favorite.findUnique({ where: { userId_productId: { userId, productId: product.id } }, select: { id: true } });
      const wanted = saved ?? !existing;
      if (!wanted) {
        await tx.favorite.deleteMany({ where: { userId, productId: product.id } });
        return false;
      }
      await tx.favorite.upsert({
        where: { userId_productId: { userId, productId: product.id } },
        create: { userId, productId: product.id, category }, update: { category },
      });
      if (await tx.favorite.count({ where: { userId } }) > MAX_FAVORITES) throw new FavoriteLimitError();
      return true;
    });
  } catch (error) {
    if (error instanceof FavoriteLimitError) return json({ error: "Favorite limit reached." }, 422);
    if ((error as { code?: string }).code === "P2003") return json({ error: "Sign in again." }, 401);
    throw error;
  }
  // "Save & get alerts": alerts are built from favorite categories, so saving can opt the product's category in.
  const followed = active && body.followCategory === true && isFavoriteCategory(category) ? await setCategory(userId, category, true) : null;
  const user = followed ? null : await db.user.findUnique({ where: { id: userId }, select: { favoriteCategories: true, emailAlertsEnabled: true, emailVerified: true } });
  return json({
    type: "product", productId: product.id, category, active,
    categories: followed?.categories ?? parseCategories(user?.favoriteCategories),
    alertsEnabled: followed?.alertsEnabled ?? Boolean(user?.emailAlertsEnabled && user.emailVerified),
  });
}
