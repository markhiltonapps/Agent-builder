import "server-only";
import { env } from "./env";

export interface VotelClient {
  id: string;
  name: string;
  email: string;
  phone: string;
}

const NOT_CONNECTED = "Votel isn't connected yet.";
const UNREACHABLE = "We couldn't reach Votel just now. Try again in a minute.";

async function builder(path: string, init?: { body: unknown }): Promise<{ ok: true; body: Record<string, unknown> } | { ok: false; error: string }> {
  try {
    const res = await fetch(`${env.builderApiUrl}${path}`, {
      method: init ? "POST" : "GET",
      headers: { Authorization: `Bearer ${env.builderApiSecret}`, ...(init ? { "Content-Type": "application/json" } : {}) },
      body: init ? JSON.stringify(init.body) : undefined,
      cache: "no-store",
      signal: AbortSignal.timeout(30_000),
    });
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (res.ok && body.ok) return { ok: true, body };
    if (res.status === 503) return { ok: false, error: NOT_CONNECTED };
    return { ok: false, error: typeof body.error === "string" && res.status === 502 ? `Votel said: ${body.error.replace(/^[a-z_]+: /, "")}` : UNREACHABLE };
  } catch {
    return { ok: false, error: UNREACHABLE };
  }
}

/** The Votel contacts tagged as clients. */
export async function listVotelClients(): Promise<{ ok: true; tag: string; clients: VotelClient[] } | { ok: false; error: string }> {
  const r = await builder("/v1/votel/clients");
  return r.ok ? { ok: true, tag: String(r.body.tag), clients: r.body.clients as VotelClient[] } : r;
}

/** One tagged Votel contact, named by its company when it has one. */
export async function getVotelClient(contactId: string): Promise<{ ok: true; client: VotelClient } | { ok: false; error: string }> {
  const r = await builder("/v1/votel/client", { body: { contact_id: contactId } });
  return r.ok ? { ok: true, client: r.body.client as VotelClient } : r;
}

/** Make sure a client has a tagged contact in Votel; returns the contact's id. */
export async function pushVotelClient(o: { name: string; email?: string; phone?: string; contactId?: string | null }): Promise<{ ok: true; contactId: string } | { ok: false; error: string }> {
  const r = await builder("/v1/votel/client-push", {
    body: { name: o.name, email: o.email || undefined, phone: o.phone || undefined, contact_id: o.contactId || undefined, app_url: process.env.APP_URL || undefined },
  });
  return r.ok ? { ok: true, contactId: String(r.body.contact_id) } : r;
}

/** Take a client's contact out of the client list in Votel: remove its tag, or delete it (Votel hides it everywhere and its app cannot restore it). */
export async function removeVotelClient(contactId: string, mode: "untag" | "delete"): Promise<{ ok: true; result: string } | { ok: false; error: string }> {
  const r = await builder("/v1/votel/client-remove", { body: { contact_id: contactId, mode } });
  return r.ok ? { ok: true, result: String(r.body.result) } : r;
}
