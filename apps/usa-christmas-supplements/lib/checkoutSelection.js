export function checkoutSelection(products, form) {
  const ids = form.getAll("productId").map(String);
  if (!ids.length || ids.length > 10 || new Set(ids).size !== ids.length) throw new Error("Select between one and ten distinct products.");
  const selected = ids.map((id) => products.find((p) => p.id === id));
  if (selected.some((p) => !p || p.affiliate_url || p.delivery?.in_stock === false)) throw new Error("A product is unavailable for direct checkout or not verified USA-made.");
  const discreet = form.get("discreetGiftBox") === "yes";
  if (discreet && selected.some((p) => !p.discreet_gift_box_available)) throw new Error("Discreet gift packaging is not available for every selected item.");
  return { ids, selected, discreet };
}
