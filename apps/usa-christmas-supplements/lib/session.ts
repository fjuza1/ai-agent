import "server-only";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { auth } from "./auth";
import { db } from "./db";

async function hasSessionCookie(): Promise<boolean> {
  return (await cookies()).getAll().some(({ name }) => /^(__Secure-)?authjs\.session-token/.test(name));
}

// Anonymous visitors never touch Auth.js or the database, so public pages keep working when auth is not configured.
export async function currentUserId(): Promise<string | null> {
  if (!(await hasSessionCookie())) return null;
  try {
    return (await auth())?.user?.id ?? null;
  } catch (error) {
    console.error("Could not read the session", error);
    return null;
  }
}

export async function currentUser() {
  const id = await currentUserId();
  return id ? db.user.findUnique({ where: { id } }) : null;
}

export async function requireUser(callbackUrl: string) {
  const user = await currentUser();
  if (!user) redirect(`/login?callbackUrl=${encodeURIComponent(callbackUrl)}`);
  return user;
}
