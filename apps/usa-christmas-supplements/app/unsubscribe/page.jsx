import { validUnsubscribeToken } from "../../lib/unsubscribe";
import { pageMetadata, siteOrigin } from "../../../../packages/seo";
import { confirmUnsubscribe } from "./actions";

export function generateMetadata() {
  return pageMetadata(siteOrigin(process.env.SUPPLEMENT_APP_URL, "http://localhost:3001"), "/unsubscribe", "Unsubscribe | Winterwell", "Stop Winterwell product alert emails.", true);
}

export default async function Unsubscribe({ searchParams }) {
  const query = await searchParams;
  const token = typeof query.token === "string" && validUnsubscribeToken(query.token) ? query.token : null;
  return <section className="max-w-md mx-auto">
    <h1 className="text-3xl font-bold">Unsubscribe</h1>
    {query.done ? <p role="status" className="mt-4">You are unsubscribed. We will not send more product alerts and email tracking is off.</p>
      : token ? <form action={confirmUnsubscribe} className="mt-4 grid gap-3">
        <p>Stop all Winterwell product alert emails and email tracking?</p>
        <input type="hidden" name="token" value={token} />
        <button>Unsubscribe me</button>
      </form>
      : <p role="alert" className="mt-4">This unsubscribe link is invalid. You can also turn alerts off in <a href="/account/settings">your settings</a>.</p>}
  </section>;
}
