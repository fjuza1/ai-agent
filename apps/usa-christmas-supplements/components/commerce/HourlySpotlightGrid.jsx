import BoutiqueProductCard from "./BoutiqueProductCard";

export default function HourlySpotlightGrid({ products, now }) {
  return <section className="mt-12" aria-label="Hourly 10 Spotlight">
    <h2 className="text-3xl font-bold">Hourly 10 Spotlight</h2>
    <p className="mt-2">A UTC-hourly selection of up to ten reviewed products. Affiliate links may earn us a commission.</p>
    {products.length ? <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-6 mt-6">{products.map((p) => <BoutiqueProductCard key={p.id} product={p} now={now} />)}</div> : <p className="mt-4">No approved products are available yet.</p>}
  </section>;
}
