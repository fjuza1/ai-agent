"use client";

import { MAX_COMPARE, openPanel, toggleCart, toggleCompare, useShop, type ShopProduct } from "./shopStore.ts";

export default function ProductActions({ product }: { product: ShopProduct }) {
  const { cart, compare } = useShop();
  const inCart = Boolean(cart[product.id]);
  const comparing = Boolean(compare[product.id]);
  const full = !comparing && Object.keys(compare).length >= MAX_COMPARE;
  return <div className="store-links mt-4">
    {product.direct && <button type="button" onClick={() => { if (!inCart) toggleCart(product); openPanel("cart"); }}>
      {inCart ? "In cart · view" : "Quick Buy"}<span className="sr-only"> {product.name}</span>
    </button>}
    <button type="button" className="button-outline" aria-pressed={comparing} disabled={full} title={full ? `Compare up to ${MAX_COMPARE} products` : undefined} onClick={() => toggleCompare(product)}>
      {comparing ? "✓ Comparing" : "Compare"}<span className="sr-only"> {product.name}</span>
    </button>
  </div>;
}
