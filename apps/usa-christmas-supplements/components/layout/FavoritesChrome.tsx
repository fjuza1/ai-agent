"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { categoryPill, FAVORITE_CATEGORIES, OTHER_CATEGORY } from "../../lib/categories.ts";
import { useFavorites } from "../engagement/FavoritePills.tsx";
import { bootFavorites, dismissToast, getToasts, NO_TOASTS, subscribeToasts, toggleProduct } from "../engagement/favoritesStore.ts";

const ORDER: string[] = [...FAVORITE_CATEGORIES, OTHER_CATEGORY];

// Loads the saved picks (merging guest picks after sign-in) and hosts the toast stack.
export function FavoritesRuntime({ signedIn }: { signedIn: boolean }) {
  useEffect(() => bootFavorites(signedIn), [signedIn]);
  const toasts = useSyncExternalStore(subscribeToasts, getToasts, () => NO_TOASTS);
  return <div className="fav-toasts" role="status" aria-live="polite">
    {toasts.map((toast) => <p key={toast.id} className={`fav-toast${toast.tone === "error" ? " fav-toast-error" : ""}`}>
      <span>{toast.message}</span>
      <button type="button" aria-label="Dismiss message" onClick={() => dismissToast(toast.id)}>×</button>
    </p>)}
  </div>;
}

export function MyPicksDrawer() {
  const state = useFavorites();
  const [open, setOpen] = useState(false);
  const closeRef = useRef<HTMLButtonElement>(null);
  const launcherRef = useRef<HTMLButtonElement>(null);
  const entries = Object.entries(state.products);
  const groups = ORDER.map((category) => ({ category, items: entries.filter(([, product]) => product.category === category || (category === OTHER_CATEGORY && !FAVORITE_CATEGORIES.includes(product.category as never))) })).filter((group) => group.items.length);

  useEffect(() => {
    if (!open) return;
    closeRef.current?.focus();
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") { setOpen(false); launcherRef.current?.focus(); } };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  return <>
    <button ref={launcherRef} type="button" className="fav-launcher" aria-expanded={open} aria-controls="my-picks-drawer" onClick={() => setOpen(true)}>
      <span aria-hidden="true">💖</span> My Saved Picks ({entries.length})
    </button>
    {open && <div className="fav-scrim" onClick={() => setOpen(false)} />}
    <aside id="my-picks-drawer" className={`fav-drawer${open ? " fav-drawer-open" : ""}`} aria-label="My saved picks" aria-hidden={!open} inert={!open}>
      <header className="fav-drawer-head">
        <h2 className="text-xl font-bold">💖 My Saved Picks</h2>
        <button ref={closeRef} type="button" className="favorite-button" onClick={() => { setOpen(false); launcherRef.current?.focus(); }}>Close</button>
      </header>
      {!entries.length ? <p className="mt-4">Nothing saved yet. Tap “⭐ Save” on any product and it will wait for you here.</p>
        : groups.map(({ category, items }) => {
          const { emoji, label } = categoryPill(category);
          return <section key={category} className="mt-5" aria-label={label}>
            <p className="fav-pill fav-pill-static" aria-hidden="true"><span>{emoji}</span><span>{label}</span><span className="fav-pill-count">{items.length}</span></p>
            <ul className="fav-drawer-list">
              {items.map(([productId, product]) => <li key={productId}>
                <a href={`/product/${productId}`}>{product.name ?? "Saved product"}</a>
                <button type="button" className="favorite-button" aria-label={`Remove ${product.name ?? "this product"} from favorites`}
                  onClick={() => toggleProduct({ productId, category: product.category, name: product.name })}>Remove</button>
              </li>)}
            </ul>
          </section>;
        })}
      <p className="mt-6 text-sm">{state.signedIn ? <a href="/account/favorites">Open my full favorites page</a> : <><a href="/signup">Create a free account</a> to keep these picks on every device and get 4h alerts.</>}</p>
    </aside>
  </>;
}
