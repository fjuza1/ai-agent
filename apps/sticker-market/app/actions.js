"use server";

import { randomBytes } from "node:crypto";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { db } from "../lib/db";
import { createSession, currentUser, digest, endSession, hashPassword, requireUser, verifyPassword } from "../lib/auth";
import { appUrl, stripe } from "../lib/stripe";
import { consumeQuota, QuotaExceeded, quotaConfig } from "../lib/quota";
import { sendGiftEmail } from "../lib/giftEmail";
import { clientKey, createRateLimiter } from "../../../packages/rate-limit/rateLimit";

const registerByIp = createRateLimiter({ limit: 5, windowMs: 60 * 60_000 });
const loginByIp = createRateLimiter({ limit: 20, windowMs: 15 * 60_000 });
const loginByEmail = createRateLimiter({ limit: 5, windowMs: 15 * 60_000 });

function enforce(...results) {
  const blocked = results.find((result) => !result.ok);
  if (blocked) throw new Error(`Too many attempts. Try again in ${Math.ceil(blocked.retryAfterSeconds / 60)} minute(s).`);
}

function value(form, name) { return String(form.get(name) || "").trim(); }
function checkedEmail(form) {
  const email = value(form, "email").toLowerCase();
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error("Enter a valid email address.");
  return email;
}
export async function register(form) {
  enforce(registerByIp.check(clientKey(await headers())));
  const email = checkedEmail(form);
  const password = String(form.get("password") || "");
  if (password.length < 12 || password.length > 128) throw new Error("Password must be 12–128 characters.");
  const user = await db.user.create({ data: { email, passwordHash: hashPassword(password) } });
  await createSession(user.id);
  redirect("/vault");
}
export async function login(form) {
  const email = checkedEmail(form);
  enforce(loginByIp.check(clientKey(await headers())), loginByEmail.check(email));
  const user = await db.user.findUnique({ where: { email } });
  if (!user || !verifyPassword(String(form.get("password") || ""), user.passwordHash)) throw new Error("Invalid email or password.");
  loginByEmail.reset(email);
  await createSession(user.id);
  redirect("/vault");
}
export async function logout() { await endSession(); redirect("/"); }

export async function onboardSeller() {
  const user = await requireUser();
  const client = stripe();
  let account = user.connectAccountId;
  if (!account) {
    const created = await client.accounts.create({ type: "express", email: user.email, capabilities: { transfers: { requested: true } } });
    const result = await db.user.updateMany({ where: { id: user.id, connectAccountId: null }, data: { connectAccountId: created.id } });
    if (result.count !== 1) throw new Error("Seller account changed concurrently. Retry onboarding.");
    account = created.id;
  }
  const link = await client.accountLinks.create({ account, refresh_url: `${appUrl()}/vault`, return_url: `${appUrl()}/vault`, type: "account_onboarding" });
  redirect(link.url);
}

export async function listSticker(form) {
  const user = await requireUser();
  const stickerId = value(form, "stickerId");
  const dollars = value(form, "price");
  if (!/^\d{1,5}(\.\d{1,2})?$/.test(dollars)) throw new Error("Enter a valid price in dollars.");
  const cents = Math.round(Number(dollars) * 100);
  if (cents < 50 || cents > 9999999) throw new Error("Price must be between $0.50 and $99,999.99.");
  if (!user.connectAccountId) throw new Error("Complete Stripe seller onboarding first.");
  const account = await stripe().accounts.retrieve(user.connectAccountId);
  if (account.deleted || !account.payouts_enabled || account.capabilities?.transfers !== "active") throw new Error("Stripe seller account is not ready for transfers.");
  await db.$transaction(async (tx) => {
    const sticker = await tx.sticker.findFirst({ where: { id: stickerId, ownerId: user.id }, include: { gift: true } });
    if (!sticker || sticker.gift) throw new Error("Sticker is unavailable or has an outstanding gift.");
    await tx.listing.create({ data: { stickerId, sellerId: user.id, priceCents: cents } });
  });
  redirect("/marketplace");
}

export async function cancelListing(form) {
  const user = await requireUser();
  const removed = await db.listing.deleteMany({ where: { id: value(form, "listingId"), sellerId: user.id, state: "active" } });
  if (removed.count !== 1) throw new Error("Listing not found or checkout is in progress.");
  redirect("/vault");
}

export async function createGift(form) {
  const user = await requireUser();
  const stickerId = value(form, "stickerId");
  const recipient = value(form, "recipient").toLowerCase();
  if (recipient && (recipient.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipient))) throw new Error("Enter a valid recipient email.");
  if (recipient && (!process.env.RESEND_API_KEY || !process.env.GIFT_EMAIL_FROM)) throw new Error("Gift email is not configured; leave email blank to create a shareable link.");
  const token = randomBytes(32).toString("hex");
  try {
    await db.$transaction(async (tx) => {
      const sticker = await tx.sticker.findFirst({ where: { id: stickerId, ownerId: user.id }, include: { listing: true, gift: true } });
      if (!sticker || sticker.listing || sticker.gift) throw new Error("Sticker is unavailable; cancel its listing or gift first.");
      await consumeQuota(tx, user.id, 1);
      await tx.gift.create({ data: { id: digest(token), stickerId, ownerId: user.id, expiresAt: new Date(Date.now() + 7 * 86400_000) } });
    });
  } catch (error) {
    if (error instanceof QuotaExceeded) redirect("/overage");
    throw error;
  }
  let delivery = "";
  if (recipient) {
    try { delivery = (await sendGiftEmail(recipient, token)) === "suppressed" ? "?delivery=suppressed" : "?delivery=sent"; }
    catch (error) { console.error("Gift email delivery failed", error); delivery = "?delivery=failed"; }
  }
  redirect(`/gift/${token}${delivery}`);
}

export async function cancelGift(form) {
  const user = await requireUser();
  const removed = await db.gift.deleteMany({ where: { stickerId: value(form, "stickerId"), ownerId: user.id } });
  if (!removed.count) throw new Error("Gift not found.");
  redirect("/vault");
}

export async function claimGift(form) {
  const user = await requireUser();
  const token = value(form, "token");
  if (!/^[a-f0-9]{64}$/.test(token)) throw new Error("Invalid claim link.");
  let stickerId;
  try {
    stickerId = await db.$transaction(async (tx) => {
      const gift = await tx.gift.findUnique({ where: { id: digest(token) } });
      if (!gift || gift.expiresAt <= new Date() || gift.ownerId === user.id) throw new Error("Gift is expired, unavailable, or belongs to you.");
      await consumeQuota(tx, user.id, 1);
      const claimed = await tx.gift.deleteMany({ where: { id: gift.id, expiresAt: { gt: new Date() } } });
      if (claimed.count !== 1) throw new Error("Gift already claimed.");
      const moved = await tx.sticker.updateMany({ where: { id: gift.stickerId, ownerId: gift.ownerId }, data: { ownerId: user.id } });
      if (moved.count !== 1) throw new Error("Sticker ownership changed.");
      return gift.stickerId;
    });
  } catch (error) {
    if (error instanceof QuotaExceeded) redirect("/overage");
    throw error;
  }
  redirect(`/export/${stickerId}`);
}

export async function checkout(form) {
  const user = await requireUser();
  const listingId = value(form, "listingId");
  const client = stripe();
  const url = appUrl();
  let listing;
  let seller;
  if (listingId) {
    listing = await db.listing.findUnique({ where: { id: listingId }, include: { sticker: true } });
    if (!listing || listing.state !== "active" || listing.sellerId === user.id || listing.sticker.ownerId !== listing.sellerId) throw new Error("Listing unavailable.");
    seller = await db.user.findUnique({ where: { id: listing.sellerId } });
    if (!seller?.connectAccountId) throw new Error("Seller cannot receive transfers.");
    const account = await client.accounts.retrieve(seller.connectAccountId);
    if (account.deleted || !account.payouts_enabled || account.capabilities?.transfers !== "active") throw new Error("Seller cannot currently receive transfers.");
  }
  let purchase;
  try {
    purchase = await db.$transaction(async (tx) => {
      let quota;
      if (listing) {
        const reserved = await tx.listing.updateMany({ where: { id: listingId, state: "active" }, data: { state: "reserved" } });
        if (reserved.count !== 1) throw new Error("Listing is already reserved.");
      } else {
        quota = await consumeQuota(tx, user.id, 3);
      }
      return tx.purchase.create({ data: { userId: user.id, kind: listing ? "resale" : "pack", listingId: listing?.id, quotaDay: quota?.day, quotaUnits: quota?.units ?? 0 } });
    });
  } catch (error) {
    if (error instanceof QuotaExceeded) redirect("/overage");
    throw error;
  }
  let session;
  try {
    session = await client.checkout.sessions.create({
      mode: "payment",
      payment_method_types: ["card"],
      line_items: [{ price_data: { currency: "usd", unit_amount: listing?.priceCents ?? 500, product_data: { name: listing ? `Sticker ${listing.sticker.serial}` : "Collectible sticker pack (3 stickers)" } }, quantity: 1 }],
      metadata: { purchaseId: purchase.id },
      client_reference_id: purchase.id,
      success_url: `${url}/vault?checkout=success`,
      cancel_url: `${url}/vault?checkout=cancelled`,
      expires_at: Math.floor(Date.now() / 1000) + 1800,
      ...(seller ? { payment_intent_data: { transfer_data: { destination: seller.connectAccountId } } } : {}),
    }, { idempotencyKey: purchase.id });
  } catch (error) {
    // Unknown Stripe outcomes remain reserved for manual reconciliation.
    console.error("Checkout creation failed; reconcile purchase", purchase.id, error);
    throw new Error("Checkout could not be created. Contact support with the purchase ID.");
  }
  await db.purchase.update({ where: { id: purchase.id }, data: { stripeSessionId: session.id } });
  if (!session.url) throw new Error("Stripe returned no checkout URL.");
  redirect(session.url);
}

export async function buyCredits(form) {
  const user = await requireUser();
  const raw = value(form, "units");
  if (!/^\d+$/.test(raw)) throw new Error("Choose a whole number of credits.");
  const units = Number(raw);
  const { cents } = quotaConfig();
  if (!Number.isSafeInteger(units) || units < 25 || units > 5000) throw new Error("Choose between 25 and 5000 credits.");
  const client = stripe();
  const purchase = await db.purchase.create({ data: { userId: user.id, kind: "credits", creditUnits: units } });
  let session;
  try {
    session = await client.checkout.sessions.create({
      mode: "payment",
      payment_method_types: ["card"],
      line_items: [{ price_data: { currency: "usd", unit_amount: cents, product_data: { name: "Sticker overage credit" } }, quantity: units }],
      metadata: { purchaseId: purchase.id }, client_reference_id: purchase.id,
      success_url: `${appUrl()}/overage?checkout=success`,
      cancel_url: `${appUrl()}/overage?checkout=cancelled`,
      expires_at: Math.floor(Date.now() / 1000) + 1800,
    }, { idempotencyKey: purchase.id });
  } catch (error) {
    console.error("Credit checkout creation failed; reconcile purchase", purchase.id, error);
    throw new Error("Credit checkout could not be created. Contact support.");
  }
  await db.purchase.update({ where: { id: purchase.id }, data: { stripeSessionId: session.id } });
  if (!session.url) throw new Error("Stripe returned no checkout URL.");
  redirect(session.url);
}
