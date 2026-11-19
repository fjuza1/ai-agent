"use client";
import { useEffect, useRef } from "react";

export default function OverageModal({ children }) {
  const ref = useRef(null);
  useEffect(() => {
    ref.current?.showModal();
    return () => ref.current?.close();
  }, []);
  return <dialog ref={ref} aria-labelledby="overage-title" className="m-auto w-[min(94vw,36rem)] rounded-2xl p-8 shadow-xl backdrop:bg-black/50" onCancel={() => { location.href = "/vault"; }}>
    {children}
    <p className="mt-4"><a href="/vault">Return to vault</a></p>
  </dialog>;
}
