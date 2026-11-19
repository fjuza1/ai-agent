import FavoritePills from "../engagement/FavoritePills";

export default function StickyFavoritePillRibbon() {
  return <div className="fav-ribbon"><div className="fav-ribbon-inner"><span className="fav-ribbon-label">Follow:</span><FavoritePills mode="category" /></div></div>;
}
