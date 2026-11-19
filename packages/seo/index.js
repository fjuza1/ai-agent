export function siteOrigin(value, fallback) {
  const url = new URL(value || fallback);
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("Site URL must use HTTP or HTTPS.");
  return url.origin;
}

export function pageMetadata(origin, path, title, description, noindex = false) {
  const url = new URL(path, origin).toString();
  return {
    title,
    description,
    ...(noindex ? { robots: { index: false, follow: false } } : { alternates: { canonical: url } }),
    openGraph: { type: "website", title, description, url },
    twitter: { card: "summary", title, description },
  };
}

export function structuredData(value) {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}
