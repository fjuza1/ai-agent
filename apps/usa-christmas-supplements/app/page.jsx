import { catalog, dailyFeatured } from "../lib/catalog";
import { AdSenseBanner } from "../../../packages/ads/AdSense";
import { pageMetadata, siteOrigin, structuredData } from "../../../packages/seo";
import { rotateProducts } from "../lib/hourlyProductRotator";
import { verifiedCutoff } from "../lib/delivery";
import ProductCard from "../components/ProductCard";
import DeliveryCountdown from "../components/DeliveryCountdown";
import HourlyRefresh from "../components/HourlyRefresh";
import SmartDiscoveryBar from "../components/SmartDiscoveryBar";
import { topPicks, trendingSearches } from "../lib/dailyFeatured";
import { discoveryItem, topUsedFor } from "../lib/discovery";

export function generateMetadata() {
  return pageMetadata(siteOrigin(process.env.SUPPLEMENT_APP_URL, "http://localhost:3001"), "/", "USA Wellness Gifts | Winterwell", "Explore reviewed USA-made wellness gifts and seasonal bundles.");
}
export default async function Home({ searchParams }) {
  const query = await searchParams;
  const param = (value) => typeof value === "string" ? value.trim().slice(0, 80) : "";
  const [allProducts, featured] = await Promise.all([catalog(), dailyFeatured()]);
  const now = new Date();
  const items = allProducts.map((p) => ({ ...discoveryItem(p), card: <ProductCard product={p} now={now} /> }));
  const picks = topPicks(allProducts, featured, now);
  const spotlight = rotateProducts(allProducts, now);
  const cutoff = verifiedCutoff(allProducts, now);
  const faq = { "@context": "https://schema.org", "@type": "FAQPage", mainEntity: [{
    "@type": "Question", name: "How are products selected?",
    acceptedAnswer: { "@type": "Answer", text: "Products must be reviewed and have documented USA manufacturing evidence before inclusion." }
  }] };
  return <>
    <HourlyRefresh />
    <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: structuredData(faq) }} />
    {cutoff && <DeliveryCountdown cutoff={cutoff} />}
    <section className="bg-emerald-100 rounded-3xl p-8 md:p-16"><p className="uppercase tracking-widest text-sm">Thoughtfully sourced · made in the USA</p><h1 className="text-5xl font-bold mt-4 max-w-2xl">A little more well, all winter long.</h1><p className="mt-4 max-w-xl">Seasonal wellness gifts, selected with care. Every listed product must pass our USA-manufacturing and human-review gate.</p><a className="button mt-6" href="#shop">Explore the collection</a></section>
    <section className="mt-12" aria-label="Top Picks of the Day"><h2 className="text-3xl font-bold">Top Picks of the Day</h2><p className="mt-2">A fresh mix of reviewed supplements, holiday bundles and family-planning kits, rotated every 24 hours (UTC).</p>{picks.length ? <div className="grid md:grid-cols-3 gap-5 mt-6">{picks.map((p) => <ProductCard key={p.id} product={p} now={now} />)}</div> : <p className="mt-4">No approved products are available yet.</p>}</section>
    <section className="mt-12" aria-label="Hourly 10 Spotlight"><h2 className="text-3xl font-bold">Hourly 10 Spotlight</h2><p className="mt-2">A UTC-hourly selection of up to ten reviewed products. Affiliate links may earn us a commission.</p>{spotlight.length ? <div className="grid md:grid-cols-3 gap-5 mt-6">{spotlight.map((p) => <ProductCard key={p.id} product={p} now={now} />)}</div> : <p className="mt-4">No approved products are available yet.</p>}</section>
    <AdSenseBanner /><SmartDiscoveryBar items={items} usedFor={topUsedFor(allProducts)} trending={trendingSearches(allProducts, featured)} initialQuery={param(query.q)} initialTag={param(query.used_for) || param(query.filter)} />
    <p className="mt-8"><a href="/category/family-planning-bundles">Am I Pregnant? &amp; Family Planning Gift Packages</a></p>
    <section className="mt-12"><h2 className="text-2xl font-bold">Frequently asked questions</h2><h3 className="font-bold mt-4">How are products selected?</h3><p>Products must be reviewed and have documented USA manufacturing evidence before inclusion.</p></section>
  </>;
}
