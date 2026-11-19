import { db } from "../../lib/db";
import { checkout } from "../actions";
import { AdSenseBanner } from "../../../../packages/ads/AdSense";
import { pageMetadata, siteOrigin } from "../../../../packages/seo";
import { stickerById, stickers } from "../../lib/stickers";

export function generateMetadata() {
  return pageMetadata(siteOrigin(process.env.STICKER_APP_URL, "http://localhost:3000"), "/marketplace", "Sticker Marketplace | Sticker Vault", "Browse collectible stickers listed by their owners.");
}

export default async function Marketplace() {
  const listings = await db.listing.findMany({ where: { state: "active" }, include: { sticker: true }, orderBy: { createdAt: "desc" } });
  return <><p className="uppercase tracking-widest text-sm">Find your next favorite</p><h1 className="text-4xl font-bold mt-2">Marketplace</h1><p className="mt-4">Prices are set by individual owners. Ownership transfers when the payment webhook is processed.</p><AdSenseBanner />{!listings.length && <p>No stickers are currently listed.</p>}<div className="grid md:grid-cols-3 gap-5">{listings.map((item) => { const art = stickerById(item.sticker.imageId, item.sticker.name) || stickers[0]; return <article key={item.id} className="bg-white rounded-xl p-6"><img src={art.image} alt={art.alt} width={art.width} height={art.height} loading="lazy" className="w-full max-w-48"/><h2 className="font-bold text-xl mt-3">{item.sticker.name}</h2><p className="text-xs break-all">{item.sticker.serial}</p><p className="text-xl font-bold mt-4">${(item.priceCents / 100).toFixed(2)}</p><form action={checkout} className="mt-4"><input type="hidden" name="listingId" value={item.id}/><button>Buy with Stripe</button></form></article>; })}</div></>;
}
