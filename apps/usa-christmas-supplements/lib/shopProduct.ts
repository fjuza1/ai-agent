import type { ShopProduct } from "../components/commerce/shopStore.ts";

// Snapshot of the fields the cart and compare drawers need, so they work without the catalog on the client.
export function shopProduct(product: any, links: { amazon?: { href: string } | null; alza?: { href: string } | null }): ShopProduct {
  return {
    id: product.id,
    name: product.name,
    price_cents: product.price_cents,
    usa: true,
    fda: Boolean(product.fda_cleared_otc),
    spec: product.fda_device_name || (Array.isArray(product.goals) ? product.goals.slice(0, 3).join(", ") : ""),
    direct: !product.affiliate_url && product.delivery?.in_stock !== false,
    discreetOk: Boolean(product.discreet_gift_box_available),
    amazon: links.amazon?.href,
    alza: links.alza?.href,
  };
}
