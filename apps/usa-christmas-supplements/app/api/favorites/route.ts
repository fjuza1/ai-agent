import { catalog } from "../../../lib/catalog";
import { db } from "../../../lib/db";
import { favoriteSnapshot, json, MAX_FAVORITES, PRODUCT_ID, readJson, resolveCategory } from "../../../lib/favoriteRequests";
import { currentUserId } from "../../../lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

class FavoriteLimitError extends Error {}

// Per-product writes live here; the 1-tap pill endpoint is /api/favorites/toggle and guest merging is /api/favorites/sync.
async function readProductBody(request: Request): Promise<{ productId: string; category?: unknown } | null> {
  const body = await readJson(request);
  return body && typeof body.productId === "string" && PRODUCT_ID.test(body.productId) ? (body as { productId: string; category?: unknown }) : null;
}

export async function GET() {
  const userId = await currentUserId();
  if (!userId) return json({ error: "Sign in to see favorites." }, 401);
  return json(await favoriteSnapshot(userId));
}

export async function POST(request: Request) {
  const userId = await currentUserId();
  if (!userId) return json({ error: "Sign in to save favorites." }, 401);
  const body = await readProductBody(request);
  if (!body) return json({ error: "Invalid request." }, 400);
  const product = (await catalog()).find((item) => item.id === body.productId);
  if (!product) return json({ error: "Product not found." }, 404);
  const category = resolveCategory(product, body.category);
  try {
    // Write first, then count: the write lock serializes concurrent requests, so the limit cannot be overshot.
    await db.$transaction(async (tx) => {
      await tx.favorite.upsert({
        where: { userId_productId: { userId, productId: product.id } },
        create: { userId, productId: product.id, category }, update: { category },
      });
      if (await tx.favorite.count({ where: { userId } }) > MAX_FAVORITES) throw new FavoriteLimitError();
    });
  } catch (error) {
    if (error instanceof FavoriteLimitError) return json({ error: "Favorite limit reached." }, 422);
    if ((error as { code?: string }).code === "P2003") return json({ error: "Sign in again." }, 401);
    throw error;
  }
  return json({ productId: product.id, category }, 201);
}

export async function DELETE(request: Request) {
  const userId = await currentUserId();
  if (!userId) return json({ error: "Sign in to manage favorites." }, 401);
  const body = await readProductBody(request);
  if (!body) return json({ error: "Invalid request." }, 400);
  await db.favorite.deleteMany({ where: { userId, productId: body.productId } });
  return json({ productId: body.productId });
}
