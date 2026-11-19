export class QuotaExceeded extends Error {}

export function quotaConfig() {
  const limit = Number(process.env.DAILY_FREE_STICKER_LIMIT ?? "20");
  const cents = Number(process.env.STRIPE_STICKER_OVERAGE_PRICE_CENTS ?? "2");
  if (limit !== 20 || cents !== 2) throw new Error("Sticker quota requires DAILY_FREE_STICKER_LIMIT=20 and STRIPE_STICKER_OVERAGE_PRICE_CENTS=2.");
  return { limit, cents };
}

export function quotaDay(now = new Date()) {
  // Allowance days are UTC by design; the overage page tells users when the day resets.
  return now.toISOString().slice(0, 10);
}

export async function consumeQuota(tx, userId, units, now = new Date()) {
  const { limit } = quotaConfig();
  if (!Number.isSafeInteger(units) || units < 1) throw new Error("Invalid sticker unit count.");
  const day = quotaDay(now);
  const usage = await tx.stickerDailyUsage.upsert({
    where: { userId_day: { userId, day } },
    create: { userId, day, count: 0 },
    update: {},
  });
  const credits = Math.max(0, usage.count + units - limit) - Math.max(0, usage.count - limit);
  if (credits) {
    const spent = await tx.user.updateMany({ where: { id: userId, stickerCredits: { gte: credits } }, data: { stickerCredits: { decrement: credits } } });
    if (spent.count !== 1) throw new QuotaExceeded("Daily free allowance exceeded; add sticker credits.");
  }
  await tx.stickerDailyUsage.update({ where: { userId_day: { userId, day } }, data: { count: { increment: units } } });
  return { day, units };
}

export async function releaseQuota(tx, userId, day, units) {
  const { limit } = quotaConfig();
  const usage = await tx.stickerDailyUsage.findUniqueOrThrow({ where: { userId_day: { userId, day } } });
  if (!Number.isSafeInteger(units) || units < 1 || usage.count < units) throw new Error("Invalid quota reservation release.");
  const refund = Math.max(0, usage.count - limit) - Math.max(0, usage.count - units - limit);
  await tx.stickerDailyUsage.update({ where: { userId_day: { userId, day } }, data: { count: { decrement: units } } });
  if (refund) await tx.user.update({ where: { id: userId }, data: { stickerCredits: { increment: refund } } });
}
