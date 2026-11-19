import { db } from "../../../../lib/db";
import { currentUserId } from "../../../../lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const userId = await currentUserId();
  if (!userId) return Response.json({ error: "Sign in to export your data." }, { status: 401 });
  const user = await db.user.findUnique({
    where: { id: userId },
    select: {
      id: true, name: true, email: true, emailVerified: true, createdAt: true, favoriteCategories: true,
      emailAlertsEnabled: true, alertIntervalHours: true, workdaysOnly: true, trackingEnabled: true, lastEmailedAt: true,
      favorites: { select: { productId: true, category: true, createdAt: true } },
      engagement: { select: { productId: true, category: true, event: true, createdAt: true }, orderBy: { createdAt: "asc" } },
    },
  });
  if (!user) return Response.json({ error: "Account not found." }, { status: 404 });
  return new Response(JSON.stringify({ exportedAt: new Date().toISOString(), ...user }, null, 2), {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": 'attachment; filename="winterwell-account-data.json"',
      "Cache-Control": "no-store",
    },
  });
}
