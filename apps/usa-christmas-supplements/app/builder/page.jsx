import { catalog } from "../../lib/catalog";
import { checkout } from "../actions";
import { deliveryEstimate } from "../../lib/delivery";
import { pageMetadata, siteOrigin } from "../../../../packages/seo";

export function generateMetadata() {
  return pageMetadata(siteOrigin(process.env.SUPPLEMENT_APP_URL, "http://localhost:3001"), "/builder", "Build a Wellness Gift | Winterwell", "Build a holiday gift from reviewed USA-made wellness products.");
}

export default async function Builder() {
  const products = await catalog();
  const available = products.filter((p) => !p.affiliate_url && p.delivery?.in_stock !== false);
  return <><p className="uppercase tracking-widest text-sm">Make it personal</p><h1 className="text-4xl font-bold mt-2">Build a holiday gift</h1><p className="mt-4">Choose up to ten different approved USA-made products. Each is purchased at its individual listed price.</p><form action={checkout} className="mt-8"><div className="grid gap-3">{available.map((p) => <label key={p.id} className="bg-white rounded-lg p-4 flex gap-3 items-center"><input type="checkbox" name="productId" value={p.id}/><span>{p.name} · ${(p.price_cents / 100).toFixed(2)} · {deliveryEstimate(p) ? `Estimated arrival: ${deliveryEstimate(p)}` : "Arrival estimate unavailable"}{p.discreet_gift_box_available && " · Discreet gift box available"}</span></label>)}</div>{available.some((p) => p.discreet_gift_box_available) && <label className="block mt-4"><input type="checkbox" name="discreetGiftBox" value="yes"/> Discreet Unbranded Gift Box (all selected items must support it)</label>}{available.length ? <button className="mt-6">Checkout with Stripe</button> : <p>No direct-checkout products are currently available.</p>}</form></>;
}
