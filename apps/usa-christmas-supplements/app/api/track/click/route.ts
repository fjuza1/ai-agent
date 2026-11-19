import { catalog } from "../../../../lib/catalog";
import { db } from "../../../../lib/db";
import { verifyClick } from "../../../../lib/signing";
import { categoriesFor, primaryCategory } from "../../../../lib/categories";
import { siteOrigin } from "../../../../../../packages/seo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const uid = params.get("uid") ?? "";
  const pid = params.get("pid") ?? "";
  const sig = params.get("sig") ?? "";
  const origin = siteOrigin(process.env.SUPPLEMENT_APP_URL, "http://localhost:3001");
  const headers = { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "X-Robots-Tag": "noindex, nofollow" };

  let valid = false;
  try { valid = uid.length > 0 && uid.length <= 64 && pid.length > 0 && pid.length <= 80 && verifyClick(uid, pid, sig); } catch (error) {
    console.error("Click tracking is not configured", error);
  }
  if (!valid) return new Response("Invalid link", { status: 400, headers });

  const product = (await catalog()).find((item) => item.id === pid);
  // The destination is always an on-site product page, never a caller-supplied URL.
  const destination = new URL(product ? `/product/${encodeURIComponent(product.id)}` : "/", origin).toString();
  if (product) {
    try {
      const user = await db.user.findUnique({ where: { id: uid }, select: { trackingEnabled: true, favoriteCategories: true } });
      if (user?.trackingEnabled) {
        const favorites = Array.isArray(user.favoriteCategories) ? user.favoriteCategories : [];
        const category = categoriesFor(product).find((item) => favorites.includes(item)) ?? primaryCategory(product);
        await db.emailEngagementLog.create({ data: { userId: uid, productId: product.id, category, event: "click" } });
      }
    } catch (error) {
      console.error("Could not record email click", error);
    }
  }
  return new Response(null, { status: 302, headers: { ...headers, Location: destination } });
}
