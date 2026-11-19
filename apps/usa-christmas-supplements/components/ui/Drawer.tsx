"use client";

import { useEffect, useRef, type ReactNode } from "react";

type Props = { id: string; title: string; open: boolean; onClose: () => void; children: ReactNode };

export default function Drawer({ id, title, open, onClose, children }: Props) {
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    closeRef.current?.focus();
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);
  return <>
    {open && <div className="fav-scrim" onClick={onClose} />}
    <aside id={id} className={`fav-drawer${open ? " fav-drawer-open" : ""}`} aria-label={title} aria-hidden={!open} inert={!open}>
      <header className="fav-drawer-head">
        <h2 className="text-xl font-bold">{title}</h2>
        <button ref={closeRef} type="button" className="favorite-button" onClick={onClose}>Close</button>
      </header>
      {children}
    </aside>
  </>;
}
