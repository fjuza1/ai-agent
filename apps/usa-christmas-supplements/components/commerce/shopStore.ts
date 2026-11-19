import { useSyncExternalStore } from "react";

export const MAX_COMPARE = 3;
export const MAX_CART = 10;
// Display-only goal for the progress bar; Stripe checkout does not apply it.
export const FREE_SHIPPING_CENTS = 5000;
const MAX_RECENT = 12;
const KEY = "winterwell:shop:v1";
const ID = /^[A-Za-z0-9._-]{1,80}$/;

export type ShopProduct = {
  id: string;
  name: string;
  price_cents: number;
  usa: boolean;
  fda: boolean;
  spec: string;
  direct: boolean;
  discreetOk: boolean;
  amazon?: string;
  alza?: string;
};
export type Panel = "cart" | "compare" | null;
type State = { cart: Record<string, ShopProduct>; compare: Record<string, ShopProduct>; recent: string[]; discreet: boolean; sticker: boolean; panel: Panel };

const EMPTY: State = { cart: {}, compare: {}, recent: [], discreet: false, sticker: false, panel: null };
let state: State = EMPTY;
let loaded = false;
const listeners = new Set<() => void>();

function sanitizeProducts(value: unknown): Record<string, ShopProduct> {
  const out: Record<string, ShopProduct> = {};
  if (!value || typeof value !== "object") return out;
  for (const [id, raw] of Object.entries(value as Record<string, ShopProduct>)) {
    if (ID.test(id) && raw && typeof raw.name === "string" && Number.isInteger(raw.price_cents)) out[id] = { ...raw, id };
  }
  return out;
}

function load() {
  if (loaded || typeof window === "undefined") return;
  loaded = true;
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? "{}");
    state = {
      ...EMPTY,
      cart: sanitizeProducts(saved.cart),
      compare: sanitizeProducts(saved.compare),
      recent: Array.isArray(saved.recent) ? saved.recent.filter((id: unknown): id is string => typeof id === "string" && ID.test(id)).slice(0, MAX_RECENT) : [],
      discreet: saved.discreet === true,
      sticker: saved.sticker === true,
    };
  } catch { state = EMPTY; }
}

function commit(patch: Partial<State>) {
  state = { ...state, ...patch };
  const { panel: _panel, ...persisted } = state;
  try { localStorage.setItem(KEY, JSON.stringify(persisted)); } catch { /* storage unavailable: keep in-memory state */ }
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void) {
  load();
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
export const useShop = () => useSyncExternalStore(subscribe, () => { load(); return state; }, () => EMPTY);

export const openPanel = (panel: Panel) => commit({ panel });

export function toggleCart(product: ShopProduct) {
  const cart = { ...state.cart };
  if (cart[product.id]) delete cart[product.id];
  else if (Object.keys(cart).length < MAX_CART) cart[product.id] = product;
  commit({ cart });
}

export function toggleCompare(product: ShopProduct) {
  const compare = { ...state.compare };
  if (compare[product.id]) delete compare[product.id];
  else if (Object.keys(compare).length < MAX_COMPARE) compare[product.id] = product;
  commit({ compare });
}

export const clearCompare = () => commit({ compare: {} });
export const setDiscreet = (discreet: boolean) => commit({ discreet });
export const setSticker = (sticker: boolean) => commit({ sticker });

export function recordView(id: string) {
  load();
  if (!ID.test(id) || state.recent[0] === id) return;
  commit({ recent: [id, ...state.recent.filter((item) => item !== id)].slice(0, MAX_RECENT) });
}
