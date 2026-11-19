import { redirect } from "next/navigation";
import { currentUser } from "../../lib/auth";
import { quotaDay } from "../../lib/quota";
import { db } from "../../lib/db";
import { buyCredits } from "../actions";
import OverageModal from "../../components/OverageModal";

export function generateMetadata() {
  return { title: "Sticker credits | Sticker Vault", description: "Add credits for additional sticker activity.", robots: { index: false, follow: false } };
}
export default async function Overage() {
  const user = await currentUser();
  if (!user) redirect("/login");
  const usage = await db.stickerDailyUsage.findUnique({ where: { userId_day: { userId: user.id, day: quotaDay() } } });
  return <OverageModal><h1 id="overage-title" className="text-4xl font-bold">Sticker overage credits</h1><p className="mt-4">Your first 20 sends, claims, or generated stickers per UTC day are free; the allowance resets at 00:00 UTC. Additional stickers cost $0.02 each.</p>
    <p className="mt-4">Today: {usage?.count || 0} actions · Remaining credits: {user.stickerCredits}.</p>
    <p className="mt-4">Stripe&apos;s $0.50 minimum requires at least 25 prepaid credits. Unused credits remain available for future days.</p>
    <form action={buyCredits} className="mt-6"><label>Credits (25–5000) <input name="units" type="number" min="25" max="5000" step="1" defaultValue="25" required /></label><button className="ml-3">Continue to Stripe Checkout</button></form>
    <p className="mt-4 text-sm">After payment confirmation, retry your original action. If claiming a gift, reopen its private email link.</p>
  </OverageModal>;
}
