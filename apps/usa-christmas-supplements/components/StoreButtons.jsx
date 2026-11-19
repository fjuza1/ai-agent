import { safeStoreLinks } from "../lib/discovery";

export default function StoreButtons({ product, direct = true, detailed = false }) {
  const links = safeStoreLinks(product);
  const external = [["Amazon", links.amazon], ["Alza.sk", links.alza]].filter(([, link]) => link);
  if (!direct && !external.length) return null;
  const heading = direct ? "Compare or buy" : "Compare on other stores";
  return <div className="mt-4" role="group" aria-label={`${heading}: ${product.name}`}>
    <p className="text-xs font-bold uppercase tracking-widest">{heading}</p>
    <div className="store-links mt-2">
      {direct && <a className="button" href={links.direct} rel={product.affiliate_url ? "nofollow sponsored" : undefined}>
        {product.affiliate_url ? <>Verified Store <span className="store-flag">Affiliate</span></> : "Direct Checkout"}
        <span className="sr-only"> for {product.name}</span>
      </a>}
      {external.map(([store, link]) => <a key={store} className="button button-outline" href={link.href} target="_blank" rel={`nofollow ${link.affiliate ? "sponsored " : ""}noopener noreferrer`}>
        {store} <span aria-hidden="true">↗</span> <span className="store-flag">{link.affiliate ? "Affiliate" : "External"}</span>
        <span className="sr-only"> search for {product.name}, opens in a new tab</span>
      </a>)}
    </div>
    {external.length > 0 && <p className="text-xs mt-2">
      {detailed ? "Amazon and Alza.sk open search results on those stores in a new tab. Listings there are not reviewed by Winterwell and may not be made in the USA."
        : "↗ External search results are not reviewed by Winterwell."}
      {external.some(([, link]) => link.affiliate) && " We may earn a commission from affiliate links."}
    </p>}
  </div>;
}
