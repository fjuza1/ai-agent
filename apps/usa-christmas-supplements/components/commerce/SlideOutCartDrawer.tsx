"use client";

import Drawer from "../ui/Drawer.tsx";
import { FREE_SHIPPING_CENTS, openPanel, setDiscreet, setSticker, toggleCart, useShop } from "./shopStore.ts";

const money = (cents: number) => `$${(cents / 100).toFixed(2)}`;

export default function SlideOutCartDrawer({ checkoutAction }: { checkoutAction: (form: FormData) => Promise<void> }) {
  const { cart, discreet, sticker, panel } = useShop();
  const items = Object.values(cart);
  const total = items.reduce((sum, item) => sum + item.price_cents, 0);
  const remaining = Math.max(0, FREE_SHIPPING_CENTS - total);
  const discreetBlocked = items.some((item) => !item.discreetOk);
  return <Drawer id="cart-drawer" title="🛒 Your Cart" open={panel === "cart"} onClose={() => openPanel(null)}>
    {!items.length ? <p className="mt-4">Your cart is empty. Tap “Quick Buy” on any direct-checkout product.</p> : <form action={checkoutAction} className="mt-4">
      <p className="text-sm">{remaining ? `${money(remaining)} away from Free Priority Pre-Christmas Shipping` : "🎉 You’ve unlocked Free Priority Pre-Christmas Shipping"}</p>
      <progress className="cart-progress" max={FREE_SHIPPING_CENTS} value={Math.min(total, FREE_SHIPPING_CENTS)} aria-label="Progress toward free shipping" />
      <ul className="fav-drawer-list">
        {items.map((item) => <li key={item.id}>
          <span>{item.name}<br /><strong>{money(item.price_cents)}</strong></span>
          <input type="hidden" name="productId" value={item.id} />
          <button type="button" className="favorite-button" aria-label={`Remove ${item.name}`} onClick={() => toggleCart(item)}>Remove</button>
        </li>)}
      </ul>
      <label className="block mt-4"><input type="checkbox" name="discreetGiftBox" value="yes" checked={discreet && !discreetBlocked} disabled={discreetBlocked} onChange={(event) => setDiscreet(event.target.checked)} /> Discreet Unbranded Packaging</label>
      {discreetBlocked && <p className="text-xs">Not available for every item in your cart.</p>}
      <label className="block mt-2"><input type="checkbox" name="stickerGift" value="yes" checked={sticker} onChange={(event) => setSticker(event.target.checked)} /> Attach a free Baby/Holiday Collectible Sticker</label>
      <p className="text-xl font-bold mt-4">Subtotal {money(total)}</p>
      <button className="mt-3">Checkout with Stripe</button>
    </form>}
  </Drawer>;
}
