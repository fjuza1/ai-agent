import { timingSafeEqual } from "node:crypto";
import sgMail from "@sendgrid/mail";
import { runAlertJob, type AlertDb } from "../../../../lib/alertJob";
import { catalog } from "../../../../lib/catalog";
import { db } from "../../../../lib/db";
import { siteOrigin } from "../../../../../../packages/seo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

function authorized(request: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const expected = Buffer.from(`Bearer ${secret}`);
  const given = Buffer.from(request.headers.get("authorization") ?? "");
  return given.length === expected.length && timingSafeEqual(given, expected);
}

async function handle(request: Request) {
  if (!process.env.CRON_SECRET) return Response.json({ error: "CRON_SECRET is not configured." }, { status: 503 });
  if (!authorized(request)) return Response.json({ error: "Unauthorized." }, { status: 401 });
  const { SENDGRID_API_KEY: apiKey, SENDGRID_FROM_EMAIL: from, SENDGRID_IP_POOL: ipPoolName } = process.env;
  if (!apiKey || !from || !process.env.AUTH_SECRET) {
    console.error("Product alerts: SendGrid or AUTH_SECRET configuration is incomplete.");
    return Response.json({ error: "Alert service is not configured." }, { status: 503 });
  }
  sgMail.setApiKey(apiKey);
  const summary = await runAlertJob({
    db: db as unknown as AlertDb,
    products: await catalog(),
    now: new Date(),
    origin: siteOrigin(process.env.SUPPLEMENT_APP_URL, "http://localhost:3001"),
    from, ipPoolName,
    send: (mail) => sgMail.send(mail),
  });
  return Response.json(summary, { status: summary.failed && !summary.sent ? 502 : 200, headers: { "Cache-Control": "no-store" } });
}

export const GET = handle;
export const POST = handle;
