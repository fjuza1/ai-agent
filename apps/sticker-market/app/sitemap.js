import { stickers } from "../lib/stickers";
import { siteOrigin } from "../../../packages/seo";
export const dynamic = "force-dynamic";
export default function sitemap() {
  const origin = siteOrigin(process.env.STICKER_APP_URL, "http://localhost:3000");
  return ["/", "/marketplace", "/stickers", ...stickers.map((s) => `/stickers/${s.id}`)].map((path) => ({ url: new URL(path, origin).toString() }));
}
