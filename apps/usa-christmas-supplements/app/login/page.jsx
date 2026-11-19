import { login, sendMagicLink } from "../auth-actions";
import { magicLinkEnabled } from "../../lib/auth";
import { pageMetadata, siteOrigin } from "../../../../packages/seo";

export function generateMetadata() {
  return pageMetadata(siteOrigin(process.env.SUPPLEMENT_APP_URL, "http://localhost:3001"), "/login", "Sign in | Winterwell", "Sign in to save favorite USA-made products.", true);
}

const errors = {
  credentials: "That email and password do not match. Try again or use an email link.",
  email: "We could not send the sign-in email. Check the address and try again.",
  "magic-unavailable": "Email links are not available right now. Sign in with your password.",
  Verification: "That sign-in link is invalid or has expired. Request a new one.",
};

export default async function Login({ searchParams }) {
  const query = await searchParams;
  const callbackUrl = typeof query.callbackUrl === "string" && /^\/(?![/\\])/.test(query.callbackUrl) ? query.callbackUrl : "/account/favorites";
  const error = typeof query.error === "string" ? errors[query.error] ?? "Sign-in failed. Please try again." : null;
  return <div className="max-w-md mx-auto">
    <h1 className="text-3xl font-bold">Sign in</h1>
    {query.sent && <p role="status" className="mt-4">Check your inbox: we sent you a sign-in link that expires in 15 minutes.</p>}
    {error && <p role="alert" className="mt-4 font-bold">{error}</p>}
    <form action={login} className="grid gap-3 mt-6">
      <input type="hidden" name="callbackUrl" value={callbackUrl} />
      <label>Email <input className="block w-full" type="email" name="email" autoComplete="email" required /></label>
      <label>Password <input className="block w-full" type="password" name="password" autoComplete="current-password" maxLength={72} required /></label>
      <button>Sign in</button>
    </form>
    {magicLinkEnabled && <form action={sendMagicLink} className="grid gap-3 mt-8">
      <h2 className="text-xl font-bold">Prefer no password?</h2>
      <input type="hidden" name="callbackUrl" value={callbackUrl} />
      <label>Email <input className="block w-full" type="email" name="email" autoComplete="email" required /></label>
      <button>Email me a magic link</button>
    </form>}
    <p className="mt-8">New here? <a href="/signup">Create an account</a></p>
  </div>;
}
