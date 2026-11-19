import { logout } from "../../app/auth-actions";
import ChristmasDaysBadge from "../trust/ChristmasDaysBadge";
import HeaderActions from "./HeaderActions";

export default function GlassNavbar({ signedIn }) {
  return <header className="glass-header"><div className="max-w-6xl mx-auto px-4 py-3 flex flex-wrap gap-x-5 gap-y-2 items-center">
    <a className="font-bold text-xl" href="/">✳ Winterwell USA</a>
    <form action="/" method="get" role="search" className="glass-search"><label className="sr-only" htmlFor="nav-search">Search products</label><input id="nav-search" name="q" type="search" maxLength={80} placeholder="Search vitamins, tests, gifts…" /></form>
    <ChristmasDaysBadge />
    <nav aria-label="Main" className="flex flex-wrap gap-4 items-center"><a href="/#shop">Shop</a><a href="/builder">Build a gift</a>{signedIn ? <><a href="/account/favorites">Favorites</a><a href="/account/settings">Settings</a><form action={logout}><button className="favorite-button">Sign out</button></form></> : <><a href="/login">Sign in</a><a href="/signup">Sign up</a></>}</nav>
    <div className="ml-auto"><HeaderActions /></div>
  </div></header>;
}
