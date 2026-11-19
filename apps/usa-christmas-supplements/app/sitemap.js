import { catalog } from "../lib/catalog";
import { siteOrigin } from "../../../packages/seo";
export const dynamic = "force-dynamic";

export default async function sitemap() {
  const origin = siteOrigin(process.env.SUPPLEMENT_APP_URL, "http://localhost:3001");
  return ["/", "/builder", "/category/family-planning-bundles", ...(await catalog()).map((p) => `/product/${p.id}`)].map((path) => ({ url: new URL(path, origin).toString() }));
}
