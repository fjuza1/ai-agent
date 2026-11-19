import { catalog } from "../../../lib/catalog";
import { verifiedCutoff } from "../../../lib/delivery";
import ProductCard from "../../../components/ProductCard";
import DeliveryCountdown from "../../../components/DeliveryCountdown";
import { pageMetadata, siteOrigin } from "../../../../../packages/seo";

export function generateMetadata() {
  return pageMetadata(siteOrigin(process.env.SUPPLEMENT_APP_URL, "http://localhost:3001"), "/category/family-planning-bundles", "Family Planning Gifts | Winterwell", "Explore reviewed USA-made family planning gifts and pregnancy test bundles.");
}

export default async function FamilyPlanning() {
  const products = (await catalog()).filter((product) => product.categories.includes("family-planning-bundles"));
  const now = new Date();
  const cutoff = verifiedCutoff(products, now);
  return <article>
    <nav aria-label="Breadcrumb"><a href="/">Home</a> / Family planning</nav>
    {cutoff && <DeliveryCountdown cutoff={cutoff} />}
    <h1 className="text-4xl font-bold mt-8">Am I Pregnant? &amp; Family Planning Gift Packages</h1>
    <p className="mt-4">Explore reviewed USA-made pregnancy test kits and family planning gifts when available. Follow test instructions and consult a healthcare professional with questions.</p>
    {products.length ? <div className="grid md:grid-cols-3 gap-5 mt-8">{products.map((product) => <ProductCard key={product.id} product={product} now={now}/>)}</div> : <p className="mt-8">No reviewed family planning products are available yet.</p>}
  </article>;
}
