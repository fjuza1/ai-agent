"use server";

import bcrypt from "bcryptjs";
import { AuthError } from "next-auth";
import { redirect } from "next/navigation";
import { db } from "../../lib/db";
import { hashPassword, signIn } from "../../lib/auth";
import { parseCategories } from "../../lib/categories";
import { requireUser } from "../../lib/session";

export async function removeFavorite(form) {
  const user = await requireUser("/account/favorites");
  const productId = String(form.get("productId") ?? "");
  await db.favorite.deleteMany({ where: { userId: user.id, productId } });
  const returnTo = String(form.get("returnTo") ?? "");
  redirect(/^\/account\/favorites(\?[\w=&%.-]*)?$/.test(returnTo) ? returnTo : "/account/favorites");
}

export async function saveSettings(form) {
  const user = await requireUser("/account/settings");
  await db.user.update({ where: { id: user.id }, data: {
    favoriteCategories: parseCategories(form.getAll("favoriteCategories")),
    emailAlertsEnabled: form.get("emailAlertsEnabled") === "on",
    trackingEnabled: form.get("trackingEnabled") === "on",
    // The schedule is fixed by product policy, so it is enforced here rather than read from the form.
    alertIntervalHours: 4,
    workdaysOnly: true,
  } });
  redirect("/account/settings?saved=1");
}

export async function unsubscribeAll() {
  const user = await requireUser("/account/settings");
  await db.user.update({ where: { id: user.id }, data: { emailAlertsEnabled: false, trackingEnabled: false } });
  redirect("/account/settings?unsubscribed=1");
}

export async function setPassword(form) {
  const user = await requireUser("/account/settings");
  const next = String(form.get("newPassword") ?? "");
  if (next.length < 10 || next.length > 72) redirect("/account/settings?error=password");
  if (user.passwordHash && !(await bcrypt.compare(String(form.get("currentPassword") ?? "").slice(0, 128), user.passwordHash))) redirect("/account/settings?error=current");
  await db.user.update({ where: { id: user.id }, data: { passwordHash: await hashPassword(next) } });
  redirect("/account/settings?saved=1");
}

export async function sendVerification() {
  const user = await requireUser("/account/settings");
  if (user.emailVerified) redirect("/account/settings");
  try {
    await signIn("sendgrid", { email: user.email, redirectTo: "/account/settings?verified=1" });
  } catch (error) {
    if (error instanceof AuthError) redirect("/account/settings?error=verification");
    throw error;
  }
}
