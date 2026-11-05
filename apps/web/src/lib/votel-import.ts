import "server-only";
import { env } from "./env";

export interface VotelAgent {
  id: string;
  name: string;
  status: string;
  channels: string;
}

/** The AI agents in the connected Votel account, or a plain reason we couldn't list them. */
export async function listVotelAgents(): Promise<{ ok: true; agents: VotelAgent[] } | { ok: false; error: string }> {
  try {
    const res = await fetch(`${env.builderApiUrl}/v1/votel/agents`, {
      headers: { Authorization: `Bearer ${env.builderApiSecret}` },
      cache: "no-store",
      signal: AbortSignal.timeout(30_000),
    });
    const body = await res.json().catch(() => ({}));
    if (res.ok && body.ok) return { ok: true, agents: body.agents as VotelAgent[] };
    return { ok: false, error: res.status === 503 ? "Votel isn't connected yet." : "We couldn't reach Votel just now. Try again in a minute." };
  } catch {
    return { ok: false, error: "We couldn't reach Votel just now. Try again in a minute." };
  }
}

/** Ask the builder to turn one Votel agent into a draft configuration (this takes a while). */
export async function importVotelAgent(agentId: string): Promise<{ ok: true; name: string; config: unknown } | { ok: false; error: string }> {
  try {
    const res = await fetch(`${env.builderApiUrl}/v1/votel/import`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${env.builderApiSecret}` },
      body: JSON.stringify({ agent_id: agentId }),
      cache: "no-store",
      signal: AbortSignal.timeout(180_000),
    });
    const body = await res.json().catch(() => ({}));
    if (res.ok && body.ok) return { ok: true, name: String(body.name), config: body.config };
    return { ok: false, error: typeof body.error === "string" ? body.error : "The import didn't work. Try again." };
  } catch {
    return { ok: false, error: "The import took too long. Try again." };
  }
}

export interface VotelBookable {
  id: string;
  name: string;
  status: string;
  kind: string;
  minutes: number;
}

/** The booking services in the connected Votel account, for choosing where appointments go. */
export async function listVotelBookables(accountId?: string): Promise<{ ok: true; bookables: VotelBookable[] } | { ok: false; error: string }> {
  try {
    const res = await fetch(`${env.builderApiUrl}/v1/votel/bookables${accountId ? `?account_id=${encodeURIComponent(accountId)}` : ""}`, {
      headers: { Authorization: `Bearer ${env.builderApiSecret}` },
      cache: "no-store",
      signal: AbortSignal.timeout(30_000),
    });
    const body = await res.json().catch(() => ({}));
    if (res.ok && body.ok) return { ok: true, bookables: body.bookables as VotelBookable[] };
    return { ok: false, error: res.status === 503 ? "Votel isn't connected yet." : "We couldn't reach Votel just now. Try again in a minute." };
  } catch {
    return { ok: false, error: "We couldn't reach Votel just now. Try again in a minute." };
  }
}

/** Whether a client has its own Votel sub-account connected (never the key itself). */
export async function clientVotelStatus(accountId: string): Promise<{ connected: boolean; accountName: string; known: boolean }> {
  try {
    const res = await fetch(`${env.builderApiUrl}/v1/votel/client-key?account_id=${encodeURIComponent(accountId)}`, {
      headers: { Authorization: `Bearer ${env.builderApiSecret}` },
      cache: "no-store",
      signal: AbortSignal.timeout(8_000),
    });
    const body = await res.json().catch(() => ({}));
    if (res.ok && body.ok) return { connected: Boolean(body.connected), accountName: String(body.account_name ?? ""), known: true };
  } catch {
    /* fall through */
  }
  return { connected: false, accountName: "", known: false };
}
