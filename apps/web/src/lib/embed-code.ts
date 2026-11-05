// Website embed: cleaning up the sites an owner types, and the code they copy onto their page.
// Pure functions only, so they are easy to test. The same site rule is enforced in the database.

const SITE = /^https?:\/\/(\*\.)?[a-z0-9]([a-z0-9.-]*[a-z0-9])?(:[0-9]{1,5})?$/;
const LOCAL = /^http:\/\/(localhost|127\.0\.0\.1)(:[0-9]{1,5})?$/;

export const MAX_SITES = 20;

/** "Example.com/shop" -> "https://example.com". Null when it is not a site address. */
export function normalizeSite(input: string): string | null {
  let s = input.trim().toLowerCase();
  if (!s || /\s/.test(s)) return null; // a space inside means it is not one address
  if (!/^[a-z]+:\/\//.test(s)) s = `https://${s}`;
  const m = s.match(/^(https?:\/\/[^/?#\s]+)/);
  if (!m) return null;
  const origin = m[1];
  if (!SITE.test(origin)) return null;
  if (origin.startsWith("http://") && !LOCAL.test(origin)) return null; // plain http is for local testing only
  return origin;
}

/** One site per line (commas and spaces work too). Duplicates are dropped; bad entries are returned. */
export function parseSites(text: string): { sites: string[]; bad: string[] } {
  const sites: string[] = [];
  const bad: string[] = [];
  for (const raw of text.split(/[\s,]+/).filter(Boolean)) {
    const site = normalizeSite(raw);
    if (!site) bad.push(raw);
    else if (!sites.includes(site)) sites.push(site);
  }
  return { sites, bad };
}

/**
 * The header that decides which pages may show the embed in a frame. An empty list means the
 * owner left the sites blank, so any website may show it. A list that has entries but none valid
 * shows it nowhere.
 */
export function frameAncestors(origins: string[]): string {
  if (origins.length === 0) return "frame-ancestors *";
  const ok = origins.filter((o) => SITE.test(o));
  // 'self' lets this app show the call box itself (the Try a real call test on the Put on website page).
  return `frame-ancestors 'self'${ok.length ? ` ${ok.join(" ")}` : ""}`;
}

/**
 * Is this request from our own pages? The embed page calls our start route, so Origin must be one of
 * our own addresses (the configured one, or the one this request arrived on, since the app can be
 * reached at more than one address).
 */
export function isSameOrigin(originHeader: string | null, ours: string | string[]): boolean {
  return originHeader !== null && (Array.isArray(ours) ? ours : [ours]).includes(originHeader);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (v: string) => UUID.test(v);

/**
 * A small in-memory limiter: at most `max` hits per `windowMs` per key. It resets when the
 * server restarts, which is fine: it only slows down one visitor; the daily cap per agent is
 * what protects the bill, and that one lives in the database.
 */
export function makeLimiter(max: number, windowMs: number, now: () => number = Date.now) {
  const hits = new Map<string, number[]>();
  return (key: string): boolean => {
    const t = now();
    const recent = (hits.get(key) ?? []).filter((x) => t - x < windowMs);
    if (recent.length >= max) {
      hits.set(key, recent);
      return false;
    }
    recent.push(t);
    hits.set(key, recent);
    if (hits.size > 5000) for (const [k, v] of hits) if (!v.some((x) => t - x < windowMs)) hits.delete(k);
    return true;
  };
}
