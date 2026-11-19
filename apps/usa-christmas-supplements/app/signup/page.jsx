import { signup } from "../auth-actions";
import { magicLinkEnabled } from "../../lib/auth";
import FavoritePills from "../../components/FavoritePills";
import { pageMetadata, siteOrigin } from "../../../../packages/seo";

export function generateMetadata() {
  return pageMetadata(siteOrigin(process.env.SUPPLEMENT_APP_URL, "http://localhost:3001"), "/signup", "Create account | Winterwell", "Create an account to save favorite USA-made products.", true);
}

const errors = {
  email: "Enter a valid email address.",
  password: "Use a password of 10 to 72 characters.",
  exists: "We could not create that account. If you already registered, sign in instead.",
  "magic-unavailable": "Email links are not available right now. Sign up with a password.",
};

export default async function Signup({ searchParams }) {
  const query = await searchParams;
  const error = typeof query.error === "string" ? errors[query.error] ?? "Sign-up failed. Please try again." : null;
  return <div className="max-w-md mx-auto">
    <h1 className="text-3xl font-bold">Create your account</h1>
    {error && <p role="alert" className="mt-4 font-bold">{error}</p>}
    <form action={signup} className="grid gap-3 mt-6">
      <label>Name (optional) <input className="block w-full" name="name" autoComplete="name" maxLength={80} /></label>
      <label>Email <input className="block w-full" type="email" name="email" autoComplete="email" required /></label>
      <label>Password (10+ characters; leave empty to use an email link) <input className="block w-full" type="password" name="password" autoComplete="new-password" minLength={10} maxLength={72} /></label>
      <fieldset className="grid gap-2"><legend className="font-bold">Favorite categories</legend>
        <p className="text-sm">Tap to follow. Picks you tapped before signing up are kept.</p>
        <FavoritePills mode="category" name="favoriteCategories" />
      </fieldset>
      <label><input type="checkbox" name="emailAlertsEnabled" /> Email me up to 3 top-rated picks every 4 hours on workdays (Mon–Fri). Unsubscribe any time.</label>
      <button name="intent" value="password">Create account</button>
      {magicLinkEnabled && <button name="intent" value="magic" formNoValidate>Create account with an email link instead</button>}
    </form>
    <p className="mt-8">Already registered? <a href="/login">Sign in</a></p>
  </div>;
}
