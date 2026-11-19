import { redirect } from "next/navigation";
import { currentUser } from "../../lib/auth";
import { db } from "../../lib/db";
import { cancelGift, cancelListing, createGift, listSticker, onboardSeller } from "../actions";
import { stickerById, stickers as catalog } from "../../lib/stickers";

export function generateMetadata() {
  return { title: "My vault | Sticker Vault", description: "Manage your private sticker collection.", robots: { index: false, follow: false } };
}

export default async function Vault() {
  const user = await currentUser();
  if (!user) redirect("/login");
  const stickers = await db.sticker.findMany({ where: { ownerId: user.id }, include: { listing: true, gift: true }, orderBy: { createdAt: "desc" } });
  return <><div className="flex flex-wrap justify-between gap-4"><div><p className="uppercase tracking-widest text-sm">Your collection</p><h1 className="text-4xl font-bold">Sticker vault</h1></div><form action={onboardSeller}><button>Set up Stripe seller payouts</button></form></div><p className="mt-4">Signed in as {user.email}. Purchases appear after Stripe confirms payment. <a href="/overage">Daily usage and credits</a></p>{!stickers.length && <p className="mt-8">Your vault is empty. Browse the starter pack to begin.</p>}<div className="grid md:grid-cols-2 lg:grid-cols-3 gap-5 mt-8">{stickers.map((s) => { const art = stickerById(s.imageId, s.name) || catalog[0]; return <article key={s.id} className="bg-white p-6 rounded-xl"><img src={art.image} alt={art.alt} width={art.width} height={art.height} loading="lazy" className="w-full max-w-48" /><h2 className="text-xl font-bold mt-3">{s.name}</h2><p className="break-all text-xs mt-1">Serial: {s.serial}</p><p className="mt-2"><a href={`/export/${s.id}`}>Save or share PNG</a></p>{s.listing ? <><p className="mt-4">Listed ${(s.listing.priceCents / 100).toFixed(2)} ({s.listing.state})</p>{s.listing.state === "active" && <form action={cancelListing}><input type="hidden" name="listingId" value={s.listing.id}/><button className="mt-2">Cancel listing</button></form>}</> : s.gift ? <><p className="mt-4">Gift claim link outstanding.</p><form action={cancelGift}><input type="hidden" name="stickerId" value={s.id}/><button className="mt-2">Cancel gift</button></form></> : <><form action={listSticker} className="mt-4 flex gap-2"><input type="hidden" name="stickerId" value={s.id}/><input aria-label="Price in dollars" name="price" type="number" step="0.01" min="0.50" max="99999.99" required/><button>List</button></form><form action={createGift} className="mt-4 grid gap-2"><input type="hidden" name="stickerId" value={s.id}/><label>Recipient email (optional)<input className="block w-full" name="recipient" type="email" placeholder="friend@example.com"/></label><button>Create gift / send email</button></form></>}</article>; })}</div></>;
}
