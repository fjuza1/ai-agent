import { deliveryEstimate } from "../lib/delivery";
import { primaryCategory } from "../lib/categories";
import { usedForTags } from "../lib/discovery";
import FavoritePills from "./FavoritePills";
import FdaBadge from "./FdaBadge";
import StoreButtons from "./StoreButtons";

export default function ProductCard({ product, now }) {
  const arrival = deliveryEstimate(product, now);
  const usedFor = usedForTags(product);
  return <article className="bg-white rounded-xl p-6 relative">
    <div className="fav-corner"><FavoritePills mode="product" productId={product.id} category={primaryCategory(product)} productName={product.name} /></div>
    <p className="text-xs uppercase tracking-widest pr-24">Verified USA manufacturing</p>
    <h3 className="text-xl font-bold mt-2"><a href={`/product/${product.id}`}>{product.name}</a></h3>
    {usedFor.length > 0 && <ul className="flex flex-wrap gap-2 mt-2" aria-label="Used for">{usedFor.map((tag) => <li key={tag}><a className="chip chip-link" href={`/?used_for=${encodeURIComponent(tag)}#shop`}>{tag}</a></li>)}</ul>}
    <p className="mt-2">{product.description}</p>
    <FdaBadge product={product} />
    <p className="text-xl font-bold mt-4">${(product.price_cents / 100).toFixed(2)}</p>
    <p className="text-sm mt-2">{arrival ? `Estimated arrival: ${arrival}. Not a guarantee.` : "Arrival estimate unavailable; check the seller's shipping terms."}</p>
    {arrival && product.delivery?.shipping_source && <a className="text-sm" href={product.delivery.shipping_source} rel="noreferrer">Shipping terms</a>}
    {product.affiliate_url && <p className="text-xs font-bold mt-2">Affiliate link · we may earn a commission</p>}
    <StoreButtons product={product} />
  </article>;
}
