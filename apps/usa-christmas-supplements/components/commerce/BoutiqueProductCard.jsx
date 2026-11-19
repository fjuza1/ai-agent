import { deliveryEstimate } from "../../lib/delivery";
import { primaryCategory } from "../../lib/categories";
import { safeStoreLinks, usedForTags } from "../../lib/discovery";
import { shopProduct } from "../../lib/shopProduct";
import MadeInUsaBadge from "../trust/MadeInUsaBadge";
import ProductActions from "./ProductActions";
import FavoritePills from "../engagement/FavoritePills";
import FdaClearedOtcBadge from "../trust/FdaClearedOtcBadge";
import StoreButtons from "./StoreButtons";

export default function BoutiqueProductCard({ product, now }) {
  const arrival = deliveryEstimate(product, now);
  const usedFor = usedForTags(product);
  return <article className="bg-white rounded-2xl p-6 md:p-7 relative boutique-card">
    <div className="fav-corner"><FavoritePills mode="product" productId={product.id} category={primaryCategory(product)} productName={product.name} /></div>
    <p className="pr-24"><MadeInUsaBadge /></p>
    <h3 className="text-xl font-bold mt-2"><a href={`/product/${product.id}`}>{product.name}</a></h3>
    {usedFor.length > 0 && <ul className="flex flex-wrap gap-2 mt-2" aria-label="Used for">{usedFor.map((tag) => <li key={tag}><a className="chip chip-link" href={`/?used_for=${encodeURIComponent(tag)}#shop`}>{tag}</a></li>)}</ul>}
    <p className="mt-2">{product.description}</p>
    <FdaClearedOtcBadge product={product} />
    <p className="text-xl font-bold mt-4">${(product.price_cents / 100).toFixed(2)}</p>
    <p className="text-sm mt-2">{arrival ? `Estimated arrival: ${arrival}. Not a guarantee.` : "Arrival estimate unavailable; check the seller's shipping terms."}</p>
    {arrival && product.delivery?.shipping_source && <a className="text-sm" href={product.delivery.shipping_source} rel="noreferrer">Shipping terms</a>}
    {product.affiliate_url && <p className="text-xs font-bold mt-2">Affiliate link · we may earn a commission</p>}
    <ProductActions product={shopProduct(product, safeStoreLinks(product))} />
    <StoreButtons product={product} />
  </article>;
}
