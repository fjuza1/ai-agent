import { suppressEmail, verifyUnsubscribe } from "../../lib/giftEmail";

export const dynamic = "force-dynamic";

async function unsubscribe(request) {
  const params = new URL(request.url).searchParams;
  const email = verifyUnsubscribe(params.get("e"), params.get("t"));
  if (!email) return new Response("Invalid unsubscribe link.", { status: 400 });
  await suppressEmail(email);
  return new Response("You will no longer receive sticker gift emails from us.", { headers: { "Content-Type": "text/plain; charset=utf-8", "X-Robots-Tag": "noindex" } });
}

export const GET = unsubscribe;
// RFC 8058 one-click unsubscribe from mail clients.
export const POST = unsubscribe;
