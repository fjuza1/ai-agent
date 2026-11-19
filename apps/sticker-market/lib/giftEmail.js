import { createHmac, timingSafeEqual } from "node:crypto";
import { appUrl } from "./stripe.js";

function secret() {
  const value = process.env.GIFT_UNSUBSCRIBE_SECRET || process.env.AUTH_SECRET;
  if (!value || value.length < 16) throw new Error("GIFT_UNSUBSCRIBE_SECRET (or AUTH_SECRET) must be at least 16 characters.");
  return value;
}
const normalize = (email) => String(email).trim().toLowerCase();
const sign = (email) => createHmac("sha256", secret()).update(`gift-unsubscribe:${normalize(email)}`).digest("hex");

export function unsubscribeUrl(email) {
  const url = new URL("/unsubscribe", appUrl());
  url.searchParams.set("e", Buffer.from(normalize(email)).toString("base64url"));
  url.searchParams.set("t", sign(email));
  return url.toString();
}

/** Returns the email address for a valid unsubscribe link, otherwise null. */
export function verifyUnsubscribe(encoded, token) {
  try {
    const email = Buffer.from(String(encoded), "base64url").toString("utf8");
    const expected = Buffer.from(sign(email), "hex");
    const given = Buffer.from(String(token), "hex");
    return email && email.length <= 254 && given.length === expected.length && timingSafeEqual(given, expected) ? normalize(email) : null;
  } catch {
    return null;
  }
}

async function isSuppressed(email) {
  const { db } = await import("./db.js");
  return Boolean(await db.giftEmailSuppression.findUnique({ where: { email: normalize(email) } }));
}

export async function suppressEmail(email) {
  const { db } = await import("./db.js");
  await db.giftEmailSuppression.upsert({ where: { email: normalize(email) }, create: { email: normalize(email) }, update: {} });
}

/** Returns "sent", or "suppressed" when the recipient has opted out of gift emails. */
export async function sendGiftEmail(recipient, token, { suppressed = isSuppressed } = {}) {
  if (!process.env.RESEND_API_KEY || !process.env.GIFT_EMAIL_FROM) throw new Error("Gift email provider is not configured.");
  if (await suppressed(recipient)) return "suppressed";
  const link = `${appUrl()}/claim/${token}`;
  const optOut = unsubscribeUrl(recipient);
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: process.env.GIFT_EMAIL_FROM, to: [recipient], subject: "You received a sticker gift",
      headers: { "List-Unsubscribe": `<${optOut}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" },
      html: `<p>You received a sticker gift.</p><p><a href="${link}">Accept Gift</a></p><p>This private link expires in seven days.</p><p style="font-size:12px">Someone entered your address to send you this gift. <a href="${optOut}">Stop receiving gift emails</a>.</p>` }),
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) throw new Error(`Gift email provider returned HTTP ${response.status}.`);
  return "sent";
}
