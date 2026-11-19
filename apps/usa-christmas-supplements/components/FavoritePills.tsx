"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { categoryPill, FAVORITE_CATEGORIES, type FavoriteCategory } from "../lib/categories.ts";
import { getFavorites, INITIAL_STATE, savedCount, subscribeFavorites, toggleCategory, toggleProduct } from "./favoritesStore.ts";

type CategoryProps = {
  mode: "category";
  // Defaults to every favorite category; pass a subset to show only the categories a product belongs to.
  categories?: readonly FavoriteCategory[];
  // When set, the selection is also submitted with the surrounding <form> as repeated `name` fields (sign-up and settings).
  name?: string;
  // Shown as selected until the saved picks have loaded (server-known state for forms).
  defaultSelected?: readonly string[];
  showCounts?: boolean;
  className?: string;
};
type ProductProps = {
  mode: "product";
  productId: string;
  category: string;
  productName?: string;
  // "prominent" is the detail-page call to action; it also opts the product's category in to the 4h alerts.
  variant?: "compact" | "prominent";
  className?: string;
};

export function useFavorites() {
  return useSyncExternalStore(subscribeFavorites, getFavorites, () => INITIAL_STATE);
}

// Re-triggers the CSS bounce on every tap, even when tapping quickly.
function useBounce() {
  const [bounce, setBounce] = useState(0);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  return {
    bouncing: bounce > 0,
    trigger() {
      clearTimeout(timer.current);
      setBounce(0);
      requestAnimationFrame(() => {
        setBounce(1);
        timer.current = setTimeout(() => setBounce(0), 500);
      });
    },
  };
}

function CategoryPill({ category, active, count, onToggle }: { category: FavoriteCategory; active: boolean; count: number; onToggle: () => void }) {
  const { emoji, label } = categoryPill(category);
  const { bouncing, trigger } = useBounce();
  return <button type="button" className={`fav-pill${bouncing ? " fav-pill-bump" : ""}`} aria-pressed={active}
    aria-label={`${label}${count ? `, ${count} saved` : ""}`}
    onClick={() => { trigger(); onToggle(); }}>
    <span aria-hidden="true" className="fav-pill-emoji">{emoji}</span>
    <span>{label}</span>
    {count > 0 && <span className="fav-pill-count" aria-hidden="true">{count}</span>}
  </button>;
}

function CategoryPills({ categories = FAVORITE_CATEGORIES, name, defaultSelected = [], showCounts = true, className = "" }: Omit<CategoryProps, "mode">) {
  const state = useFavorites();
  const selected = state.ready ? state.categories : defaultSelected;
  return <div className={`fav-pills ${className}`} role="group" aria-label="Favorite categories">
    {categories.map((category) => <CategoryPill key={category} category={category} active={selected.includes(category)}
      count={showCounts ? savedCount(state, category) : 0} onToggle={() => toggleCategory(category)} />)}
    {name && selected.map((category) => <input key={category} type="hidden" name={name} value={category} />)}
  </div>;
}

function ProductPill({ productId, category, productName, variant = "compact", className = "" }: Omit<ProductProps, "mode">) {
  const state = useFavorites();
  const saved = productId in state.products;
  const { bouncing, trigger } = useBounce();
  const prominent = variant === "prominent";
  const text = prominent
    ? saved ? "💖 Saved to Favorites · 4h Alerts" : "⭐ Save to Favorites & Get 4h Alerts"
    : saved ? "💖 Saved" : "⭐ Save";
  return <button type="button" className={`fav-pill fav-pill-product${prominent ? " fav-pill-prominent" : ""}${bouncing ? " fav-pill-bump" : ""} ${className}`}
    aria-pressed={saved} aria-label={`${saved ? "Remove" : "Save"} ${productName ?? "this product"} ${saved ? "from" : "to"} favorites`}
    onClick={() => { trigger(); toggleProduct({ productId, category, name: productName, followCategory: prominent }); }}>
    {text}
  </button>;
}

export default function FavoritePills(props: CategoryProps | ProductProps) {
  return props.mode === "category" ? <CategoryPills {...props} /> : <ProductPill {...props} />;
}
