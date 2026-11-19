import { test } from "node:test";
import assert from "node:assert/strict";
import { contactProduct } from "./contact.ts";
import { createRateLimiter } from "../rate-limit/rateLimit.ts";
import Mail from "@sendgrid/helpers/classes/mail.js";

Object.assign(process.env, {
  SENDGRID_API_KEY: "test-key",
  SENDGRID_FROM_EMAIL: "sender@example.com",
  SENDGRID_SUPPORT_TO_EMAIL: "support@example.com",
  SENDGRID_IP_POOL: "test-pool",
});

const valid = {
  name: "Test User", email: "user@example.com", message: "Hello <support>",
  productId: "sticker-01", productTitle: "Example", productUrl: "https://shop.example/stickers/sticker-01", website: "",
};
const request = (body) => new Request("https://shop.example/api/contact-product", {
  method: "POST", body: typeof body === "string" ? body : JSON.stringify(body),
});
const options = (send) => ({
  findProduct: (id) => id === "sticker-01" ? { id, name: "Example" } : undefined,
  origin: () => "https://shop.example",
  path: (id) => `/stickers/${id}`,
  send,
  sleep: async () => {},
});

test("sends verified context and SendGrid settings without HTML injection", async () => {
  let payload;
  const res = await contactProduct(request(valid), options(async (mail) => { payload = mail; }));
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { success: true });
  const json = Mail.create(payload).toJSON();
  assert.equal(json.ip_pool_name, "test-pool");
  assert.deepEqual(json.categories, ["product-inquiry", "sticker-01"]);
  assert.deepEqual(json.tracking_settings, { click_tracking: { enable: true, enable_text: true }, open_tracking: { enable: true } });
  assert.equal(json.reply_to.email, "user@example.com");
  assert.match(payload.text, /https:\/\/shop\.example\/stickers\/sticker-01/);
  assert.match(payload.html, /Hello &lt;support&gt;/);
});

test("throttles repeated submissions per client before sending", async () => {
  let calls = 0;
  const opts = { ...options(async () => { calls++; }), limiter: createRateLimiter({ limit: 1, windowMs: 60_000 }) };
  assert.equal((await contactProduct(request(valid), opts)).status, 200);
  const blocked = await contactProduct(request(valid), opts);
  assert.equal(blocked.status, 429);
  assert.ok(Number(blocked.headers.get("retry-after")) > 0);
  assert.equal(calls, 1);
});

test("rejects malformed, oversized, spam and tampered requests", async () => {
  let calls = 0;
  const opts = options(async () => { calls++; });
  for (const body of [
    "{", JSON.stringify(valid) + " ".repeat(17000),
    { ...valid, website: "spam" }, { ...valid, email: "broken" },
    { ...valid, name: "Test\nBcc: spam" }, { ...valid, message: " " },
    { ...valid, productTitle: "Forged" }, { ...valid, productUrl: "https://evil.example/" },
    { ...valid, productId: "unknown" },
  ]) {
    assert.equal((await contactProduct(request(body), opts)).status, 400);
  }
  assert.equal(calls, 0);
});

test("retries explicit transient responses with bounded exponential backoff", async () => {
  let calls = 0;
  const waits = [];
  const opts = options(async () => {
    calls++;
    if (calls < 3) throw { code: calls === 1 ? 429 : 503 };
  });
  opts.sleep = async (ms) => { waits.push(ms); };
  assert.equal((await contactProduct(request(valid), opts)).status, 200);
  assert.equal(calls, 3);
  assert.ok(waits[0] >= 500 && waits[0] < 750);
  assert.ok(waits[1] >= 1000 && waits[1] < 1250);
});

test("does not retry permanent or ambiguous errors, and reports missing configuration", async () => {
  for (const error of [{ code: 400 }, new Error("network")]) {
    let calls = 0;
    const res = await contactProduct(request(valid), options(async () => { calls++; throw error; }));
    assert.equal(res.status, 502);
    assert.equal(calls, 1);
    assert.ok((await res.json()).error);
  }
  const pool = process.env.SENDGRID_IP_POOL;
  delete process.env.SENDGRID_IP_POOL;
  try {
    assert.equal((await contactProduct(request(valid), options(async () => assert.fail("sent")))).status, 503);
  } finally {
    process.env.SENDGRID_IP_POOL = pool;
  }
});
