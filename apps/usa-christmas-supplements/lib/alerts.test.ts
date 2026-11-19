import { strict as assert } from "node:assert";
import { test } from "node:test";
import { buildAlertMail, isDue, isWorkday, productLink, recommend } from "./alerts.ts";
import { runAlertJob } from "./alertJob.ts";

const secret = "test-secret-with-enough-length";
const product = (id: string, rating: number | undefined, categories: string[], extra = {}) => ({
  id, name: `Item ${id}`, description: "A reviewed <gift>.", price_cents: 1999,
  origin_country: "USA", verified_usa_manufacturing: true, review_status: "approved",
  verification_source: "https://example.com/evidence", categories, goals: [],
  ...(rating ? { aggregate_rating: { rating_value: rating, review_count: 10, source_url: "https://example.com/reviews" } } : {}), ...extra,
}) as never;

test("alerts only go out Monday to Friday and only when 4 hours have passed (with cron slack)", () => {
  assert.equal(isWorkday(new Date("2026-11-20T07:00:00Z")), true);
  assert.equal(isWorkday(new Date("2026-11-21T11:00:00Z")), false);
  assert.equal(isWorkday(new Date("2026-11-22T11:00:00Z")), false);
  const now = new Date("2026-11-20T11:00:00Z");
  assert.equal(isDue(null, now), true);
  assert.equal(isDue(new Date("2026-11-20T07:05:00Z"), now), true);
  assert.equal(isDue(new Date("2026-11-20T07:30:00Z"), now), false);
});

test("recommendations are the top-rated matches, skip recent sends, and learn from clicks", () => {
  const products = [
    product("low", 3.5, ["Holiday Gift Bundles"]), product("high", 4.9, ["Holiday Gift Bundles"]),
    product("mid", 4.2, ["Holiday Gift Bundles"]), product("sent", 5, ["Holiday Gift Bundles"]),
    product("other", 5, ["family-planning-bundles"]), product("fourth", 4.0, ["Holiday Gift Bundles"]),
  ];
  const picks = recommend({ products, categories: ["Holiday Gift Boxes"], recentlySentIds: new Set(["sent"]) });
  assert.deepEqual(picks.map((p) => p.product.id), ["high", "mid", "fourth"]);
  const tie = [product("a", 4, ["Holiday Gift Bundles"]), product("b", 4, ["family-planning-bundles"])];
  const clicked = recommend({ products: tie, categories: ["Holiday Gift Boxes", "Family Planning & Pregnancy Tests"], recentlySentIds: new Set(), clicksByCategory: new Map([["Family Planning & Pregnancy Tests", 4]]) });
  assert.equal(clicked[0].product.id, "b");
});

test("emails carry a signed tracking link only when tracking is enabled and always include unsubscribe", () => {
  const picks = recommend({ products: [product("x", 4.5, ["Holiday Gift Bundles"])], categories: ["Holiday Gift Boxes"], recentlySentIds: new Set() });
  const tracked = buildAlertMail({ id: "u1", email: "a@example.com", unsubscribeToken: "tok", trackingEnabled: true }, picks, { origin: "https://shop.example", from: "from@example.com", secret });
  assert.match(String(tracked.html), /\/api\/track\/click\?uid=u1&amp;pid=x&amp;sig=/);
  assert.match(String(tracked.html), /https:\/\/shop\.example\/unsubscribe\?token=tok/);
  assert.match(String(tracked.html), /A reviewed &lt;gift&gt;\./);
  assert.equal(tracked.trackingSettings?.clickTracking?.enable, true);
  assert.equal(tracked.trackingSettings?.openTracking?.enable, true);
  const plain = buildAlertMail({ id: "u1", email: "a@example.com", unsubscribeToken: "tok", trackingEnabled: false }, picks, { origin: "https://shop.example", from: "from@example.com", secret });
  assert.doesNotMatch(String(plain.html), /track\/click/);
  assert.match(String(plain.html), /https:\/\/shop\.example\/product\/x/);
  assert.equal(plain.trackingSettings?.clickTracking?.enable, false);
  assert.match(String((plain.headers as Record<string, string>)["List-Unsubscribe"]), /\/api\/unsubscribe\?token=tok/);
  assert.equal(productLink("https://shop.example", { id: "u", email: "", unsubscribeToken: "", trackingEnabled: false }, "a b"), "https://shop.example/product/a%20b");
});

test("the job claims users once, logs sends, restores the claim on failure and skips weekends", async () => {
  const users = [
    { id: "ok", email: "ok@example.com", unsubscribeToken: "t1", trackingEnabled: false, favoriteCategories: ["Holiday Gift Boxes"], lastEmailedAt: null },
    { id: "bad", email: "bad@example.com", unsubscribeToken: "t2", trackingEnabled: false, favoriteCategories: ["Holiday Gift Boxes"], lastEmailedAt: null },
    { id: "none", email: "none@example.com", unsubscribeToken: "t3", trackingEnabled: false, favoriteCategories: ["Immunity"], lastEmailedAt: null },
  ];
  const state = new Map(users.map((u) => [u.id, u.lastEmailedAt as Date | null]));
  const logs: Array<{ userId: string; productId: string; event: string }> = [];
  const db = {
    user: {
      findMany: async () => users,
      updateMany: async ({ where, data }: { where: { id: string; lastEmailedAt: Date | null }; data: { lastEmailedAt: Date | null } }) => {
        const same = (state.get(where.id) ?? null)?.getTime() === (where.lastEmailedAt ?? null)?.getTime();
        if (same) state.set(where.id, data.lastEmailedAt);
        return { count: same ? 1 : 0 };
      },
    },
    emailEngagementLog: {
      findMany: async () => [],
      createMany: async ({ data }: { data: Array<{ userId: string; productId: string; event: string }> }) => { logs.push(...data); },
    },
  };
  const sent: string[] = [];
  const base = { db, products: [product("gift", 4.5, ["Holiday Gift Bundles"])], origin: "https://shop.example", from: "from@example.com", secret,
    send: async (mail: { to: unknown }) => { if (mail.to === "bad@example.com") throw new Error("boom"); sent.push(String(mail.to)); } };
  const now = new Date("2026-11-20T11:00:00Z");
  const summary = await runAlertJob({ ...base, now });
  assert.deepEqual(summary, { due: 3, sent: 1, noMatch: 1, failed: 1 });
  assert.deepEqual(sent, ["ok@example.com"]);
  assert.deepEqual(logs, [{ userId: "ok", productId: "gift", category: "Holiday Gift Boxes", event: "sent" }]);
  assert.equal(state.get("ok")?.getTime(), now.getTime());
  assert.equal(state.get("bad"), null);
  assert.deepEqual(await runAlertJob({ ...base, now: new Date("2026-11-21T11:00:00Z") }), { skipped: "not-a-workday", due: 0, sent: 0, noMatch: 0, failed: 0 });
});
