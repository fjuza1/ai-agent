"use client";

import { categoryPill } from "../../lib/categories.ts";
import { useShop } from "../commerce/shopStore.ts";
import { useFavorites } from "./FavoritePills.tsx";

export type StripProduct = { id: string; name: string; price_cents: number; categories: string[] };

function Row({ title, products }: { title: string; products: StripProduct[] }) {
  return <section className="mt-12" aria-label={title}>
    <h2 className="text-2xl font-bold">{title}</h2>
    <ul className="flex gap-4 mt-4 overflow-x-auto pb-2">
      {products.map((p) => <li key={p.id} className="bg-white p-4 min-w-52"><a href={`/product/${p.id}`} className="font-bold">{p.name}</a><p className="mt-1">${(p.price_cents / 100).toFixed(2)}</p></li>)}
    </ul>
  </section>;
}

export default function RecentlyViewedStrip({ products }: { products: StripProduct[] }) {
  const { recent } = useShop();
  const favorites = useFavorites();
  const byId = new Map(products.map((p) => [p.id, p]));
  const viewed = recent.map((id) => byId.get(id)).filter((p): p is StripProduct => Boolean(p)).slice(0, 6);
  const category = favorites.categories[0];
  const becauseSaved = category ? products.filter((p) => p.categories.includes(category) && !favorites.products[p.id]).slice(0, 6) : [];
  const pill = category ? categoryPill(category) : null;
  return <>
    {pill && becauseSaved.length > 0 && <Row title={`Because you saved ${pill.emoji} ${pill.label}`} products={becauseSaved} />}
    {viewed.length > 0 && <Row title="Recently viewed" products={viewed} />}
  </>;
}
