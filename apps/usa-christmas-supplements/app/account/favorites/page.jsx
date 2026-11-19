import { catalog } from "../../../lib/catalog";
import { FAVORITE_CATEGORIES, OTHER_CATEGORY } from "../../../lib/categories";
import { db } from "../../../lib/db";
import { requireUser } from "../../../lib/session";
import { pageMetadata, siteOrigin } from "../../../../../packages/seo";
import { removeFavorite } from "../actions";

export function generateMetadata() {
  return pageMetadata(siteOrigin(process.env.SUPPLEMENT_APP_URL, "http://localhost:3001"), "/account/favorites", "My favorites | Winterwell", "Your saved USA-made products, grouped by category.", true);
}

const ORDER = [...FAVORITE_CATEGORIES, OTHER_CATEGORY];

export default async function Favorites({ searchParams }) {
  const query = await searchParams;
  const user = await requireUser("/account/favorites");
  const [favorites, products] = await Promise.all([
    db.favorite.findMany({ where: { userId: user.id }, orderBy: { createdAt: "desc" } }),
    catalog(),
  ]);
  const byId = new Map(products.map((product) => [product.id, product]));
  const counts = new Map();
  for (const favorite of favorites) counts.set(favorite.category, (counts.get(favorite.category) ?? 0) + 1);
  const categories = ORDER.filter((category) => counts.has(category));
  const active = typeof query.category === "string" && counts.has(query.category) ? query.category : null;
  const visible = categories.filter((category) => !active || category === active);
  const returnTo = active ? `/account/favorites?category=${encodeURIComponent(active)}` : "/account/favorites";

  return <section>
    <h1 className="text-3xl font-bold">My favorites</h1>
    {!favorites.length ? <p className="mt-4">You have not saved anything yet. Tap “Save” on any product to keep it here. <a href="/#shop">Browse products</a></p> : <>
      <nav aria-label="Filter favorites by category" className="flex flex-wrap gap-2 mt-6">
        <a className="chip" href="/account/favorites" aria-current={active ? undefined : "page"}>All ({favorites.length})</a>
        {categories.map((category) => <a key={category} className="chip" href={`/account/favorites?category=${encodeURIComponent(category)}`} aria-current={active === category ? "page" : undefined}>{category} ({counts.get(category)})</a>)}
      </nav>
      {visible.map((category) => <section key={category} className="mt-10" aria-label={category}>
        <h2 className="text-2xl font-bold">{category}</h2>
        <div className="grid md:grid-cols-3 gap-5 mt-4">
          {favorites.filter((favorite) => favorite.category === category).map((favorite) => {
            const product = byId.get(favorite.productId);
            return <article key={favorite.id} className="bg-white rounded-xl p-6">
              {product ? <>
                <h3 className="text-xl font-bold"><a href={`/product/${product.id}`}>{product.name}</a></h3>
                <p className="mt-2">{product.description}</p>
                <p className="text-xl font-bold mt-3">${(product.price_cents / 100).toFixed(2)}</p>
                {product.aggregate_rating && <p className="text-sm mt-1">Rated {product.aggregate_rating.rating_value}/5 ({product.aggregate_rating.review_count} reviews)</p>}
              </> : <p>This product is no longer in our reviewed catalog.</p>}
              <form action={removeFavorite} className="mt-4">
                <input type="hidden" name="productId" value={favorite.productId} />
                <input type="hidden" name="returnTo" value={returnTo} />
                <button className="favorite-button" aria-label={`Remove ${product?.name ?? "this product"} from favorites`}>Remove</button>
              </form>
            </article>;
          })}
        </div>
      </section>)}
    </>}
  </section>;
}
