import { contactProduct } from "../../../../../packages/contact-product/contact";
import { createRateLimiter } from "../../../../../packages/rate-limit/rateLimit";
import { siteOrigin } from "../../../../../packages/seo";
import { stickerById } from "../../../lib/stickers";

export const runtime = "nodejs";

const limiter = createRateLimiter({ limit: 5, windowMs: 10 * 60_000 });

export function POST(request: Request) {
  return contactProduct(request, {
    limiter,
    findProduct: stickerById,
    origin: () => siteOrigin(process.env.STICKER_APP_URL, "http://localhost:3000"),
    path: (id) => `/stickers/${id}`,
  });
}
