import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { isValidThemeDocument } from "./themeValidator.ts";

const themePath = new URL("../data/daily_visual_theme.json", import.meta.url);
const document = JSON.parse(await readFile(themePath, "utf8"));

test("daily theme validates all five presets and the active contract", () => {
  assert.equal(isValidThemeDocument(document), true);
});

test("daily theme rejects unsafe CSS and unreadable text", () => {
  const unsafeRadius = structuredClone(document);
  unsafeRadius.active.radius_card = "999px";
  assert.equal(isValidThemeDocument(unsafeRadius), false);

  const unreadable = structuredClone(document);
  unreadable.active.text_primary = "#FFFFFF";
  assert.equal(isValidThemeDocument(unreadable), false);

  const invalidTrend = structuredClone(document);
  invalidTrend.trend.observations = [{
    shop: "Shop",
    domain: "shop.example",
    aesthetic: "cozy",
    rank: 0,
    visits: 100,
  }];
  assert.equal(isValidThemeDocument(invalidTrend), false);
});
