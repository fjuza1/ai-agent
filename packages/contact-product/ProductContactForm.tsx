"use client";

import { useState, type FormEvent } from "react";

type Props = { productId: string; productTitle: string; productUrl: string };

export default function ProductContactForm({ productId, productTitle, productUrl }: Props) {
  const [status, setStatus] = useState<"idle" | "loading" | "success" | "error">("idle");

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (status === "loading") return;
    const form = event.currentTarget;
    setStatus("loading");
    try {
      const result = await fetch("/api/contact-product", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(Object.fromEntries(new FormData(form))),
      });
      if (!result.ok) throw new Error("Submission failed");
      form.reset();
      setStatus("success");
    } catch {
      setStatus("error");
    }
  }

  return <section className="mt-10 max-w-xl" aria-labelledby="product-contact-heading">
    <h2 id="product-contact-heading" className="text-2xl font-bold">Contact us</h2>
    <p className="mt-2">Have a question about this product? Send us a message.</p>
    <form onSubmit={submit} className="mt-4 grid gap-4" aria-busy={status === "loading"}>
      <input type="hidden" name="productId" value={productId} />
      <input type="hidden" name="productTitle" value={productTitle} />
      <input type="hidden" name="productUrl" value={productUrl} />
      <div className="hidden" aria-hidden="true">
        <label>Website<input name="website" tabIndex={-1} autoComplete="off" /></label>
      </div>
      <label className="grid gap-1">Name<input name="name" autoComplete="name" required maxLength={100} /></label>
      <label className="grid gap-1">Email<input name="email" type="email" autoComplete="email" required maxLength={254} /></label>
      <label className="grid gap-1">Message<textarea name="message" required maxLength={5000} rows={5} className="w-full rounded-lg border p-3 bg-white" /></label>
      <button type="submit" disabled={status === "loading"} className="justify-self-start disabled:opacity-60 disabled:cursor-wait">
        {status === "loading" ? "Sending..." : "Send message"}
      </button>
      <p role="status" aria-live="polite">
        {status === "success" && "Your message has been sent. Thank you!"}
        {status === "error" && "Your message could not be sent. Please try again later."}
      </p>
    </form>
  </section>;
}
