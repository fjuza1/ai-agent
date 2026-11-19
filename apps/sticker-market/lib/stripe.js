import Stripe from "stripe";

export function stripe() {
  if (!process.env.STRIPE_SECRET_KEY) throw new Error("STRIPE_SECRET_KEY is not configured.");
  return new Stripe(process.env.STRIPE_SECRET_KEY);
}
export function appUrl() {
  const url = new URL(process.env.STICKER_APP_URL || "http://localhost:3000");
  if (url.protocol !== "https:" && url.hostname !== "localhost") throw new Error("STICKER_APP_URL must use HTTPS.");
  return url.origin;
}
