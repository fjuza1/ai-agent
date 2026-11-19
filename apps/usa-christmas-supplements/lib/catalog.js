import "server-only";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { filterUsaProducts } from "./usaFilter";
import { parseFeatured } from "./dailyFeatured";

function catalogPath() {
  return process.env.SUPPLEMENT_CATALOG_PATH
    ? path.resolve(process.env.SUPPLEMENT_CATALOG_PATH)
    : path.resolve(process.cwd(), "../../data/supplements.json");
}

export async function catalog() {
  const data = JSON.parse(await readFile(catalogPath(), "utf8"));
  if (!Array.isArray(data)) throw new Error("Supplement catalog must be an array.");
  const products = filterUsaProducts(data);
  if (new Set(products.map((p) => p.id)).size !== products.length) throw new Error("Duplicate product IDs in catalog.");
  return products;
}

// Written beside the catalog by agents/daily_catalog_linker.py; the storefront falls back to its own rotation without it.
export async function dailyFeatured() {
  try {
    return parseFeatured(JSON.parse(await readFile(path.join(path.dirname(catalogPath()), "daily_featured.json"), "utf8")));
  } catch (error) {
    if (error?.code !== "ENOENT") console.error("Could not read the daily featured selection", error);
    return null;
  }
}
