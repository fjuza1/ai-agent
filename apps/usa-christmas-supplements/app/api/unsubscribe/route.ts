import { unsubscribeByToken, validUnsubscribeToken } from "../../../lib/unsubscribe";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// RFC 8058 one-click: mail clients POST here straight from the List-Unsubscribe header.
export async function POST(request: Request) {
  const done = await unsubscribeByToken(new URL(request.url).searchParams.get("token"));
  return done ? new Response("Unsubscribed", { status: 200 }) : new Response("Invalid unsubscribe link", { status: 400 });
}

// A plain GET never changes state because mail scanners prefetch links; it sends people to the confirmation page.
export async function GET(request: Request) {
  const token = new URL(request.url).searchParams.get("token");
  const target = validUnsubscribeToken(token) ? `/unsubscribe?token=${token}` : "/unsubscribe";
  return new Response(null, { status: 303, headers: { Location: target, "Cache-Control": "no-store" } });
}
