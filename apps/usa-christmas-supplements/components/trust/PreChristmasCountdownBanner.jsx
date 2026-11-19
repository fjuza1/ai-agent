"use client";
import { useEffect, useState } from "react";

export default function PreChristmasCountdownBanner({ cutoff }) {
  const [remaining, setRemaining] = useState(null);
  useEffect(() => {
    function update() { setRemaining(Math.max(0, Date.parse(cutoff.cutoff_at) - Date.now())); }
    update();
    const timer = setInterval(update, 1000);
    return () => clearInterval(timer);
  }, [cutoff.cutoff_at]);
  if (remaining === null || remaining <= 0) return null;
  const seconds = Math.floor(remaining / 1000);
  const clock = `${Math.floor(seconds / 86400)}d ${String(Math.floor(seconds / 3600) % 24).padStart(2, "0")}h ${String(Math.floor(seconds / 60) % 60).padStart(2, "0")}m ${String(seconds % 60).padStart(2, "0")}s`;
  return <aside className="p-4 rounded-lg bg-emerald-900 text-white" aria-label="Verified holiday delivery cutoff">
    <p>For <a className="text-white underline" href={`/product/${cutoff.productId}`}>this eligible bundle</a>: order within <strong>{clock}</strong> for guaranteed arrival before December 24, subject to the seller&apos;s terms.</p>
    <p className="text-sm mt-1">Cutoff: {new Intl.DateTimeFormat("en-US", { dateStyle: "long", timeStyle: "short", timeZone: cutoff.timezone }).format(new Date(cutoff.cutoff_at))} ({cutoff.timezone}). <a className="text-white underline" href={cutoff.evidence_url} rel="noreferrer">Guarantee terms</a></p>
  </aside>;
}
