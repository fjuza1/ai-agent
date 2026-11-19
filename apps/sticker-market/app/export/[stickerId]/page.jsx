import { notFound, redirect } from "next/navigation";
import { currentUser } from "../../../lib/auth";
import { db } from "../../../lib/db";
import { stickerById, stickers } from "../../../lib/stickers";
import ShareSticker from "../../../components/ShareSticker";

export function generateMetadata() {
  return { title: "Save your sticker | Sticker Vault", description: "Save or share your sticker PNG.", robots: { index: false, follow: false } };
}
export default async function Export({ params }) {
  const user = await currentUser();
  if (!user) redirect("/login");
  const { stickerId } = await params;
  const sticker = await db.sticker.findFirst({ where: { id: stickerId, ownerId: user.id } });
  if (!sticker) notFound();
  const art = stickerById(sticker.imageId, sticker.name) || stickers[0];
  return <article><h1 className="text-4xl font-bold">Save PNG to Phone / Share to Mobile</h1><p className="mt-4">Your vault now owns {sticker.name}. Serial: {sticker.serial}</p>
    <img className="w-full max-w-sm mt-6" src={art.image} alt={art.alt} width={art.width} height={art.height} />
    {!sticker.imageId && <p className="text-sm">This older sticker uses fallback artwork.</p>}
    <ShareSticker image={art.image} name={sticker.name} /><p className="mt-6"><a href="/vault">Return to vault</a></p>
  </article>;
}
