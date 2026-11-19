import { appendFile } from "node:fs/promises";
import path from "node:path";
import { catalog } from "../../../lib/catalog";
import { clientKey, createRateLimiter } from "../../../../../packages/rate-limit/rateLimit";

export const dynamic = "force-dynamic";
// In-memory only (never written to the log): caps how fast one client can grow the click log.
const logLimiter = createRateLimiter({ limit: 30, windowMs: 60_000 });
export async function GET(request, { params }) {
  const { productId } = await params;
  const product = (await catalog()).find((p) => p.id === productId);
  if (!product) return new Response("Product not found", { status: 404 });
  let target;
  let kind = "internal";
  if (product.affiliate_url) {
    target = new URL(product.affiliate_url);
    if (target.protocol !== "https:" || target.username || target.password) return new Response("Invalid retailer URL", { status: 422 });
    kind = product.affiliate_type || "direct";
    if (kind === "amazon" && !/^(?:[a-z0-9-]+\.)?amazon\.com$/i.test(target.hostname)) return new Response("Invalid Amazon retailer domain", { status: 422 });
    const tag = kind === "amazon" ? process.env.AFFILIATE_TAG_AMAZON : process.env.AFFILIATE_TAG_DIRECT;
    if (tag) {
      if (!/^[a-zA-Z0-9._-]{1,128}$/.test(tag)) return new Response("Invalid affiliate configuration", { status: 503 });
      target.searchParams.set(kind === "amazon" ? "tag" : "ref", tag);
    }
  } else {
    target = `/product/${encodeURIComponent(product.id)}`;
  }
  // Click tracking is best-effort and throttled per client; it must never block the redirect.
  if (logLimiter.check(clientKey(request.headers)).ok) {
    try {
      const file = process.env.AFFILIATE_CLICK_LOG
        ? path.resolve(process.env.AFFILIATE_CLICK_LOG)
        : path.resolve(process.cwd(), "../../data/affiliate_clicks.jsonl");
      await appendFile(file, `${JSON.stringify({ at: new Date().toISOString(), productId: product.id, destination: kind })}\n`, "utf8");
    } catch (error) {
      console.error("Could not record affiliate redirect", error);
    }
  }
  return new Response(null, { status: 302, headers: { Location: target.toString(), "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "X-Robots-Tag": "noindex, nofollow" } });
}
