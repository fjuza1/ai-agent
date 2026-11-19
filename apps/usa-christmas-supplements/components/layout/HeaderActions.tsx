"use client";

import { MAX_COMPARE, openPanel, useShop } from "../commerce/shopStore.ts";

export default function HeaderActions() {
  const { cart, compare } = useShop();
  return <div className="flex flex-wrap items-center gap-2">
    <button type="button" className="favorite-button" onClick={() => openPanel("compare")}>⚖️ Compare ({Object.keys(compare).length}/{MAX_COMPARE})</button>
    <button type="button" className="favorite-button" onClick={() => openPanel("cart")}>🛒 Cart ({Object.keys(cart).length})</button>
  </div>;
}
