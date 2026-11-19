import sendgrid, { type MailDataRequired } from "@sendgrid/mail";
import { clientKey, type RateLimitResult } from "../rate-limit/rateLimit.ts";

type Product = { id: string; name: string };
type Options = {
  findProduct: (id: string) => Promise<Product | undefined> | Product | undefined;
  origin: () => string;
  path: (id: string) => string;
  send?: (mail: MailDataRequired, apiKey: string) => Promise<unknown>;
  sleep?: (milliseconds: number) => Promise<void>;
  /** Per-client throttle; checked before the body is read or any email is sent. */
  limiter?: { check(key: string): RateLimitResult };
};

const maxBodyBytes = 16_384;
const emailPattern = /^[^\s@<>(),;:"[\]\\]+@[^\s@<>(),;:"[\]\\]+\.[^\s@<>(),;:"[\]\\]+$/;
const escapeHtml = (value: string) => value.replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const response = (status: number, error: string) => Response.json({ error }, { status });
const clean = (value: unknown, max: number): value is string =>
  typeof value === "string" && value.trim().length > 0 && value.length <= max;

async function readBody(request: Request): Promise<unknown> {
  if (!request.body) throw new Error("Missing body");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > maxBodyBytes) {
      await reader.cancel();
      throw new Error("Body too large");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
}

export async function contactProduct(request: Request, options: Options): Promise<Response> {
  const limited = options.limiter?.check(clientKey(request.headers));
  if (limited && !limited.ok) {
    return Response.json({ error: "Too many requests. Please try again later." }, { status: 429, headers: { "Retry-After": String(limited.retryAfterSeconds) } });
  }
  let body: unknown;
  try {
    body = await readBody(request);
  } catch {
    return response(400, "Invalid or oversized request.");
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) return response(400, "Invalid request.");
  const data = body as Record<string, unknown>;
  if (typeof data.website !== "string" || data.website !== "") return response(400, "Unable to submit inquiry.");
  if (!clean(data.name, 100) || /[\r\n\x00-\x1f\x7f]/.test(data.name) ||
      !clean(data.email, 254) || !emailPattern.test(data.email.trim()) ||
      !clean(data.message, 5000) || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(data.message) ||
      !clean(data.productId, 80) || !/^[a-z0-9-]+$/.test(data.productId) ||
      !clean(data.productTitle, 500) || !clean(data.productUrl, 2048)) {
    return response(400, "Please provide valid contact and product details.");
  }

  const { SENDGRID_API_KEY: apiKey, SENDGRID_FROM_EMAIL: from, SENDGRID_SUPPORT_TO_EMAIL: to,
    SENDGRID_IP_POOL: ipPoolName } = process.env;
  if (!apiKey || !from || !to || !ipPoolName) {
    console.error("Product contact: SendGrid configuration is incomplete.");
    return response(503, "Contact service is unavailable. Please try again later.");
  }

  try {
    const product = await options.findProduct(data.productId);
    if (!product) return response(400, "Invalid product details. Please refresh the page.");
    const url = new URL(options.path(product.id), options.origin()).toString();
    if (product.name !== data.productTitle || url !== data.productUrl) {
      return response(400, "Invalid product details. Please refresh the page.");
    }
    const name = data.name.trim();
    const email = data.email.trim();
    const message = data.message.trim();
    const text = `Product: ${product.name}\nProduct ID: ${product.id}\nProduct URL: ${url}\n\nName: ${name}\nEmail: ${email}\n\nMessage:\n${message}`;
    const html = `<p>Product: ${escapeHtml(product.name)}<br>Product ID: ${escapeHtml(product.id)}<br>Product URL: <a href="${escapeHtml(url)}">${escapeHtml(url)}</a></p><p>Name: ${escapeHtml(name)}<br>Email: ${escapeHtml(email)}</p><p>Message:<br>${escapeHtml(message).replace(/\r?\n/g, "<br>")}</p>`;
    const mail: MailDataRequired = {
      from, to, replyTo: email, subject: `Product inquiry: ${product.id}`, text, html,
      ipPoolName, categories: ["product-inquiry", product.id],
      trackingSettings: { clickTracking: { enable: true, enableText: true }, openTracking: { enable: true } },
    };
    const send = options.send ?? (async (payload, key) => {
      sendgrid.setApiKey(key);
      sendgrid.setTimeout(8000);
      return sendgrid.send(payload);
    });
    const sleep = options.sleep ?? ((milliseconds) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
    for (let attempt = 0; ; attempt++) {
      try {
        await send(mail, apiKey);
        break;
      } catch (error) {
        const status = typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
        if (attempt >= 2 || typeof status !== "number" || (status !== 429 && (status < 500 || status > 599))) throw error;
        await sleep(500 * 2 ** attempt + Math.floor(Math.random() * 250));
      }
    }
    return Response.json({ success: true });
  } catch {
    console.error("Product contact: lookup or SendGrid submission failed.");
    return response(502, "Unable to send your inquiry. Please try again later.");
  }
}
