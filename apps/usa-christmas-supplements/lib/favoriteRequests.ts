import { catalog } from "./catalog";
import { categoriesFor, isFavoriteCategory, parseCategories, primaryCategory } from "./categories";
import { db } from "./db";

export const MAX_FAVORITES = 500;
export const PRODUCT_ID = /^[A-Za-z0-9._-]{1,80}$/;
export const noStore = { "Cache-Control": "no-store" };
export const json = (body: unknown, status = 200) => Response.json(body, { status, headers: noStore });

export async function readJson(request: Request): Promise<Record<string, unknown> | null> {
  if (request.headers.get("sec-fetch-site") === "cross-site" || !request.headers.get("content-type")?.startsWith("application/json")) return null;
  try {
    const body = await request.json();
    return body && typeof body === "object" && !Array.isArray(body) ? body : null;
  } catch { return null; }
}

// The category is derived from the catalog; the client's choice is honored only when the product really belongs to it.
export function resolveCategory(product: Parameters<typeof categoriesFor>[0], requested: unknown): string {
  const options = categoriesFor(product);
  return isFavoriteCategory(requested) && options.includes(requested) ? requested : primaryCategory(product);
}

// Everything a pill needs to render: saved products (with display data) and the favorite categories that drive alerts.
export async function favoriteSnapshot(userId: string) {
  const [favorites, user, products] = await Promise.all([
    db.favorite.findMany({ where: { userId }, select: { productId: true, category: true }, orderBy: { createdAt: "desc" } }),
    db.user.findUnique({ where: { id: userId }, select: { favoriteCategories: true, emailAlertsEnabled: true, emailVerified: true } }),
    catalog(),
  ]);
  const byId = new Map(products.map((product) => [product.id, product]));
  return {
    favorites: favorites.map((favorite) => ({ ...favorite, name: byId.get(favorite.productId)?.name ?? null })),
    categories: parseCategories(user?.favoriteCategories),
    alertsEnabled: Boolean(user?.emailAlertsEnabled && user.emailVerified),
  };
}
