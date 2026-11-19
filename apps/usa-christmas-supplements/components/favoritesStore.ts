import { categoryPill, isFavoriteCategory, parseCategories, type FavoriteCategory } from "../lib/categories.ts";

export type SavedProduct = { category: string; name?: string };
export type FavoritesState = {
  ready: boolean;
  signedIn: boolean;
  alertsEnabled: boolean;
  products: Record<string, SavedProduct>;
  categories: FavoriteCategory[];
};
export type Toast = { id: number; message: string; tone: "ok" | "error" };

const KEY = "winterwell:favorites:v1";
const PRODUCT_ID = /^[A-Za-z0-9._-]{1,80}$/;
const MAX_GUEST_PRODUCTS = 100;

// Stable object so useSyncExternalStore can use it as the server snapshot.
export const INITIAL_STATE: FavoritesState = { ready: false, signedIn: false, alertsEnabled: false, products: {}, categories: [] };

let state: FavoritesState = INITIAL_STATE;
let toasts: Toast[] = [];
let nextToastId = 1;
let bootedAs: boolean | undefined;
let listeningForStorage = false;
let queue: Promise<unknown> = Promise.resolve();
const stateListeners = new Set<() => void>();
const toastListeners = new Set<() => void>();

export const subscribeFavorites = (listener: () => void) => { stateListeners.add(listener); return () => { stateListeners.delete(listener); }; };
export const getFavorites = () => state;
export const subscribeToasts = (listener: () => void) => { toastListeners.add(listener); return () => { toastListeners.delete(listener); }; };
export const getToasts = () => toasts;
export const NO_TOASTS: Toast[] = [];

function commit(patch: Partial<FavoritesState>) {
  state = { ...state, ...patch };
  stateListeners.forEach((listener) => listener());
}

export function dismissToast(id: number) {
  toasts = toasts.filter((toast) => toast.id !== id);
  toastListeners.forEach((listener) => listener());
}

export function showToast(message: string, tone: Toast["tone"] = "ok") {
  const id = nextToastId++;
  toasts = [...toasts.slice(-2), { id, message, tone }];
  toastListeners.forEach((listener) => listener());
  setTimeout(() => dismissToast(id), 4500);
}

type GuestData = { products: Record<string, SavedProduct>; categories: FavoriteCategory[] };

function readGuest(): GuestData {
  const empty: GuestData = { products: {}, categories: [] };
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? "null");
    if (!raw || typeof raw !== "object") return empty;
    const products: Record<string, SavedProduct> = {};
    for (const [id, value] of Object.entries(raw.products ?? {}).slice(0, MAX_GUEST_PRODUCTS)) {
      const entry = value as SavedProduct;
      if (PRODUCT_ID.test(id) && entry && typeof entry.category === "string") products[id] = { category: entry.category.slice(0, 80), ...(typeof entry.name === "string" ? { name: entry.name.slice(0, 160) } : {}) };
    }
    return { products, categories: parseCategories(raw.categories) };
  } catch { return empty; }
}

function writeGuest() {
  try { localStorage.setItem(KEY, JSON.stringify({ products: state.products, categories: state.categories })); } catch { /* private mode or full storage: taps still work for this page view */ }
}

function clearGuest() {
  try { localStorage.removeItem(KEY); } catch { /* nothing to clear */ }
}

async function api(path: string, method: string, body?: unknown) {
  const response = await fetch(path, { method, cache: "no-store", ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }) });
  if (!response.ok) throw Object.assign(new Error("Request failed"), { status: response.status });
  return response.json();
}

type Snapshot = { favorites: { productId: string; category: string; name?: string | null }[]; categories: unknown; alertsEnabled?: boolean; merged?: { products: number; categories: number } };

function fromSnapshot(snapshot: Snapshot): Partial<FavoritesState> {
  const products: Record<string, SavedProduct> = {};
  for (const favorite of snapshot.favorites) products[favorite.productId] = { category: favorite.category, ...(favorite.name ? { name: favorite.name } : {}) };
  return { ready: true, signedIn: true, alertsEnabled: Boolean(snapshot.alertsEnabled), products, categories: parseCategories(snapshot.categories) };
}

// Loads the visitor's picks once per page view. Guest picks live in localStorage and are merged into the account right after sign-in or sign-up.
// Sign-in and sign-out can happen through a soft navigation, so a change of `signedIn` boots again.
export function bootFavorites(signedIn: boolean) {
  if (bootedAs === signedIn || typeof window === "undefined") return;
  bootedAs = signedIn;
  if (!signedIn) { loadGuest(); return; }
  void (async () => {
    try {
      const guest = readGuest();
      const hasGuestData = Object.keys(guest.products).length > 0 || guest.categories.length > 0;
      let snapshot: Snapshot;
      if (hasGuestData) {
        snapshot = await api("/api/favorites/sync", "POST", { products: Object.entries(guest.products).map(([productId, entry]) => ({ productId, category: entry.category })), categories: guest.categories });
        clearGuest();
        if (snapshot.merged && (snapshot.merged.products || snapshot.merged.categories)) showToast("Your picks from before signing in are now saved to your account.");
      } else snapshot = await api("/api/favorites", "GET");
      commit(fromSnapshot(snapshot));
    } catch {
      loadGuest();
    }
  })();
}

function loadGuest() {
  commit({ ...readGuest(), ready: true, signedIn: false, alertsEnabled: false });
  if (listeningForStorage) return;
  listeningForStorage = true;
  window.addEventListener("storage", (event) => { if (event.key === KEY && !state.signedIn) commit(readGuest()); });
}

const alertSuffix = () => state.signedIn
  ? state.alertsEnabled ? " We'll alert you every 4h on workdays" : " Turn on email alerts in Settings to get picks every 4h on workdays."
  : " Create a free account to get picks every 4h on workdays.";

function enqueue(task: () => Promise<void>) {
  queue = queue.then(task, task);
}

function failure(error: unknown) {
  showToast((error as { status?: number }).status === 401 ? "Your session expired. Please sign in again." : "Could not save that just now. Please try again.", "error");
}

export function toggleCategory(category: FavoriteCategory) {
  const on = !state.categories.includes(category);
  const apply = (active: boolean) => commit({ categories: parseCategories(active ? [...state.categories, category] : state.categories.filter((entry) => entry !== category)) });
  apply(on);
  const { label } = categoryPill(category);
  if (!state.signedIn) {
    writeGuest();
    showToast(on ? `Added to your ${label} favorites!${alertSuffix()}` : `Removed ${label} from your favorites.`);
    return;
  }
  enqueue(async () => {
    try {
      const result = await api("/api/favorites/toggle", "POST", { type: "category", category, saved: on });
      commit({ alertsEnabled: Boolean(result.alertsEnabled) });
      showToast(on ? `Added to your ${label} favorites!${alertSuffix()}` : `Removed ${label} from your favorites.`);
    } catch (error) {
      apply(!on);
      failure(error);
    }
  });
}

export function toggleProduct(input: { productId: string; category: string; name?: string; followCategory?: boolean }) {
  const { productId, category, name, followCategory } = input;
  const on = !(productId in state.products);
  if (on && !state.signedIn && Object.keys(state.products).length >= MAX_GUEST_PRODUCTS) {
    showToast("Guest picks are limited to 100. Create a free account to save more.", "error");
    return;
  }
  const follows = on && followCategory === true && isFavoriteCategory(category) && !state.categories.includes(category);
  const applyProduct = (active: boolean) => {
    const products = { ...state.products };
    if (active) products[productId] = { category, ...(name ? { name } : {}) }; else delete products[productId];
    commit({ products });
  };
  const applyFollow = (active: boolean) => {
    if (isFavoriteCategory(category)) commit({ categories: parseCategories(active ? [...state.categories, category] : state.categories.filter((entry) => entry !== category)) });
  };
  applyProduct(on);
  if (follows) applyFollow(true);
  const { label } = categoryPill(category);
  const message = () => on ? `💖 Saved ${name ?? "this product"} to your ${label} favorites!${follows || state.categories.includes(category as FavoriteCategory) ? alertSuffix() : ""}` : `Removed ${name ?? "this product"} from your favorites.`;
  if (!state.signedIn) {
    writeGuest();
    showToast(message());
    return;
  }
  enqueue(async () => {
    try {
      const result = await api("/api/favorites/toggle", "POST", { type: "product", productId, category, saved: on, followCategory: follows });
      commit({ alertsEnabled: Boolean(result.alertsEnabled) });
      showToast(message());
    } catch (error) {
      applyProduct(!on);
      if (follows) applyFollow(false);
      failure(error);
    }
  });
}

export const savedCount = (current: FavoritesState, category: string) => Object.values(current.products).filter((entry) => entry.category === category).length;
