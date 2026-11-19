import { strict as assert } from "node:assert";
import { test } from "node:test";
import { signClick, verifyClick } from "./signing.ts";

const secret = "test-secret-with-enough-length";

test("click signatures bind the user and product and reject tampering", () => {
  const sig = signClick("user-1", "prod-1", secret);
  assert.equal(verifyClick("user-1", "prod-1", sig, secret), true);
  assert.equal(verifyClick("user-2", "prod-1", sig, secret), false);
  assert.equal(verifyClick("user-1", "prod-2", sig, secret), false);
  assert.equal(verifyClick("user-1", "prod-1", sig, "another-secret-with-enough-length"), false);
  assert.equal(verifyClick("user-1", "prod-1", "short", secret), false);
});

test("signing refuses to run without a real secret", () => {
  assert.throws(() => signClick("u", "p", "short"), /AUTH_SECRET/);
});
