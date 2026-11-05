// Checks an email address before it is ever handed to Supabase's sign-up. Every sign-up call sends a
// real confirmation email, and mail that bounces can get sending restricted for the whole project, so
// addresses that cannot receive mail are stopped here. The database enforces the invite list as well
// (the "Before User Created" hook); this layer only keeps obviously bad addresses from reaching it.

import { resolveMx } from "node:dns/promises";

/** Domains that can never receive real mail. Keep in step with hook_before_user_created (a test checks). */
export const BLOCKED_DOMAINS = ["example.com", "example.org", "example.net", "localhost", "tokbird.com"] as const;
const BLOCKED_SUFFIXES = [".test", ".invalid", ".example", ".localhost"];

const FORMAT = /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@.]{2,63}$/;

export function normalizeEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

export function isBlockedDomain(domain: string): boolean {
  const d = domain.toLowerCase();
  return !d.includes(".") || (BLOCKED_DOMAINS as readonly string[]).includes(d) || BLOCKED_SUFFIXES.some((s) => d.endsWith(s));
}

export type EmailCheck = { ok: true; email: string } | { ok: false; reason: "format" | "blocked" | "no_mail" | "unverified" };

type Resolver = (domain: string) => Promise<{ exchange: string }[]>;

const cache = new Map<string, { at: number; ok: boolean }>();
const TTL_MS = 10 * 60_000;

/** Does this domain publish a mail server? Fails closed: a lookup we cannot finish is treated as unverified. */
export async function domainCanReceiveMail(domain: string, resolver: Resolver = resolveMx, timeoutMs = 3000): Promise<boolean | "unverified"> {
  const hit = cache.get(domain);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.ok;
  try {
    const records = await Promise.race([
      resolver(domain),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), timeoutMs)),
    ]);
    const ok = records.some((r) => r.exchange && r.exchange !== ".");
    if (cache.size > 500) cache.clear();
    cache.set(domain, { at: Date.now(), ok });
    return ok;
  } catch (e) {
    const code = (e as { code?: string }).code;
    if (code === "ENOTFOUND" || code === "ENODATA") return false; // the domain or its mail records do not exist
    return "unverified";
  }
}

export async function checkSignupEmail(raw: string, resolver?: Resolver): Promise<EmailCheck> {
  const email = normalizeEmail(raw);
  if (email.length > 254 || !FORMAT.test(email)) return { ok: false, reason: "format" };
  const domain = email.slice(email.lastIndexOf("@") + 1);
  if (isBlockedDomain(domain)) return { ok: false, reason: "blocked" };
  const mail = await domainCanReceiveMail(domain, resolver);
  if (mail === "unverified") return { ok: false, reason: "unverified" };
  return mail ? { ok: true, email } : { ok: false, reason: "no_mail" };
}

/** What the person sees. The same wording for every refusal, so the form cannot be used to probe addresses. */
export function refusalMessage(reason: Exclude<EmailCheck, { ok: true }>["reason"]): string {
  return reason === "unverified"
    ? "We couldn't check that email address just now. Please try again in a few minutes."
    : "That email address can't be used. Check it, or ask Neato for an invitation.";
}
