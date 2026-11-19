import "./globals.css";
import { AdProvider } from "../../../packages/ads/AdSense";
import { activeThemeStyle } from "../../../packages/theme/visualTheme.js";
import { currentUserId } from "../lib/session";
import FavoritePills from "../components/FavoritePills";
import { FavoritesRuntime, MyPicksDrawer } from "../components/FavoritesChrome";
import { logout } from "./auth-actions";

export const metadata = { title: "Winterwell USA", description: "Curated, independently reviewed American-made wellness gifts." };
export const dynamic = "force-dynamic";
export default async function Layout({ children }) {
  const signedIn = Boolean(await currentUserId());
  return <html lang="en" style={activeThemeStyle}><body><AdProvider clientId={process.env.ADSENSE_CLIENT_ID} slotId={process.env.ADSENSE_SLOT_ID}><header className="max-w-6xl mx-auto p-6 flex flex-wrap gap-6 items-center"><a className="font-bold text-xl" href="/">✳ Winterwell USA</a><nav className="flex flex-wrap gap-4 items-center"><a href="/#shop">Shop</a><a href="/builder">Build a gift</a>{signedIn ? <><a href="/account/favorites">Favorites</a><a href="/account/settings">Settings</a><form action={logout}><button className="favorite-button">Sign out</button></form></> : <><a href="/login">Sign in</a><a href="/signup">Sign up</a></>}</nav></header><div className="fav-ribbon"><div className="fav-ribbon-inner"><span className="fav-ribbon-label">Follow:</span><FavoritePills mode="category" /></div></div><main className="max-w-6xl mx-auto p-6 min-h-[65vh]">{children}</main><footer className="border-t p-6 text-sm max-w-6xl mx-auto">Supplements are not intended to diagnose, treat, cure, or prevent any disease. Consult a qualified health professional before use. Verify product labels and suitability before purchase.</footer><FavoritesRuntime signedIn={signedIn} /><MyPicksDrawer /></AdProvider></body></html>;
}
