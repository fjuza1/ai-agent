"use client";

import { useRef } from "react";

const POLICIES = {
  affiliate: { title: "Affiliate disclosure", body: [
    "Some links, marked “Affiliate”, take you to a retailer where we may earn a commission at no extra cost to you.",
    "Amazon and Alza.sk buttons open search results in a new tab; those listings are not reviewed by Winterwell and may not be made in the USA.",
  ] },
  returns: { title: "Returns", body: [
    "Direct orders are fulfilled through Stripe checkout. Contact us from the product page to ask about a return or exchange.",
    "Orders placed with a retailer through an affiliate link are governed by that retailer’s return policy. Statutory consumer rights (including EU/Slovak withdrawal rights) are not affected.",
  ] },
  privacy: { title: "Privacy & cookies", body: [
    "Your saved picks, cart, comparison and recently viewed items are stored in your browser. Signed-in users’ saved picks are stored in their account.",
    "Advertising cookies load only if you accept them in the cookie banner. Email click tracking is a per-account setting under Settings and is off unless you enable it.",
    "In the EU you may access, export or delete your data from your account settings or by contacting us.",
  ] },
} as const;
type Key = keyof typeof POLICIES;

export function DisclaimerBar() {
  return <p className="disclaimer-bar" role="note">
    These statements have not been evaluated by the Food and Drug Administration. Supplements are not intended to diagnose, treat, cure, or prevent any disease (DSHEA). Pregnancy tests are over-the-counter diagnostic devices; follow the instructions and consult a healthcare professional about results.
  </p>;
}

export function PolicyLinks() {
  const refs = useRef<Record<Key, HTMLDialogElement | null>>({ affiliate: null, returns: null, privacy: null });
  return <>
    <ul className="flex flex-wrap gap-4 mt-3" aria-label="Policies">
      {(Object.keys(POLICIES) as Key[]).map((key) => <li key={key}><button type="button" className="favorite-button" onClick={() => refs.current[key]?.showModal()}>{POLICIES[key].title}</button></li>)}
    </ul>
    {(Object.keys(POLICIES) as Key[]).map((key) => <dialog key={key} ref={(node) => { refs.current[key] = node; }} className="policy-modal" aria-label={POLICIES[key].title}>
      <h2 className="text-xl font-bold">{POLICIES[key].title}</h2>
      {POLICIES[key].body.map((text) => <p key={text} className="mt-3">{text}</p>)}
      <form method="dialog" className="mt-4"><button>Close</button></form>
    </dialog>)}
  </>;
}
