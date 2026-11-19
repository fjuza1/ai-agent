import { stickers } from "../../lib/stickers";
import { pageMetadata, siteOrigin } from "../../../../packages/seo";

export function generateMetadata() {
  return pageMetadata(siteOrigin(process.env.STICKER_APP_URL, "http://localhost:3000"), "/stickers", "Sticker Collection | Sticker Vault", "Browse 50 original digital stickers across five colorful themes.");
}
export default function Collection() {
  return <><h1 className="text-4xl font-bold">Explore 50 original stickers</h1><div className="grid grid-cols-2 md:grid-cols-5 gap-4 mt-8">{stickers.map((s) => <article key={s.id} className="bg-white rounded-xl p-4"><a href={`/stickers/${s.id}`}><img src={s.image} alt={s.alt} width={s.width} height={s.height} loading="lazy"/><h2 className="font-bold">{s.name}</h2></a><p className="text-sm">{s.theme}</p></article>)}</div></>;
}
