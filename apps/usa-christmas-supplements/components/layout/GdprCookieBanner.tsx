"use client";

import { useEffect, useState } from "react";

const KEY = "ad-consent";
export const CONSENT_EVENT = "ad-consent-change";

// Advertising cookies stay off until the visitor chooses "Accept"; AdSense (packages/ads) listens for the same key.
export default function GdprCookieBanner() {
  const [decided, setDecided] = useState(true);
  useEffect(() => { setDecided(localStorage.getItem(KEY) !== null); }, []);
  function choose(accepted: boolean) {
    const wasAccepted = localStorage.getItem(KEY) === "yes";
    localStorage.setItem(KEY, accepted ? "yes" : "no");
    window.dispatchEvent(new Event(CONSENT_EVENT));
    setDecided(true);
    if (wasAccepted && !accepted) location.reload();
  }
  if (decided) return <button type="button" className="cookie-settings" onClick={() => { localStorage.removeItem(KEY); window.dispatchEvent(new Event(CONSENT_EVENT)); setDecided(false); }}>Cookie settings</button>;
  return <div role="dialog" aria-label="Cookie consent" className="cookie-banner">
    <p>We use essential storage for your cart and saved picks. With your permission we also load advertising cookies (Google AdSense). Email click tracking is separate and controlled in your account settings.</p>
    <div className="flex flex-wrap gap-2 mt-3"><button type="button" onClick={() => choose(true)}>Accept advertising</button><button type="button" className="button-outline" onClick={() => choose(false)}>Essential only</button></div>
  </div>;
}
