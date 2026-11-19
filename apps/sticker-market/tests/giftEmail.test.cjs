const { test } = require("node:test");
const assert = require("node:assert/strict");

test("gift email sends a private claim link and surfaces provider failures", async () => {
  const { sendGiftEmail, verifyUnsubscribe } = await import("../lib/giftEmail.js");
  const originalFetch = global.fetch;
  const originalEnv = { ...process.env };
  try {
    process.env.RESEND_API_KEY = "local-test-key";
    process.env.GIFT_EMAIL_FROM = "Gifts <gift@example.invalid>";
    process.env.STICKER_APP_URL = "http://localhost:3000";
    process.env.GIFT_UNSUBSCRIBE_SECRET = "unit-test-secret-0123456789";
    let captured;
    global.fetch = async (url, options) => { captured = { url, options }; return { ok: true }; };
    const token = "a".repeat(64);
    const suppressed = async () => false;
    assert.equal(await sendGiftEmail("recipient@example.invalid", token, { suppressed }), "sent");
    assert.equal(captured.url, "https://api.resend.com/emails");
    const body = JSON.parse(captured.options.body);
    assert.deepEqual(body.to, ["recipient@example.invalid"]);
    assert.match(body.html, new RegExp(`/claim/${token}`));
    const optOut = body.headers["List-Unsubscribe"].slice(1, -1);
    assert.equal(body.headers["List-Unsubscribe-Post"], "List-Unsubscribe=One-Click");
    assert.match(body.html, /Stop receiving gift emails/);
    const link = new URL(optOut);
    assert.equal(verifyUnsubscribe(link.searchParams.get("e"), link.searchParams.get("t")), "recipient@example.invalid");
    assert.equal(verifyUnsubscribe(link.searchParams.get("e"), "0".repeat(64)), null);
    assert.equal(verifyUnsubscribe(Buffer.from("other@example.invalid").toString("base64url"), link.searchParams.get("t")), null);
    captured = undefined;
    assert.equal(await sendGiftEmail("recipient@example.invalid", token, { suppressed: async () => true }), "suppressed");
    assert.equal(captured, undefined);
    global.fetch = async () => ({ ok: false, status: 503 });
    await assert.rejects(sendGiftEmail("recipient@example.invalid", token, { suppressed }), /503/);
  } finally {
    global.fetch = originalFetch;
    process.env = originalEnv;
  }
});
