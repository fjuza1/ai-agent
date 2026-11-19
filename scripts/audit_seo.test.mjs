import assert from "node:assert/strict";
import net from "node:net";
import { test } from "node:test";
import { accessibilityResult, assertPortAvailable, auditTargets, seoResult } from "./audit_seo.mjs";

test("SEO gate uses the unrounded score and identifies failed weighted rules", () => {
  const report = (score) => ({
    categories: { seo: { score, auditRefs: [{ id: "description", weight: 1 }, { id: "manual", weight: 0 }] } },
    audits: { description: { title: "Missing description", score: 0, scoreDisplayMode: "binary" }, manual: { score: null } },
  });
  assert.equal(seoResult(report(0.97)).passed, true);
  assert.equal(seoResult(report(0.9699)).passed, false);
  assert.deepEqual(seoResult(report(0.9)).failures, ["description: Missing description"]);
  assert.equal(seoResult({ categories: {} }).passed, false);
});

test("accessibility gate requires an unrounded score of at least 95%", () => {
  const report = (score) => ({
    categories: { accessibility: { score, auditRefs: [{ id: "contrast", weight: 1 }] } },
    audits: { contrast: { title: "Text contrast", score: score === 1 ? 1 : 0, scoreDisplayMode: "binary" } },
  });
  assert.equal(accessibilityResult(report(0.95)).passed, true);
  assert.equal(accessibilityResult(report(0.9499)).passed, false);
  assert.equal(accessibilityResult({ categories: {} }).passed, false);
});

test("audit covers applicable index, category, marketplace and detail pages on isolated ports", () => {
  const urls = auditTargets("sticker-01").map(({ url }) => url);
  assert.equal(urls.length, 6);
  assert.ok(urls.includes("http://127.0.0.1:3001/marketplace"));
  assert.ok(urls.includes("http://127.0.0.1:3002/category/family-planning-bundles"));
  assert.ok(urls.includes("http://127.0.0.1:3002/product/seo-audit-family-kit"));
  assert.ok(urls.includes("http://127.0.0.1:3001/stickers/sticker-01"));
});

test("busy ports fail without stopping their owner", async () => {
  const owner = net.createServer();
  await new Promise((resolve) => owner.listen(0, "127.0.0.1", resolve));
  const port = owner.address().port;
  try {
    await assert.rejects(assertPortAvailable(port), /unavailable.*No existing process was stopped/);
    assert.equal(owner.listening, true);
  } finally {
    await new Promise((resolve) => owner.close(resolve));
  }
  await assertPortAvailable(port);
});
