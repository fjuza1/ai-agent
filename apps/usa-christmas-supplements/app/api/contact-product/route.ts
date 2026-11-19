import { contactProduct } from "../../../../../packages/contact-product/contact";
import { createRateLimiter } from "../../../../../packages/rate-limit/rateLimit";
import { siteOrigin } from "../../../../../packages/seo";
import { catalog } from "../../../lib/catalog";

export const runtime = "nodejs";

const limiter = createRateLimiter({ limit: 5, windowMs: 10 * 60_000 });

export function POST(request: Request) {
  return contactProduct(request, {
    limiter,
    findProduct: async (id) => (await catalog()).find((product) => product.id === id),
    origin: () => siteOrigin(process.env.SUPPLEMENT_APP_URL, "http://localhost:3001"),
    path: (id) => `/product/${id}`,
  });
}
