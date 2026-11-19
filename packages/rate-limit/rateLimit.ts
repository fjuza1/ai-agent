// Plain (non-discriminated) shape so it also narrows correctly in apps compiled with `strict: false`.
export type RateLimitResult = { ok: boolean; retryAfterSeconds: number };

type Options = {
  /** Attempts allowed per window. */
  limit: number;
  windowMs: number;
  /** Each repeated violation doubles the lockout up to this cap. */
  maxLockoutMs?: number;
  maxKeys?: number;
  now?: () => number;
};

type Entry = { count: number; resetAt: number; lockedUntil: number; strikes: number };

/**
 * In-process fixed-window limiter with exponential lockout. State is per server
 * instance, so it bounds abuse on a single node; use a shared store (e.g. Redis)
 * if the app is scaled horizontally.
 */
export function createRateLimiter({ limit, windowMs, maxLockoutMs = windowMs * 16, maxKeys = 10_000, now = Date.now }: Options) {
  const entries = new Map<string, Entry>();

  function prune(at: number) {
    for (const [key, entry] of entries) {
      if (entry.resetAt <= at && entry.lockedUntil <= at) entries.delete(key);
    }
    // Still full of live entries: evict the oldest so memory stays bounded.
    while (entries.size >= maxKeys) entries.delete(entries.keys().next().value as string);
  }

  return {
    check(key: string): RateLimitResult {
      const at = now();
      let entry = entries.get(key);
      if (entry && entry.lockedUntil > at) return { ok: false, retryAfterSeconds: Math.ceil((entry.lockedUntil - at) / 1000) };
      if (!entry || entry.resetAt <= at) {
        // Strikes only carry over if the caller returns promptly after a lockout.
        const strikes = entry && at - entry.resetAt < windowMs ? entry.strikes : 0;
        if (!entry) prune(at);
        entry = { count: 0, resetAt: at + windowMs, lockedUntil: 0, strikes };
        entries.set(key, entry);
      }
      entry.count += 1;
      if (entry.count <= limit) return { ok: true, retryAfterSeconds: 0 };
      const lockout = Math.min(maxLockoutMs, windowMs * 2 ** entry.strikes);
      entry.strikes += 1;
      entry.lockedUntil = at + lockout;
      entry.resetAt = entry.lockedUntil;
      return { ok: false, retryAfterSeconds: Math.ceil(lockout / 1000) };
    },
    reset(key: string) {
      entries.delete(key);
    },
  };
}

/** Best-effort client address from proxy headers; falls back to a shared bucket. */
export function clientKey(headers: { get(name: string): string | null }): string {
  const forwarded = headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return forwarded || headers.get("x-real-ip")?.trim() || "unknown";
}
