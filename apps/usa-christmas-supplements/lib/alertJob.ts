import type { MailDataRequired } from "@sendgrid/mail";
import type { Product } from "./usaFilter.ts";
import { parseCategories } from "./categories.ts";
import { buildAlertMail, dueCutoff, isWorkday, recommend, REPEAT_EXCLUSION_DAYS } from "./alerts.ts";

const DAY = 86_400_000;
const CLICK_HISTORY_DAYS = 90;
const MAX_USERS_PER_RUN = 1000;
const CONCURRENCY = 10;

type DueUser = { id: string; email: string; unsubscribeToken: string; trackingEnabled: boolean; favoriteCategories: unknown; lastEmailedAt: Date | null };
type LogRow = { productId: string; category: string | null; event: string; createdAt: Date };

// The subset of the Prisma client the job needs, so tests can supply an in-memory fake.
export type AlertDb = {
  user: {
    findMany(args: unknown): Promise<DueUser[]>;
    updateMany(args: { where: { id: string; lastEmailedAt: Date | null }; data: { lastEmailedAt: Date | null } }): Promise<{ count: number }>;
  };
  emailEngagementLog: {
    findMany(args: unknown): Promise<LogRow[]>;
    createMany(args: { data: Array<{ userId: string; productId: string; category: string; event: string }> }): Promise<unknown>;
  };
};

export type AlertSummary = { skipped?: "not-a-workday"; due: number; sent: number; noMatch: number; failed: number };

export async function runAlertJob(options: {
  db: AlertDb; products: Product[]; now: Date; origin: string; from: string; ipPoolName?: string; secret?: string;
  send: (mail: MailDataRequired) => Promise<unknown>;
}): Promise<AlertSummary> {
  const { db, products, now, send } = options;
  const summary: AlertSummary = { due: 0, sent: 0, noMatch: 0, failed: 0 };
  if (!isWorkday(now)) return { ...summary, skipped: "not-a-workday" };

  const users = await db.user.findMany({
    where: { emailAlertsEnabled: true, emailVerified: { not: null }, OR: [{ lastEmailedAt: null }, { lastEmailedAt: { lte: dueCutoff(now) } }] },
    orderBy: { lastEmailedAt: "asc" },
    take: MAX_USERS_PER_RUN,
    select: { id: true, email: true, unsubscribeToken: true, trackingEnabled: true, favoriteCategories: true, lastEmailedAt: true },
  });
  summary.due = users.length;

  const processUser = async (user: DueUser) => {
    const categories = parseCategories(user.favoriteCategories);
    const history = categories.length ? await db.emailEngagementLog.findMany({
      where: { userId: user.id, createdAt: { gte: new Date(now.getTime() - CLICK_HISTORY_DAYS * DAY) } },
      select: { productId: true, category: true, event: true, createdAt: true },
    }) : [];
    const sentSince = now.getTime() - REPEAT_EXCLUSION_DAYS * DAY;
    const recentlySentIds = new Set(history.filter((row) => row.event === "sent" && row.createdAt.getTime() >= sentSince).map((row) => row.productId));
    const clicksByCategory = new Map<string, number>();
    if (user.trackingEnabled) for (const row of history) if (row.event === "click" && row.category) clicksByCategory.set(row.category, (clicksByCategory.get(row.category) ?? 0) + 1);

    const picks = recommend({ products, categories, recentlySentIds, clicksByCategory });
    if (!picks.length) { summary.noMatch++; return; }

    // Compare-and-set claim so overlapping cron runs cannot email the same user twice.
    const claim = await db.user.updateMany({ where: { id: user.id, lastEmailedAt: user.lastEmailedAt }, data: { lastEmailedAt: now } });
    if (claim.count === 0) return;
    try {
      await send(buildAlertMail(user, picks, options));
    } catch (error) {
      await db.user.updateMany({ where: { id: user.id, lastEmailedAt: now }, data: { lastEmailedAt: user.lastEmailedAt } });
      summary.failed++;
      console.error(`Product alert failed for user ${user.id}`, error instanceof Error ? error.message : error);
      return;
    }
    summary.sent++;
    await db.emailEngagementLog.createMany({ data: picks.map(({ product, category }) => ({ userId: user.id, productId: product.id, category, event: "sent" })) });
  };

  for (let i = 0; i < users.length; i += CONCURRENCY) {
    await Promise.all(users.slice(i, i + CONCURRENCY).map((user) => processUser(user).catch((error) => {
      summary.failed++;
      console.error(`Product alert processing failed for user ${user.id}`, error instanceof Error ? error.message : error);
    })));
  }
  return summary;
}
