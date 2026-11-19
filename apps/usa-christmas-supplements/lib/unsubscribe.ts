import { db } from "./db";

export const validUnsubscribeToken = (token: unknown): token is string =>
  typeof token === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(token);

export async function unsubscribeByToken(token: unknown): Promise<boolean> {
  if (!validUnsubscribeToken(token)) return false;
  const { count } = await db.user.updateMany({ where: { unsubscribeToken: token }, data: { emailAlertsEnabled: false, trackingEnabled: false } });
  return count > 0;
}
