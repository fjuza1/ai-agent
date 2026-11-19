import { parseCategories } from "../../../lib/categories";
import FavoritePills from "../../../components/FavoritePills";
import { magicLinkEnabled } from "../../../lib/auth";
import { requireUser } from "../../../lib/session";
import { pageMetadata, siteOrigin } from "../../../../../packages/seo";
import { saveSettings, sendVerification, setPassword, unsubscribeAll } from "../actions";

export function generateMetadata() {
  return pageMetadata(siteOrigin(process.env.SUPPLEMENT_APP_URL, "http://localhost:3001"), "/account/settings", "Settings | Winterwell", "Manage categories, email alerts and tracking preferences.", true);
}

const notices = {
  saved: "Your settings were saved.",
  welcome: "Welcome! Pick your favorite categories and alert preferences below.",
  unsubscribed: "You are unsubscribed from product alert emails and tracking is off.",
  verified: "Your email is verified. You can set a password below if you want one.",
};
const errors = {
  password: "Use a password of 10 to 72 characters.",
  current: "Your current password is incorrect.",
  verification: "We could not send the verification email. Try again later.",
};

export default async function Settings({ searchParams }) {
  const query = await searchParams;
  const user = await requireUser("/account/settings");
  const categories = parseCategories(user.favoriteCategories);
  const notice = Object.keys(notices).find((key) => query[key]);
  const error = typeof query.error === "string" ? errors[query.error] : null;
  return <section className="max-w-2xl">
    <h1 className="text-3xl font-bold">Settings</h1>
    <p className="mt-2">Signed in as {user.email}</p>
    {notice && <p role="status" className="mt-4 font-bold">{notices[notice]}</p>}
    {error && <p role="alert" className="mt-4 font-bold">{error}</p>}

    <form action={saveSettings} className="grid gap-6 mt-6">
      <fieldset className="grid gap-2"><legend className="font-bold text-xl">Favorite categories</legend>
        <FavoritePills mode="category" name="favoriteCategories" defaultSelected={categories} />
      </fieldset>

      <fieldset className="grid gap-2"><legend className="font-bold text-xl">Email alerts</legend>
        <label><input type="checkbox" name="emailAlertsEnabled" defaultChecked={user.emailAlertsEnabled} /> Email me product recommendations</label>
        <p>Schedule: every {user.alertIntervalHours} hours on workdays (Mon–Fri), around 08:00, 12:00, 16:00 and 20:00 CET. This schedule is fixed.</p>
        <p>Each email has up to 3 top-rated USA-made picks from your favorite categories, never repeating an item sent in the last 7 days.</p>
        {!user.emailVerified && <p role="note" className="font-bold">Alerts are sent only to verified addresses. Verify your email with the button below.</p>}
      </fieldset>

      <fieldset className="grid gap-2"><legend className="font-bold text-xl">Privacy</legend>
        <label><input type="checkbox" name="trackingEnabled" defaultChecked={user.trackingEnabled} /> Track clicks and opens in alert emails to improve my recommendations</label>
        <p className="text-sm">When off, emails contain plain product links and no open or click tracking.</p>
      </fieldset>
      <div><button>Save settings</button></div>
    </form>

    <div className="flex flex-wrap gap-3 mt-8">
      {!user.emailVerified && magicLinkEnabled && <form action={sendVerification}><button>Verify my email</button></form>}
      <form action={unsubscribeAll}><button>Unsubscribe from all emails</button></form>
      <a className="button button-outline" href="/api/account/export" download>Download my data (GDPR export)</a>
    </div>

    <form action={setPassword} className="grid gap-3 mt-10">
      <h2 className="text-xl font-bold">{user.passwordHash ? "Change password" : "Set a password"}</h2>
      {user.passwordHash && <label>Current password <input className="block w-full" type="password" name="currentPassword" autoComplete="current-password" maxLength={72} required /></label>}
      <label>New password (10+ characters) <input className="block w-full" type="password" name="newPassword" autoComplete="new-password" minLength={10} maxLength={72} required /></label>
      <div><button>{user.passwordHash ? "Change password" : "Set password"}</button></div>
    </form>
  </section>;
}
