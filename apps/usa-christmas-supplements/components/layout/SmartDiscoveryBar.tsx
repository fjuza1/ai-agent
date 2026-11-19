"use client";

import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from "react";
import { fold, matchesItem, suggest, type DiscoveryItem, type Suggestion } from "../../lib/discovery.ts";

export type DiscoveryEntry = DiscoveryItem & { card: ReactNode };

type Props = {
  items: DiscoveryEntry[];
  usedFor: string[];
  trending: string[];
  initialQuery?: string;
  initialTag?: string;
};

const SUGGESTION_LABELS: Record<Suggestion["type"], string> = { used_for: "Used for", product: "Product", search: "Search" };

export default function SmartDiscoveryBar({ items, usedFor, trending, initialQuery = "", initialTag = "" }: Props) {
  const [query, setQuery] = useState(initialQuery);
  const [tag, setTag] = useState(initialTag);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const id = useId();
  const mounted = useRef(false);
  const suggestions = useMemo(() => suggest(items, query), [items, query]);
  const visible = useMemo(() => items.filter((item) => matchesItem(item, query, tag)), [items, query, tag]);
  const pills = tag && !usedFor.some((pill) => fold(pill) === fold(tag)) ? [tag, ...usedFor] : usedFor;
  const filtered = Boolean(query.trim() || tag);
  const showList = open && suggestions.length > 0;

  // Keeps the filtered view shareable; debounced because browsers rate-limit history updates.
  useEffect(() => {
    if (!mounted.current) { mounted.current = true; return; }
    const timer = setTimeout(() => {
      const url = new URL(window.location.href);
      url.searchParams.delete("filter");
      for (const [key, value] of [["q", query.trim()], ["used_for", tag]]) {
        if (value) url.searchParams.set(key, value); else url.searchParams.delete(key);
      }
      try { window.history.replaceState(window.history.state, "", url); } catch { /* rate limited */ }
    }, 300);
    return () => clearTimeout(timer);
  }, [query, tag]);

  function close() {
    setOpen(false);
    setActive(-1);
  }

  function choose(suggestion: Suggestion) {
    close();
    if (suggestion.type === "product") window.location.assign(`/product/${encodeURIComponent(suggestion.value)}`);
    else if (suggestion.type === "used_for") { setTag(suggestion.value); setQuery(""); }
    else setQuery(suggestion.value);
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if ((event.key === "ArrowDown" || event.key === "ArrowUp") && suggestions.length) {
      event.preventDefault();
      setOpen(true);
      setActive((current) => event.key === "ArrowDown"
        ? (current + 1) % suggestions.length
        : (current <= 0 ? suggestions.length : current) - 1);
    } else if (event.key === "Enter" && showList && suggestions[active]) {
      event.preventDefault();
      choose(suggestions[active]);
    } else if (event.key === "Enter") {
      close();
    } else if (event.key === "Escape" && showList) {
      event.preventDefault();
      close();
    }
  }

  function press(event: MouseEvent, apply: () => void) {
    event.preventDefault();
    close();
    apply();
  }

  return <section id="shop" className="mt-12" aria-labelledby={`${id}-heading`}>
    <h2 id={`${id}-heading`} className="text-3xl font-bold">Find what you need</h2>
    {/* The forms submit as plain GET requests without JavaScript; with it, filtering is instant. */}
    <form role="search" action="/#shop" method="get" className="mt-4" onSubmit={(event) => event.preventDefault()}>
      <label htmlFor={`${id}-input`} className="font-bold">Search products, goals and popular searches</label>
      <div className="relative mt-2">
        <input id={`${id}-input`} className="w-full" type="search" name="q" value={query} maxLength={80} autoComplete="off"
          placeholder="Try “immunity”, “prenatal” or “gift box”"
          role="combobox" aria-autocomplete="list" aria-expanded={showList} aria-controls={`${id}-list`}
          aria-activedescendant={showList && active >= 0 ? `${id}-option-${active}` : undefined}
          onChange={(event) => { setQuery(event.target.value); setOpen(true); setActive(-1); }}
          onFocus={() => setOpen(true)} onBlur={close} onKeyDown={onKeyDown} />
        <ul id={`${id}-list`} role="listbox" aria-label="Search suggestions" className="suggestions" hidden={!showList}>
          {suggestions.map((suggestion, index) => <li key={`${suggestion.type}:${suggestion.value}`} id={`${id}-option-${index}`}
            role="option" aria-selected={index === active}
            onMouseDown={(event) => event.preventDefault()} onClick={() => choose(suggestion)}>
            <span>{suggestion.label}</span><span className="suggestion-type">{SUGGESTION_LABELS[suggestion.type]}</span>
          </li>)}
        </ul>
      </div>
      {pills.length > 0 && <div className="mt-5" role="group" aria-labelledby={`${id}-used-for`}>
        <h3 id={`${id}-used-for`} className="font-bold">Used for</h3>
        <div className="flex flex-wrap gap-2 mt-2">
          {pills.map((pill) => {
            const pressed = fold(pill) === fold(tag);
            return <button key={pill} type="submit" name="used_for" value={pill} className="chip" aria-pressed={pressed}
              onClick={(event) => press(event, () => setTag(pressed ? "" : pill))}>{pill}</button>;
          })}
        </div>
      </div>}
    </form>
    {trending.length > 0 && <form action="/#shop" method="get" className="mt-5" aria-labelledby={`${id}-trending`}>
      <h3 id={`${id}-trending`} className="font-bold">Most Searched Right Now</h3>
      <div className="flex flex-wrap gap-2 mt-2">
        {trending.map((keyword) => {
          const pressed = fold(keyword) === fold(query);
          return <button key={keyword} type="submit" name="q" value={keyword} className="chip chip-trending" aria-pressed={pressed}
            onClick={(event) => press(event, () => { setQuery(pressed ? "" : keyword); setTag(""); })}>{keyword}</button>;
        })}
      </div>
    </form>}
    <p className="mt-6 text-sm" role="status" aria-live="polite">
      {!items.length ? "No approved products are available yet."
        : !filtered ? `Showing all ${items.length} approved products.`
        : visible.length ? `${visible.length} of ${items.length} products match.`
        : "No approved products match this search."}
      {filtered && <> <a href="/#shop" onClick={(event) => press(event, () => { setQuery(""); setTag(""); })}>Clear search and filters</a></>}
    </p>
    <div className="grid md:grid-cols-3 gap-5 mt-6">
      {visible.map((item) => <div key={item.id} className="contents">{item.card}</div>)}
    </div>
  </section>;
}
