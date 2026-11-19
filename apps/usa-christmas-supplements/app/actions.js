"use server";

import { createHash } from "node:crypto";
import Stripe from "stripe";
import { redirect } from "next/navigation";
import { catalog } from "../lib/catalog";
import { checkoutSelection } from "../lib/checkoutSelection";

export async function checkout(form) {
  const products = await catalog();
  const { ids, selected, discreet } = checkoutSelection(products, form);
  if (!process.env.STRIPE_SECRET_KEY) throw new Error("Stripe checkout is not configured.");
  const url = new URL(process.env.SUPPLEMENT_APP_URL || "http://localhost:3001");
  if (url.protocol !== "https:" && url.hostname !== "localhost") throw new Error("SUPPLEMENT_APP_URL must use HTTPS.");
  const params = {
    mode: "payment",
    line_items: selected.map((p) => ({ price_data: { currency: "usd", unit_amount: p.price_cents, product_data: { name: p.name, metadata: { product_id: p.id } } }, quantity: 1 })),
    shipping_address_collection: { allowed_countries: ["US"] },
    success_url: `${url.origin}/?checkout=success`,
    cancel_url: `${url.origin}/?checkout=cancelled`,
    metadata: { store: "usa-christmas-supplements", product_ids: ids.join(","), discreet_gift_box: discreet ? "requested" : "no", sticker_gift: form.get("stickerGift") === "yes" ? "requested" : "no" },
  };
  // Same cart within a 5-minute bucket (double-click, client retry) reuses one Checkout Session; any cart/price change yields a new key.
  const idempotencyKey = createHash("sha256").update(JSON.stringify([params, Math.floor(Date.now() / 300_000)])).digest("hex");
  const session = await new Stripe(process.env.STRIPE_SECRET_KEY).checkout.sessions.create(params, { idempotencyKey });
  if (!session.url) throw new Error("Stripe returned no checkout URL.");
  redirect(session.url);
}
