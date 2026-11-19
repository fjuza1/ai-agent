import "./globals.css";
import { AdProvider } from "../../../packages/ads/AdSense";
import { activeThemeStyle } from "../../../packages/theme/visualTheme.js";
import { currentUser } from "../lib/auth";
import { logout } from "./actions";

export const metadata = { title: "Sticker Vault", description: "Collect, gift and exchange digital stickers.", referrer: "no-referrer" };
export const dynamic = "force-dynamic";
export default async function Layout({ children }) {
  const user = await currentUser();
  return <html lang="en" style={activeThemeStyle}><body><AdProvider clientId={process.env.ADSENSE_CLIENT_ID} slotId={process.env.ADSENSE_SLOT_ID}>
    <header className="max-w-6xl mx-auto p-6 flex flex-wrap items-center gap-6"><a className="font-bold text-xl" href="/">✦ Sticker Vault</a><nav className="flex gap-4"><a href="/marketplace">Marketplace</a><a href="/vault">My vault</a></nav><div className="ml-auto">{user ? <form action={logout}><button>Sign out</button></form> : <a href="/login">Sign in</a>}</div></header>
    <main className="max-w-6xl mx-auto p-6 min-h-[65vh]">{children}</main>
    <footer className="border-t p-6 text-sm max-w-6xl mx-auto">Digital collectibles are not investments. Stripe handles payments. Support and refund policies must be configured by the operator before launch.</footer>
  </AdProvider></body></html>;
}
