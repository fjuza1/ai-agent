import { createHmac, timingSafeEqual } from "node:crypto";

function secretKey(override?: string): string {
  const secret = override ?? process.env.AUTH_SECRET;
  if (!secret || secret.length < 16) throw new Error("AUTH_SECRET must be set (16+ characters) to sign tracking links.");
  return secret;
}

function mac(userId: string, productId: string, secret?: string): Buffer {
  return createHmac("sha256", secretKey(secret)).update(`click:v1:${userId}:${productId}`).digest();
}

export function signClick(userId: string, productId: string, secret?: string): string {
  return mac(userId, productId, secret).toString("base64url");
}

export function verifyClick(userId: string, productId: string, signature: string, secret?: string): boolean {
  if (!/^[A-Za-z0-9_-]{43}$/.test(signature)) return false;
  return timingSafeEqual(mac(userId, productId, secret), Buffer.from(signature, "base64url"));
}
