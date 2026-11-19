"use server";

import { redirect } from "next/navigation";
import { unsubscribeByToken } from "../../lib/unsubscribe";

export async function confirmUnsubscribe(form) {
  const done = await unsubscribeByToken(String(form.get("token") ?? ""));
  redirect(done ? "/unsubscribe?done=1" : "/unsubscribe");
}
