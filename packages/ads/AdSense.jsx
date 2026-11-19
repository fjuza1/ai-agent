"use client";

import { createContext, useContext, useEffect, useState } from "react";

const AdContext = createContext({ enabled: false });

export function AdProvider({ clientId, slotId, children, externalConsentUi = false }) {
  const [consent, setConsent] = useState(false);
  const [decided, setDecided] = useState(false);
  useEffect(() => {
    const stored = localStorage.getItem("ad-consent");
    setConsent(stored === "yes");
    setDecided(stored !== null);
  }, []);
  useEffect(() => {
    if (!externalConsentUi) return;
    const sync = () => { const stored = localStorage.getItem("ad-consent"); setConsent(stored === "yes"); setDecided(stored !== null); };
    window.addEventListener("ad-consent-change", sync);
    return () => window.removeEventListener("ad-consent-change", sync);
  }, [externalConsentUi]);
  const enabled = consent && /^ca-pub-\d{16}$/.test(clientId || "") && /^\d+$/.test(slotId || "");
  useEffect(() => {
    if (!enabled) return;
    const preconnect = document.createElement("link");
    preconnect.rel = "preconnect";
    preconnect.href = "https://pagead2.googlesyndication.com";
    preconnect.crossOrigin = "anonymous";
    document.head.appendChild(preconnect);
    const script = document.createElement("script");
    script.async = true;
    script.crossOrigin = "anonymous";
    script.src = `https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=${clientId}`;
    script.onerror = () => console.error("AdSense script could not be loaded.");
    document.head.appendChild(script);
    return () => { script.remove(); preconnect.remove(); };
  }, [enabled, clientId]);
  function choose(accepted) {
    localStorage.setItem("ad-consent", accepted ? "yes" : "no");
    setConsent(accepted);
    setDecided(true);
    if (!accepted) location.reload();
  }
  return <AdContext.Provider value={{ enabled, clientId, slotId }}>
    {children}
    {!externalConsentUi && !decided && <div role="dialog" aria-label="Advertising consent" className="fixed bottom-0 inset-x-0 z-50 bg-white border-t p-4 shadow-lg">
      <p>Allow advertising cookies? This is a consent stub, not a certified regional consent platform.</p>
      <div className="flex gap-2 mt-2"><button onClick={() => choose(true)}>Allow</button><button onClick={() => choose(false)}>Decline</button></div>
    </div>}
    {!externalConsentUi && decided && <button className="fixed bottom-2 right-2 text-xs" onClick={() => { localStorage.removeItem("ad-consent"); setConsent(false); setDecided(false); }}>Ad settings</button>}
  </AdContext.Provider>;
}

export function AdSenseBanner() {
  const { enabled, clientId, slotId } = useContext(AdContext);
  useEffect(() => {
    if (!enabled) return;
    try { (window.adsbygoogle = window.adsbygoogle || []).push({}); }
    catch (error) { console.error("AdSense could not initialize", error); }
  }, [enabled]);
  if (!enabled) return null;
  return <aside aria-label="Advertisement" className="my-8"><span className="text-xs">Advertisement</span><ins className="adsbygoogle block" data-ad-client={clientId} data-ad-slot={slotId} data-ad-format="auto" data-full-width-responsive="true" /></aside>;
}
