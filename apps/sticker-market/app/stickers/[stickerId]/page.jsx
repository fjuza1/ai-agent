import { notFound } from "next/navigation";
import { stickerById } from "../../../lib/stickers";
import ProductContactForm from "../../../components/ProductContactForm";
import { pageMetadata, siteOrigin, structuredData } from "../../../../../packages/seo";

export async function generateMetadata({ params }) {
  const sticker = stickerById((await params).stickerId);
  if (!sticker) return { title: "Sticker not found", robots: { index: false } };
  return pageMetadata(siteOrigin(process.env.STICKER_APP_URL, "http://localhost:3000"), `/stickers/${sticker.id}`, `${sticker.name} Sticker | Sticker Vault`, `Explore ${sticker.name}, an original ${sticker.theme} digital collectible.`);
}
export default async function StickerPage({ params }) {
  const sticker = stickerById((await params).stickerId);
  if (!sticker) notFound();
  const origin = siteOrigin(process.env.STICKER_APP_URL, "http://localhost:3000");
  const url = `${origin}/stickers/${sticker.id}`;
  const schema = [
    { "@context": "https://schema.org", "@type": "Product", name: sticker.name, description: sticker.alt, image: `${origin}${sticker.image}`,
      offers: { "@type": "Offer", price: "5.00", priceCurrency: "USD", availability: "https://schema.org/InStock", url: origin } },
    { "@context": "https://schema.org", "@type": "BreadcrumbList", itemListElement: [
      { "@type": "ListItem", position: 1, name: "Collection", item: `${origin}/stickers` },
      { "@type": "ListItem", position: 2, name: sticker.name, item: url }
    ] },
    { "@context": "https://schema.org", "@type": "FAQPage", mainEntity: [
      { "@type": "Question", name: "How do I collect this design?", acceptedAnswer: { "@type": "Answer", text: "Starter packs contain random digital designs; browse the marketplace for individual listings." } }
    ] },
  ];
  return <article><script type="application/ld+json" dangerouslySetInnerHTML={{ __html: structuredData(schema) }}/><nav aria-label="Breadcrumb"><a href="/stickers">Collection</a> / {sticker.name}</nav><h1 className="text-4xl font-bold mt-8">{sticker.name}</h1><p>{sticker.theme} collection</p><img src={sticker.image} alt={sticker.alt} width={sticker.width} height={sticker.height} className="w-full max-w-md mt-4" /><h2 className="text-2xl font-bold mt-8">Frequently asked questions</h2><h3 className="font-bold mt-4">How do I collect this design?</h3><p>Starter packs contain random digital designs; browse the marketplace for individual listings.</p><a className="button mt-6" href="/marketplace">Browse marketplace</a><ProductContactForm productId={sticker.id} productTitle={sticker.name} productUrl={url} /></article>;
}
