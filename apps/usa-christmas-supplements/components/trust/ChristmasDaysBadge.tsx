"use client";

import { useEffect, useState } from "react";

export default function ChristmasDaysBadge() {
  const [days, setDays] = useState<number | null>(null);
  useEffect(() => {
    const now = new Date();
    const target = new Date(now.getFullYear(), 11, 24, 23, 59, 59);
    setDays(target.getTime() < now.getTime() ? null : Math.ceil((target.getTime() - now.getTime()) / 86_400_000));
  }, []);
  if (days === null) return null;
  return <span className="trust-badge" aria-label={`${days} days until December 24`}>🎄 {days}d to Dec 24</span>;
}
