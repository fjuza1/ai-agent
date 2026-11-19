import { siteOrigin } from "../../../packages/seo";
export const dynamic = "force-dynamic";
export default function robots() {
  const origin = siteOrigin(process.env.SUPPLEMENT_APP_URL, "http://localhost:3001");
  return { rules: { userAgent: "*", allow: "/", disallow: ["/go/", "/account/", "/api/", "/login", "/signup", "/unsubscribe"] }, sitemap: `${origin}/sitemap.xml` };
}
