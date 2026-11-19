import { currentUser } from "../../../lib/auth";
import { claimGift } from "../../actions";

export function generateMetadata() {
  return { title: "Share a gift | Sticker Vault", description: "Share a private sticker gift link.", robots: { index: false, follow: false } };
}
export default async function Gift({ params, searchParams }) {
  const { token } = await params;
  const { delivery } = await searchParams;
  const user = await currentUser();
  return <><h1 className="text-4xl font-bold">A sticker gift</h1>{delivery === "sent" && <p className="mt-4">The email provider accepted the gift email.</p>}{delivery === "failed" && <p role="alert" className="mt-4">Email delivery failed. Share the private link below manually.</p>}{delivery === "suppressed" && <p className="mt-4">That recipient has opted out of gift emails. Share the private link below manually.</p>}<p className="mt-4 break-all">Share this private link: <a href={`/claim/${token}`}>{`/claim/${token}`}</a></p><p className="mt-3">The claim link expires after seven days. Anyone with it can claim the gift, so share it securely.</p>{user ? <form action={claimGift} className="mt-6"><input type="hidden" name="token" value={token}/><button>Claim gift</button></form> : <p className="mt-6">Sign in, then return to this link to claim it. <a href="/login">Sign in</a></p>}</>;
}
