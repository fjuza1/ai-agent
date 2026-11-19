import { test } from "node:test";
import assert from "node:assert/strict";
import { createRateLimiter, clientKey } from "./rateLimit.ts";

test("blocks after the limit and locks out with exponential back-off", () => {
  let t = 0;
  const limiter = createRateLimiter({ limit: 2, windowMs: 1000, now: () => t });
  assert.equal(limiter.check("a").ok, true);
  assert.equal(limiter.check("a").ok, true);
  assert.deepEqual(limiter.check("a"), { ok: false, retryAfterSeconds: 1 });
  assert.equal(limiter.check("b").ok, true);
  t = 500;
  assert.equal(limiter.check("a").ok, false);
  t = 1500;
  assert.equal(limiter.check("a").ok, true);
  assert.equal(limiter.check("a").ok, true);
  assert.deepEqual(limiter.check("a"), { ok: false, retryAfterSeconds: 2 });
});

test("reset clears a key and the key table stays bounded", () => {
  const limiter = createRateLimiter({ limit: 1, windowMs: 1000, maxKeys: 3, now: () => 0 });
  limiter.check("a");
  assert.equal(limiter.check("a").ok, false);
  limiter.reset("a");
  assert.equal(limiter.check("a").ok, true);
  for (const key of ["b", "c", "d", "e"]) limiter.check(key);
  assert.equal(limiter.check("a").ok, true);
});

test("clientKey uses the first forwarded address", () => {
  assert.equal(clientKey(new Headers({ "x-forwarded-for": "1.2.3.4, 5.6.7.8" })), "1.2.3.4");
  assert.equal(clientKey(new Headers()), "unknown");
});
