import { notFound } from "next/navigation";
import { currentUser, digest } from "../../../lib/auth";
import { db } from "../../../lib/db";
import { claimGift } from "../../actions";

export function generateMetadata() {
  return { title: "Accept a sticker gift | Sticker Vault", description: "Securely accept your sticker gift.", robots: { index: false, follow: false } };
}
export default async function Claim({ params }) {
  const { giftToken } = await params;
  if (!/^[a-f0-9]{64}$/.test(giftToken)) notFound();
  const gift = await db.gift.findUnique({ where: { id: digest(giftToken) }, include: { sticker: true } });
  if (!gift || gift.expiresAt <= new Date()) notFound();
  const user = await currentUser();
  return <section><h1 className="text-4xl font-bold">Accept your sticker gift</h1><p className="mt-4">You have been offered {gift.sticker.name}.</p>
    {!user ? <p className="mt-4"><a href="/login">Sign in</a>, then return to your private email link.</p> :
      user.id === gift.ownerId ? <p className="mt-4">You are the sender. Share this private link with your recipient.</p> :
      <form action={claimGift} className="mt-6"><input type="hidden" name="token" value={giftToken}/><button>Accept Gift</button></form>}
    <p className="text-sm mt-4">The gift is transferred only after you confirm. This protects against automatic email link scanners.</p>
  </section>;
}
