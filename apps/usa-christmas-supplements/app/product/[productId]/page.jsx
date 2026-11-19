import { notFound } from "next/navigation";
import { catalog } from "../../../lib/catalog";
import { deliveryEstimate } from "../../../lib/delivery";
import { checkout } from "../../actions";
import FdaBadge from "../../../components/FdaBadge";
import FavoritePills from "../../../components/FavoritePills";
import { categoriesFor, primaryCategory } from "../../../lib/categories";
import ProductContactForm from "../../../components/ProductContactForm";
import StoreButtons from "../../../components/StoreButtons";
import { searchKeywords, usedForTags } from "../../../lib/discovery";
import { pageMetadata, siteOrigin, structuredData } from "../../../../../packages/seo";

async function findProduct(params) {
  const { productId } = await params;
  return (await catalog()).find((p) => p.id === productId);
}
function discoveryTerms(product) {
  const usedFor = usedForTags(product);
  return { usedFor, keywords: [...new Set([...usedFor, ...searchKeywords(product)])] };
}
export async function generateMetadata({ params }) {
  const product = await findProduct(params);
  if (!product) return { title: "Product not found", robots: { index: false } };
  const { keywords } = discoveryTerms(product);
  return { ...pageMetadata(siteOrigin(process.env.SUPPLEMENT_APP_URL, "http://localhost:3001"), `/product/${product.id}`, `${product.name.slice(0, 38)} | Winterwell`, product.description.slice(0, 150)),
    ...(keywords.length ? { keywords } : {}) };
}
export default async function ProductPage({ params }) {
  const product = await findProduct(params);
  if (!product) notFound();
  const origin = siteOrigin(process.env.SUPPLEMENT_APP_URL, "http://localhost:3001");
  const url = `${origin}/product/${product.id}`;
  const estimate = deliveryEstimate(product);
  const { usedFor, keywords } = discoveryTerms(product);
  const productCategories = categoriesFor(product);
  const schemas = [
    { "@context": "https://schema.org", "@type": "Product", name: product.name, description: product.description,
      ...(product.image_url ? { image: product.image_url } : {}),
      ...(keywords.length ? { keywords: keywords.join(", ") } : {}),
      ...(usedFor.length ? { additionalProperty: usedFor.map((value) => ({ "@type": "PropertyValue", name: "Used for", value })) } : {}),
      ...(product.aggregate_rating ? { aggregateRating: { "@type": "AggregateRating", ratingValue: product.aggregate_rating.rating_value, reviewCount: product.aggregate_rating.review_count, bestRating: 5, worstRating: 1 } } : {}),
      offers: { "@type": "Offer", price: (product.price_cents / 100).toFixed(2), priceCurrency: "USD", url,
        ...(product.delivery ? { availability: `https://schema.org/${product.delivery.in_stock ? "InStock" : "OutOfStock"}` } : {}) } },
    { "@context": "https://schema.org", "@type": "BreadcrumbList", itemListElement: [
      { "@type": "ListItem", position: 1, name: "Home", item: origin },
      { "@type": "ListItem", position: 2, name: product.name, item: url }
    ] },
    { "@context": "https://schema.org", "@type": "FAQPage", mainEntity: [{
      "@type": "Question", name: "Where can I verify USA manufacturing?",
      acceptedAnswer: { "@type": "Answer", text: "Review the manufacturing evidence linked on this page." }
    }] },
  ];
  return <article>
    <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: structuredData(schemas) }} />
    <nav aria-label="Breadcrumb"><a href="/">Home</a> / {product.name}</nav>
    <p className="text-sm uppercase tracking-widest mt-8">Verified USA manufacturing</p>
    <h1 className="text-4xl font-bold mt-2">{product.name}</h1>
    <div className="mt-3 flex flex-wrap items-center gap-3" aria-label="Favorites">
      <FavoritePills mode="product" variant="prominent" productId={product.id} category={primaryCategory(product)} productName={product.name} />
      {productCategories.length > 0 && <FavoritePills mode="category" categories={productCategories} />}
    </div><p className="mt-4">{product.description}</p>
    <FdaBadge product={product} />
    {usedFor.length > 0 && <p className="mt-4">Used for: {usedFor.map((tag, index) => <span key={tag}>{index > 0 && ", "}<a href={`/?used_for=${encodeURIComponent(tag)}#shop`}>{tag}</a></span>)}</p>}
    <p className="text-2xl font-bold mt-4">${(product.price_cents / 100).toFixed(2)}</p>
    <p className="mt-4">{estimate ? `Estimated arrival: ${estimate}. This is not a guarantee.` : "Arrival estimate unavailable; consult the seller before ordering."}</p>
    {estimate && product.delivery?.shipping_source && <p><a href={product.delivery.shipping_source} rel="noreferrer">Shipping terms</a></p>}
    <p className="mt-4"><a href={product.verification_source} rel="noreferrer">View manufacturing evidence</a></p>
    {product.aggregate_rating && <p className="mt-4">Rated {product.aggregate_rating.rating_value} out of 5 from {product.aggregate_rating.review_count} reviews. <a href={product.aggregate_rating.source_url} rel="noreferrer">Review source</a></p>}
    <h2 className="text-xl font-bold mt-8">Frequently asked questions</h2><h3 className="font-bold mt-3">Where can I verify USA manufacturing?</h3><p>Review the manufacturing evidence linked on this page.</p>
    {product.affiliate_url ? <><p className="mt-4 text-sm">Affiliate disclosure: we may earn a commission from this link.</p><a className="button mt-3" href={`/go/${product.id}`} rel="nofollow sponsored">Visit retailer</a></> :
      product.delivery?.in_stock === false ? <p className="mt-6">Currently out of stock.</p> :
      <form action={checkout} className="mt-6"><input type="hidden" name="productId" value={product.id}/>{product.discreet_gift_box_available && <label className="block mb-4"><input type="checkbox" name="discreetGiftBox" value="yes"/> Discreet Unbranded Gift Box</label>}<button>Buy with Stripe</button></form>}
    <StoreButtons product={product} direct={false} detailed />
    <ProductContactForm productId={product.id} productTitle={product.name} productUrl={url} />
  </article>;
}
