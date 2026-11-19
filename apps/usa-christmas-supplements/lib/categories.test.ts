import { strict as assert } from "node:assert";
import { test } from "node:test";
import { categoriesFor, categoryPill, FAVORITE_CATEGORIES, parseCategories, primaryCategory } from "./categories.ts";

const product = (extra = {}) => ({
  id: "p", name: "Item", description: "Description", price_cents: 500,
  origin_country: "USA", verified_usa_manufacturing: true, review_status: "approved",
  verification_source: "https://example.com/evidence", categories: [], goals: [], ...extra,
}) as never;

test("products map to favorite categories from catalog slugs and discovery tags", () => {
  assert.deepEqual(categoriesFor(product({ categories: ["family-planning-bundles"] })), ["Family Planning & Pregnancy Tests"]);
  assert.deepEqual(categoriesFor(product({ categories: ["Holiday Gift Bundles"], used_for: ["Immunity Boost"] })), ["Immunity", "Holiday Gift Boxes"]);
  assert.deepEqual(categoriesFor(product({ goals: ["Prenatal Support", "Winter Energy"] })), ["Winter Energy", "Prenatal Support"]);
  assert.equal(primaryCategory(product()), "Other");
});

test("saved category lists drop unknown values and duplicates", () => {
  assert.deepEqual(parseCategories(["Immunity", "Immunity", "Nope", 5]), ["Immunity"]);
  assert.deepEqual(parseCategories("Immunity"), []);
});

test("every favorite category has a pill and unknown categories fall back", () => {
  for (const category of FAVORITE_CATEGORIES) assert.ok(categoryPill(category).emoji && categoryPill(category).label);
  assert.deepEqual(categoryPill("Other"), { emoji: "✨", label: "Other" });
});
