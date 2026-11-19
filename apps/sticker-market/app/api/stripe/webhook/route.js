import { randomInt, randomUUID } from "node:crypto";
import { db } from "../../../../lib/db";
import { stripe } from "../../../../lib/stripe";
import { quotaConfig, releaseQuota } from "../../../../lib/quota";
import { stickers } from "../../../../lib/stickers";

export async function POST(request) {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) return new Response("Webhook is not configured", { status: 503 });
  let event;
  try {
    event = stripe().webhooks.constructEvent(await request.text(), request.headers.get("stripe-signature") || "", secret);
  } catch (error) {
    console.error("Invalid Stripe webhook signature", error);
    return new Response("Invalid signature", { status: 400 });
  }
  if (!["checkout.session.completed", "checkout.session.expired"].includes(event.type)) return new Response("Ignored");
  const session = event.data.object;
  const purchaseId = session.metadata?.purchaseId;
  if (!purchaseId) return new Response("Missing purchase metadata", { status: 400 });
  try {
    await db.$transaction(async (tx) => {
      const purchase = await tx.purchase.findUnique({ where: { id: purchaseId } });
      if (!purchase || (purchase.stripeSessionId && purchase.stripeSessionId !== session.id)) throw new Error("Purchase/session mismatch.");
      if (purchase.state !== "pending") return;
      if (event.type === "checkout.session.expired") {
        await tx.purchase.update({ where: { id: purchaseId }, data: { state: "expired", stripeSessionId: session.id } });
        if (purchase.listingId) await tx.listing.updateMany({ where: { id: purchase.listingId, state: "reserved" }, data: { state: "active" } });
        if (purchase.kind === "pack" && purchase.quotaDay && purchase.quotaUnits) await releaseQuota(tx, purchase.userId, purchase.quotaDay, purchase.quotaUnits);
        return;
      }
      if (session.payment_status !== "paid" || session.currency !== "usd") throw new Error("Checkout is not paid in USD.");
      if (purchase.kind === "pack") {
        if (session.amount_total !== 500) throw new Error("Pack amount mismatch.");
        await tx.sticker.createMany({ data: Array.from({ length: 3 }, () => {
          const item = stickers[randomInt(stickers.length)];
          return { serial: randomUUID(), name: item.name, imageId: item.id, ownerId: purchase.userId };
        }) });
      } else if (purchase.kind === "credits") {
        if (purchase.creditUnits < 25 || purchase.creditUnits > 5000 || session.amount_total !== purchase.creditUnits * quotaConfig().cents) throw new Error("Credit checkout amount mismatch.");
        await tx.user.update({ where: { id: purchase.userId }, data: { stickerCredits: { increment: purchase.creditUnits } } });
      } else if (purchase.kind === "resale") {
        const listing = await tx.listing.findUnique({ where: { id: purchase.listingId }, include: { sticker: true } });
        if (!listing || listing.state !== "reserved" || listing.sellerId !== listing.sticker.ownerId || session.amount_total !== listing.priceCents) throw new Error("Reserved listing or amount mismatch.");
        const moved = await tx.sticker.updateMany({ where: { id: listing.stickerId, ownerId: listing.sellerId }, data: { ownerId: purchase.userId } });
        if (moved.count !== 1) throw new Error("Ownership changed during checkout.");
        await tx.listing.delete({ where: { id: listing.id } });
      } else {
        throw new Error("Unknown purchase type.");
      }
      await tx.purchase.update({ where: { id: purchase.id }, data: { state: "fulfilled", stripeSessionId: session.id } });
    });
    return new Response("OK");
  } catch (error) {
    console.error("Webhook fulfillment failed", purchaseId, error);
    return new Response("Fulfillment failed; retry required", { status: 500 });
  }
}
