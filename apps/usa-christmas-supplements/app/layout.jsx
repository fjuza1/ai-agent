import "./globals.css";
import { AdProvider } from "../../../packages/ads/AdSense";
import { activeThemeStyle } from "../../../packages/theme/visualTheme.js";
import { currentUserId } from "../lib/session";
import { FavoritesRuntime, MyPicksDrawer } from "../components/layout/FavoritesChrome";
import GlassNavbar from "../components/layout/GlassNavbar";
import StickyFavoritePillRibbon from "../components/layout/StickyFavoritePillRibbon";
import ComplianceFooter from "../components/layout/ComplianceFooter";
import GdprCookieBanner from "../components/layout/GdprCookieBanner";
import SlideOutCartDrawer from "../components/commerce/SlideOutCartDrawer";
import ProductCompareDrawer from "../components/commerce/ProductCompareDrawer";
import { checkout } from "./actions";

export const metadata = { title: "Winterwell USA", description: "Curated, independently reviewed American-made wellness gifts." };
export const dynamic = "force-dynamic";
export default async function Layout({ children }) {
  const signedIn = Boolean(await currentUserId());
  return <html lang="en" style={activeThemeStyle}><body><AdProvider clientId={process.env.ADSENSE_CLIENT_ID} slotId={process.env.ADSENSE_SLOT_ID} externalConsentUi>
    <div className="sticky-chrome"><GlassNavbar signedIn={signedIn} /><StickyFavoritePillRibbon /></div>
    <main className="max-w-6xl mx-auto p-4 md:p-6 min-h-[65vh]">{children}</main>
    <ComplianceFooter />
    <FavoritesRuntime signedIn={signedIn} /><MyPicksDrawer />
    <SlideOutCartDrawer checkoutAction={checkout} /><ProductCompareDrawer />
    <GdprCookieBanner />
  </AdProvider></body></html>;
}
