"use client";

import Drawer from "../ui/Drawer.tsx";
import { clearCompare, MAX_COMPARE, openPanel, toggleCompare, useShop } from "./shopStore.ts";

export default function ProductCompareDrawer() {
  const { compare, panel } = useShop();
  const items = Object.values(compare);
  return <Drawer id="compare-drawer" title={`⚖️ Compare (${items.length}/${MAX_COMPARE})`} open={panel === "compare"} onClose={() => openPanel(null)}>
    {!items.length ? <p className="mt-4">Pick up to {MAX_COMPARE} products with “Compare” to see them side by side.</p> : <>
      <div className="compare-scroll mt-4"><table className="compare-table">
        <thead><tr><th scope="col"><span className="sr-only">Attribute</span></th>{items.map((item) => <th key={item.id} scope="col"><a href={`/product/${item.id}`}>{item.name}</a></th>)}</tr></thead>
        <tbody>
          <tr><th scope="row">Made in USA</th>{items.map((item) => <td key={item.id}>{item.usa ? "✓ Verified" : "—"}</td>)}</tr>
          <tr><th scope="row">FDA-cleared OTC</th>{items.map((item) => <td key={item.id}>{item.fda ? "✓ Yes" : "No"}</td>)}</tr>
          <tr><th scope="row">Key details</th>{items.map((item) => <td key={item.id}>{item.spec || "—"}</td>)}</tr>
          <tr><th scope="row">Direct price</th>{items.map((item) => <td key={item.id}>{item.direct ? `$${(item.price_cents / 100).toFixed(2)}` : "Retailer link"}</td>)}</tr>
          <tr><th scope="row">Amazon</th>{items.map((item) => <td key={item.id}>{item.amazon ? <a href={item.amazon} target="_blank" rel="nofollow noopener noreferrer">Search ↗</a> : "—"}</td>)}</tr>
          <tr><th scope="row">Alza.sk</th>{items.map((item) => <td key={item.id}>{item.alza ? <a href={item.alza} target="_blank" rel="nofollow noopener noreferrer">Search ↗</a> : "—"}</td>)}</tr>
          <tr><th scope="row"><span className="sr-only">Remove</span></th>{items.map((item) => <td key={item.id}><button type="button" className="favorite-button" onClick={() => toggleCompare(item)}>Remove</button></td>)}</tr>
        </tbody>
      </table></div>
      <p className="text-xs mt-3">Amazon and Alza.sk prices change often, so we link to live search results instead of showing prices. External listings are not reviewed by Winterwell.</p>
      <button type="button" className="favorite-button mt-3" onClick={clearCompare}>Clear all</button>
    </>}
  </Drawer>;
}
