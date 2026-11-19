const { test } = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { mkdtempSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const net = require("node:net");
const Stripe = require("stripe");

test("signed Stripe events fulfill once, transfer ownership, and release expired reservations", { timeout: 60000 }, async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "sticker-webhook-"));
  const app = path.resolve(__dirname, "..");
  const database = `file:${path.join(dir, "test.db").replaceAll("\\", "/")}`;
  const env = { ...process.env, DATABASE_URL: database, STRIPE_SECRET_KEY: "sk_test_offline", STRIPE_WEBHOOK_SECRET: "whsec_offline", NEXT_TELEMETRY_DISABLED: "1" };
  let server;
  let db;
  try {
    const schema = spawnSync(process.execPath, [require.resolve("prisma/build/index.js"), "db", "push", "--skip-generate"], { cwd: app, env, encoding: "utf8", timeout: 30000 });
    assert.equal(schema.status, 0, schema.stderr || schema.stdout);
    const listener = net.createServer();
    await new Promise((resolve) => listener.listen(0, "127.0.0.1", resolve));
    const port = listener.address().port;
    await new Promise((resolve) => listener.close(resolve));
    server = spawn(process.execPath, [require.resolve("next/dist/bin/next"), "start", "-H", "127.0.0.1", "-p", String(port)], { cwd: app, env, stdio: "ignore" });
    const origin = `http://127.0.0.1:${port}`;
    let ready = false;
    for (let i = 0; i < 80; i++) {
      try { ready = (await fetch(origin)).ok; } catch {}
      if (ready) break;
      if (server.exitCode !== null) throw new Error(`Test server exited with ${server.exitCode}`);
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    assert.ok(ready, "test server did not start");
    const stickerHtml = await (await fetch(`${origin}/stickers/sticker-31`)).text();
    assert.match(stickerHtml, /Contact us/);
    assert.match(stickerHtml, /name="productId" value="sticker-31"/);
    assert.equal((await fetch(`${origin}/api/contact-product`, { method: "POST", body: "{}" })).status, 400);
    const stickerSchema = stickerHtml.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
    assert.ok(stickerSchema, "sticker JSON-LD is present");
    const schemaTypes = JSON.parse(stickerSchema[1]).map((schema) => schema["@type"]);
    assert.ok(["Product", "BreadcrumbList", "FAQPage"].every((type) => schemaTypes.includes(type)));
    const sitemap = await (await fetch(`${origin}/sitemap.xml`)).text();
    assert.ok(sitemap.includes("/stickers/sticker-50"));
    assert.ok(!sitemap.includes("/claim/"));
    const login = await (await fetch(`${origin}/login`)).text();
    assert.match(login, /noindex/);
    const { PrismaClient } = require("@prisma/client");
    db = new PrismaClient({ datasourceUrl: database });
    const buyer = await db.user.create({ data: { email: "buyer@example.invalid", passwordHash: "test" } });
    const seller = await db.user.create({ data: { email: "seller@example.invalid", passwordHash: "test" } });
    const oldArt = await db.sticker.create({ data: { name: "Pixel Bunny", imageId: "sticker-33", serial: randomUUID(), ownerId: seller.id } });
    const newArt = await db.sticker.create({ data: { name: "Baby On Board", imageId: "sticker-41", serial: randomUUID(), ownerId: seller.id } });
    await db.listing.create({ data: { stickerId: oldArt.id, sellerId: seller.id, priceCents: 500 } });
    await db.listing.create({ data: { stickerId: newArt.id, sellerId: seller.id, priceCents: 500 } });
    const marketplace = await (await fetch(`${origin}/marketplace`)).text();
    assert.match(marketplace, /\/stickers\/legacy\/sticker-33\.png/);
    assert.match(marketplace, /\/stickers\/sticker-41\.png/);
    const stripe = new Stripe("sk_test_offline");
    async function send(type, session) {
      const payload = JSON.stringify({ id: `evt_${randomUUID()}`, object: "event", type, data: { object: session } });
      const signature = stripe.webhooks.generateTestHeaderString({ payload, secret: "whsec_offline" });
      return fetch(`${origin}/api/stripe/webhook`, { method: "POST", headers: { "stripe-signature": signature, "content-type": "application/json" }, body: payload });
    }
    const pack = await db.purchase.create({ data: { userId: buyer.id, kind: "pack", stripeSessionId: "cs_test_pack" } });
    const packSession = { id: "cs_test_pack", metadata: { purchaseId: pack.id }, payment_status: "paid", currency: "usd", amount_total: 500 };
    assert.equal((await send("checkout.session.completed", packSession)).status, 200);
    assert.equal((await send("checkout.session.completed", packSession)).status, 200);
    assert.equal(await db.sticker.count({ where: { ownerId: buyer.id } }), 3);

    const item = await db.sticker.create({ data: { name: "Test", serial: randomUUID(), ownerId: seller.id } });
    const listing = await db.listing.create({ data: { stickerId: item.id, sellerId: seller.id, priceCents: 1250, state: "reserved" } });
    const purchase = await db.purchase.create({ data: { userId: buyer.id, kind: "resale", listingId: listing.id, stripeSessionId: "cs_test_resale" } });
    const session = { id: "cs_test_resale", metadata: { purchaseId: purchase.id }, payment_status: "paid", currency: "usd", amount_total: 1250 };
    assert.equal((await send("checkout.session.completed", { ...session, amount_total: 1 })).status, 500);
    assert.equal((await db.sticker.findUnique({ where: { id: item.id } })).ownerId, seller.id);
    assert.equal((await send("checkout.session.completed", session)).status, 200);
    assert.equal((await send("checkout.session.completed", session)).status, 200);
    assert.equal((await db.sticker.findUnique({ where: { id: item.id } })).ownerId, buyer.id);
    assert.equal(await db.listing.findUnique({ where: { id: listing.id } }), null);

    const item2 = await db.sticker.create({ data: { name: "Expired", serial: randomUUID(), ownerId: seller.id } });
    const listing2 = await db.listing.create({ data: { stickerId: item2.id, sellerId: seller.id, priceCents: 500, state: "reserved" } });
    const expired = await db.purchase.create({ data: { userId: buyer.id, kind: "resale", listingId: listing2.id, stripeSessionId: "cs_test_expired" } });
    assert.equal((await send("checkout.session.expired", { id: "cs_test_expired", metadata: { purchaseId: expired.id } })).status, 200);
    assert.equal((await db.listing.findUnique({ where: { id: listing2.id } })).state, "active");
    assert.equal((await fetch(`${origin}/api/stripe/webhook`, { method: "POST", headers: { "stripe-signature": "invalid" }, body: "{}" })).status, 400);

    const { consumeQuota, releaseQuota, QuotaExceeded } = await import("../lib/quota.js");
    const quotaUser = await db.user.create({ data: { email: "quota@example.invalid", passwordHash: "test" } });
    const reservation = await db.$transaction((tx) => consumeQuota(tx, quotaUser.id, 20));
    await assert.rejects(db.$transaction((tx) => consumeQuota(tx, quotaUser.id, 1)), QuotaExceeded);
    assert.equal((await db.stickerDailyUsage.findUnique({ where: { userId_day: { userId: quotaUser.id, day: reservation.day } } })).count, 20);
    const credits = await db.purchase.create({ data: { userId: quotaUser.id, kind: "credits", creditUnits: 25, stripeSessionId: "cs_test_credits" } });
    const creditSession = { id: "cs_test_credits", metadata: { purchaseId: credits.id }, payment_status: "paid", currency: "usd", amount_total: 50 };
    assert.equal((await send("checkout.session.completed", { ...creditSession, amount_total: 2 })).status, 500);
    assert.equal((await send("checkout.session.completed", creditSession)).status, 200);
    assert.equal((await send("checkout.session.completed", creditSession)).status, 200);
    assert.equal((await db.user.findUnique({ where: { id: quotaUser.id } })).stickerCredits, 25);
    await db.$transaction((tx) => consumeQuota(tx, quotaUser.id, 1));
    assert.equal((await db.user.findUnique({ where: { id: quotaUser.id } })).stickerCredits, 24);
    await db.$transaction((tx) => releaseQuota(tx, quotaUser.id, reservation.day, 1));
    assert.equal((await db.user.findUnique({ where: { id: quotaUser.id } })).stickerCredits, 25);
    assert.equal((await db.stickerDailyUsage.findUnique({ where: { userId_day: { userId: quotaUser.id, day: reservation.day } } })).count, 20);
    const packReservation = await db.$transaction((tx) => consumeQuota(tx, quotaUser.id, 3));
    const cancelledPack = await db.purchase.create({ data: { userId: quotaUser.id, kind: "pack", stripeSessionId: "cs_test_expired_pack", quotaDay: packReservation.day, quotaUnits: packReservation.units } });
    assert.equal((await send("checkout.session.expired", { id: "cs_test_expired_pack", metadata: { purchaseId: cancelledPack.id } })).status, 200);
    assert.equal((await db.user.findUnique({ where: { id: quotaUser.id } })).stickerCredits, 25);
    assert.equal((await db.stickerDailyUsage.findUnique({ where: { userId_day: { userId: quotaUser.id, day: reservation.day } } })).count, 20);
  } finally {
    if (db) await db.$disconnect();
    if (server && server.exitCode === null) {
      server.kill();
      await new Promise((resolve) => server.once("exit", resolve));
    }
    rmSync(dir, { recursive: true, force: true });
  }
});
