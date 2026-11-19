import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";
import { db } from "./db";
import { redirect } from "next/navigation";

const cookieName = "sticker_session";
export function digest(value) { return createHash("sha256").update(value).digest("hex"); }
export function hashPassword(password) {
  const salt = randomBytes(16).toString("hex");
  return `${salt}:${scryptSync(password, salt, 64).toString("hex")}`;
}
export function verifyPassword(password, hash) {
  const [salt, expectedHex] = hash.split(":");
  if (!salt || !/^[a-f0-9]{128}$/.test(expectedHex || "")) return false;
  return timingSafeEqual(scryptSync(password, salt, 64), Buffer.from(expectedHex, "hex"));
}
export async function currentUser() {
  const token = (await cookies()).get(cookieName)?.value;
  if (!token || !/^[a-f0-9]{64}$/.test(token)) return null;
  const session = await db.session.findUnique({ where: { id: digest(token) }, include: { user: true } });
  return session && session.expiresAt > new Date() ? session.user : null;
}
export async function requireUser() {
  const user = await currentUser();
  if (!user) redirect("/login");
  return user;
}
export async function createSession(userId) {
  const token = randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + 7 * 86400_000);
  await db.session.create({ data: { id: digest(token), userId, expiresAt } });
  (await cookies()).set(cookieName, token, { httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "lax", path: "/", expires: expiresAt });
}
export async function endSession() {
  const token = (await cookies()).get(cookieName)?.value;
  if (token) await db.session.deleteMany({ where: { id: digest(token) } });
  (await cookies()).delete(cookieName);
}
