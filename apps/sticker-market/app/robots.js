import { siteOrigin } from "../../../packages/seo";
export const dynamic = "force-dynamic";
export default function robots() {
  const origin = siteOrigin(process.env.STICKER_APP_URL, "http://localhost:3000");
  return { rules: { userAgent: "*", allow: "/", disallow: ["/vault", "/gift/", "/claim/", "/export/", "/overage", "/unsubscribe", "/api/"] }, sitemap: `${origin}/sitemap.xml` };
}
