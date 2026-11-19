import { checkout } from "./actions";
import { AdSenseBanner } from "../../../packages/ads/AdSense";
import { pageMetadata, siteOrigin, structuredData } from "../../../packages/seo";
import { stickers } from "../lib/stickers";

export function generateMetadata() {
  return pageMetadata(siteOrigin(process.env.STICKER_APP_URL, "http://localhost:3000"), "/", "Digital Sticker Packs | Sticker Vault", "Collect, gift and exchange original digital sticker artwork.");
}

export default function Home() {
  const origin = siteOrigin(process.env.STICKER_APP_URL, "http://localhost:3000");
  const schemas = [
    { "@context": "https://schema.org", "@type": "Product", name: "Collectible sticker starter pack", description: "Three digital stickers with unique serials.",
      image: `${origin}${stickers[0].image}`,
      offers: { "@type": "Offer", price: "5.00", priceCurrency: "USD", url: origin } },
    { "@context": "https://schema.org", "@type": "FAQPage", mainEntity: [{
      "@type": "Question", name: "What is in a starter pack?", acceptedAnswer: { "@type": "Answer", text: "A starter pack contains three digital stickers with unique serials." }
    }] }
  ];
  return <><script type="application/ld+json" dangerouslySetInnerHTML={{ __html: structuredData(schemas) }}/><section className="rounded-3xl bg-violet-100 p-8 md:p-16"><p className="uppercase tracking-widest text-sm">Collect · share · trade</p><h1 className="text-5xl font-bold mt-4">Small art. Big personality.</h1><p className="mt-4 max-w-xl">Build a digital collection with individually numbered stickers, give a favorite to a friend, or find something new in the marketplace.</p><form action={checkout} className="mt-6"><button>Buy a starter pack · $5.00</button></form><p className="text-sm mt-2">Three digital stickers. Sign in before checkout.</p></section><AdSenseBanner /><section className="mt-12"><h2 className="text-3xl font-bold">Explore the collection</h2><div className="grid grid-cols-2 md:grid-cols-5 gap-4 mt-4">{stickers.slice(0, 10).map((s) => <article key={s.id} className="bg-white rounded-xl p-4"><a href={`/stickers/${s.id}`}><img src={s.image} alt={s.alt} width={s.width} height={s.height} loading="lazy" /><h3 className="font-bold">{s.name}</h3></a></article>)}</div><p className="mt-4"><a href="/stickers">Browse all 50 stickers</a></p></section><section className="mt-12"><h2 className="text-2xl font-bold">Frequently asked questions</h2><h3 className="font-bold mt-4">What is in a starter pack?</h3><p>A starter pack contains three digital stickers with unique serials.</p></section></>;
}
