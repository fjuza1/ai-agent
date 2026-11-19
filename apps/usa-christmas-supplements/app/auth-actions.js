"use server";

import { AuthError } from "next-auth";
import { redirect } from "next/navigation";
import { db } from "../lib/db";
import { hashPassword, magicLinkEnabled, normalizeEmail, signIn, signOut } from "../lib/auth";
import { parseCategories } from "../lib/categories";

const EMAIL = /^[^\s@<>(),;:"[\]\\]+@[^\s@<>(),;:"[\]\\]+\.[^\s@<>(),;:"[\]\\]+$/;
const MIN_PASSWORD = 10;
const MAX_PASSWORD = 72;

function safePath(value, fallback) {
  return typeof value === "string" && /^\/(?![/\\])/.test(value) ? value : fallback;
}

// signIn() reports success by throwing a redirect, so only Auth.js errors are translated and everything else is rethrown.
async function attemptSignIn(provider, options, errorPage) {
  try {
    await signIn(provider, options);
  } catch (error) {
    if (error instanceof AuthError) redirect(`${errorPage}${errorPage.includes("?") ? "&" : "?"}error=${provider === "credentials" ? "credentials" : "email"}`);
    throw error;
  }
}

export async function login(form) {
  const email = normalizeEmail(form.get("email"));
  const redirectTo = safePath(form.get("callbackUrl"), "/account/favorites");
  await attemptSignIn("credentials", { email, password: String(form.get("password") ?? ""), redirectTo }, `/login?callbackUrl=${encodeURIComponent(redirectTo)}`);
}

export async function sendMagicLink(form) {
  const email = normalizeEmail(form.get("email"));
  const redirectTo = safePath(form.get("callbackUrl"), "/account/favorites");
  if (!magicLinkEnabled) redirect("/login?error=magic-unavailable");
  if (!EMAIL.test(email) || email.length > 254) redirect("/login?error=email");
  await attemptSignIn("sendgrid", { email, redirectTo }, "/login");
}

export async function signup(form) {
  const email = normalizeEmail(form.get("email"));
  const intent = form.get("intent") === "magic" ? "magic" : "password";
  const password = String(form.get("password") ?? "");
  const name = String(form.get("name") ?? "").trim().slice(0, 80) || null;
  const favoriteCategories = parseCategories(form.getAll("favoriteCategories"));
  const emailAlertsEnabled = form.get("emailAlertsEnabled") === "on" && favoriteCategories.length > 0;
  if (!EMAIL.test(email) || email.length > 254) redirect("/signup?error=email");
  if (intent === "magic" && !magicLinkEnabled) redirect("/signup?error=magic-unavailable");
  if (intent === "password" && (password.length < MIN_PASSWORD || password.length > MAX_PASSWORD)) redirect("/signup?error=password");

  const existing = await db.user.findUnique({ where: { email }, select: { id: true } });
  // Existing accounts are never modified from the public form, so a stranger cannot overwrite someone's preferences or password.
  if (existing && intent === "password") redirect("/signup?error=exists");
  if (!existing) {
    try {
      await db.user.create({ data: {
        email, name, favoriteCategories, emailAlertsEnabled,
        passwordHash: intent === "password" ? await hashPassword(password) : null,
      } });
    } catch (error) {
      if (error?.code === "P2002") redirect("/signup?error=exists");
      throw error;
    }
  }
  if (intent === "password") await attemptSignIn("credentials", { email, password, redirectTo: "/account/settings?welcome=1" }, "/login");
  else await attemptSignIn("sendgrid", { email, redirectTo: "/account/settings?welcome=1" }, "/signup");
}

export async function logout() {
  await signOut({ redirectTo: "/" });
}
