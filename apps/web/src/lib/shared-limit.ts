import { env } from "./env.ts";
import { makeLimiter } from "./embed-code.ts";

// A visitor limit that holds across every copy of the web app. The count lives in the database
// (asked through the builder API, which holds the key), so adding copies does not multiply what
// one visitor is allowed. If the count cannot be reached the limit falls back to this copy's own
// memory, so a database problem never stops visitors and never leaves a door open: it only goes
// back to counting per copy. Deliberately not "server-only" so tests can import it.

export type Hit = (key: string, max: number, windowS: number) => Promise<boolean | null>;

/** One hit counted in the database. true = within the limit, false = over it, null = could not ask. */
export const remoteHit: Hit = async (key, max, windowS) => {
  try {
    const res = await fetch(`${env.builderApiUrl}/v1/limit/hit`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${env.builderApiSecret}` },
      body: JSON.stringify({ key, limit: max, window_s: windowS }),
      cache: "no-store",
      signal: AbortSignal.timeout(1500),
    });
    if (!res.ok) return null;
    const data = (await res.json().catch(() => null)) as { allowed?: unknown } | null;
    return typeof data?.allowed === "boolean" ? data.allowed : null;
  } catch {
    return null;
  }
};

/** At most `max` hits per `windowMs` per key, counted across all copies. `name` keeps limits apart. */
export function sharedLimiter(name: string, max: number, windowMs: number, hit: Hit = remoteHit) {
  const local = makeLimiter(max, windowMs);
  const windowS = Math.max(1, Math.round(windowMs / 1000));
  return async (key: string): Promise<boolean> => {
    const shared = await hit(`${name}:${key}`, max, windowS);
    return shared ?? local(key);
  };
}
