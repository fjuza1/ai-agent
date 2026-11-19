import type { MailDataRequired } from "@sendgrid/mail";
import type { Product } from "./usaFilter.ts";
import { categoriesFor, type FavoriteCategory } from "./categories.ts";
import { signClick } from "./signing.ts";

export const ALERT_INTERVAL_HOURS = 4;
export const ALERT_TIME_ZONE = "Europe/Berlin";
export const MAX_RECOMMENDATIONS = 3;
export const REPEAT_EXCLUSION_DAYS = 7;
// GitHub cron runs start late by minutes; without slack a 07:03 send would make the 11:00 run look 3h57m old and skip it.
const GRACE_MINUTES = 15;

export type Recommendation = { product: Product; category: FavoriteCategory };
export type AlertRecipient = { id: string; email: string; unsubscribeToken: string; trackingEnabled: boolean };

export function isWorkday(now: Date, timeZone = ALERT_TIME_ZONE): boolean {
  const day = new Intl.DateTimeFormat("en-US", { weekday: "short", timeZone }).format(now);
  return day !== "Sat" && day !== "Sun";
}

export function isDue(lastEmailedAt: Date | null, now: Date, intervalHours = ALERT_INTERVAL_HOURS): boolean {
  return !lastEmailedAt || now.getTime() - lastEmailedAt.getTime() >= intervalHours * 3_600_000 - GRACE_MINUTES * 60_000;
}

export function dueCutoff(now: Date, intervalHours = ALERT_INTERVAL_HOURS): Date {
  return new Date(now.getTime() - intervalHours * 3_600_000 + GRACE_MINUTES * 60_000);
}

type RecommendInput = {
  products: Product[];
  categories: readonly FavoriteCategory[];
  recentlySentIds: ReadonlySet<string>;
  // Click counts per category from the user's own engagement log; empty when tracking is off.
  clicksByCategory?: ReadonlyMap<string, number>;
  limit?: number;
};

export function recommend({ products, categories, recentlySentIds, clicksByCategory, limit = MAX_RECOMMENDATIONS }: RecommendInput): Recommendation[] {
  const wanted = new Set<string>(categories);
  const scored: Array<Recommendation & { score: number }> = [];
  for (const product of products) {
    if (recentlySentIds.has(product.id)) continue;
    const matches = categoriesFor(product).filter((category) => wanted.has(category));
    if (!matches.length) continue;
    const category = matches.reduce((best, next) => ((clicksByCategory?.get(next) ?? 0) > (clicksByCategory?.get(best) ?? 0) ? next : best));
    const rating = product.aggregate_rating?.rating_value ?? 0;
    const reviews = product.aggregate_rating?.review_count ?? 0;
    const engagement = Math.min(clicksByCategory?.get(category) ?? 0, 5) * 0.1;
    scored.push({ product, category, score: rating + Math.log10(1 + reviews) * 0.1 + engagement });
  }
  scored.sort((a, b) => b.score - a.score || a.product.id.localeCompare(b.product.id));
  return scored.slice(0, limit).map(({ product, category }) => ({ product, category }));
}

const escapeHtml = (value: string) => value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export function productLink(origin: string, user: AlertRecipient, productId: string, secret?: string): string {
  const id = encodeURIComponent(productId);
  if (!user.trackingEnabled) return `${origin}/product/${id}`;
  const params = new URLSearchParams({ uid: user.id, pid: productId, sig: signClick(user.id, productId, secret) });
  return `${origin}/api/track/click?${params}`;
}

export function buildAlertMail(user: AlertRecipient, items: Recommendation[], options: { origin: string; from: string; ipPoolName?: string; secret?: string }): MailDataRequired {
  const { origin } = options;
  const unsubscribePage = `${origin}/unsubscribe?token=${encodeURIComponent(user.unsubscribeToken)}`;
  const unsubscribePost = `${origin}/api/unsubscribe?token=${encodeURIComponent(user.unsubscribeToken)}`;
  const rows = items.map(({ product, category }) => ({
    name: product.name, category, link: productLink(origin, user, product.id, options.secret),
    price: `$${(product.price_cents / 100).toFixed(2)}`,
    rating: product.aggregate_rating ? `${product.aggregate_rating.rating_value}/5 (${product.aggregate_rating.review_count} reviews)` : "",
    description: product.description.slice(0, 160),
  }));
  const html = `<!doctype html><html><body style="font-family:Arial,sans-serif;color:#1f2933;max-width:560px;margin:0 auto;padding:16px">
<h1 style="font-size:22px">Your USA-made picks from Winterwell</h1>
<p>Based on your favorite categories, here are today's top-rated products.</p>
${rows.map((row) => `<div style="border:1px solid #d9e2ec;border-radius:10px;padding:14px;margin:12px 0">
<p style="margin:0;font-size:12px;text-transform:uppercase;letter-spacing:.08em">${escapeHtml(row.category)}</p>
<h2 style="font-size:18px;margin:6px 0"><a href="${escapeHtml(row.link)}">${escapeHtml(row.name)}</a></h2>
<p style="margin:6px 0">${escapeHtml(row.description)}</p>
<p style="margin:6px 0"><strong>${row.price}</strong>${row.rating ? ` · ${escapeHtml(row.rating)}` : ""}</p>
<a href="${escapeHtml(row.link)}">View product</a></div>`).join("\n")}
<hr style="border:0;border-top:1px solid #d9e2ec;margin:24px 0">
<p style="font-size:12px;color:#52606d">You receive these emails because you turned on product alerts. Supplements are not intended to diagnose, treat, cure, or prevent any disease.
<a href="${escapeHtml(origin)}/account/settings">Manage preferences</a> ·
<a href="${escapeHtml(unsubscribePage)}" clicktracking="off">Unsubscribe in one click</a></p>
</body></html>`;
  const text = [
    "Your USA-made picks from Winterwell", "",
    ...rows.map((row) => `${row.name} (${row.category}) - ${row.price}\n${row.link}`), "",
    `Manage preferences: ${origin}/account/settings`, `Unsubscribe: ${unsubscribePage}`,
  ].join("\n");
  return {
    to: user.email, from: options.from,
    subject: `Top USA-made picks: ${rows[0].name}`.slice(0, 120),
    html, text,
    headers: { "List-Unsubscribe": `<${unsubscribePost}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" },
    categories: ["product-alert"],
    ...(options.ipPoolName ? { ipPoolName: options.ipPoolName } : {}),
    // Engagement tracking is opt-in: users who turned it off get no open/click instrumentation or signed links at all.
    trackingSettings: user.trackingEnabled
      ? { clickTracking: { enable: true, enableText: false }, openTracking: { enable: true } }
      : { clickTracking: { enable: false, enableText: false }, openTracking: { enable: false } },
    ...(user.trackingEnabled ? { customArgs: { user_id: user.id, email_type: "product_alert" } } : {}),
  };
}
