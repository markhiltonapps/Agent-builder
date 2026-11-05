import { env } from "./env";

// Website chat, as the public embed page reaches it: thin calls to the builder API, which runs
// the agent. Deliberately not "server-only" so tests can import it.

export type ChatReason = "disabled" | "unpublished" | "limit" | "busy" | "gone" | "too_long" | "empty" | "try_again";

export type ChatResult<T> = ({ ok: true } & T) | { ok: false; reason: ChatReason };

async function builder<T>(path: string, body: unknown, timeoutMs: number): Promise<ChatResult<T>> {
  try {
    const res = await fetch(`${env.builderApiUrl}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${env.builderApiSecret}` },
      body: JSON.stringify(body),
      cache: "no-store",
      signal: AbortSignal.timeout(timeoutMs),
    });
    const data = (await res.json().catch(() => ({}))) as { ok?: boolean; reason?: ChatReason } & T;
    if (res.ok && data.ok) return data as { ok: true } & T;
    return { ok: false, reason: data.reason ?? "try_again" };
  } catch {
    return { ok: false, reason: "try_again" };
  }
}

export const chatStart = (agentId: string) => builder<{ session: string; greeting: string }>("/v1/chat/start", { agent_id: agentId }, 15_000);
export const chatSend = (session: string, message: string) => builder<{ reply: string }>("/v1/chat/send", { session, message }, 60_000);
export const chatEnd = (session: string) => builder<object>("/v1/chat/end", { session }, 20_000);

/** The status the website gets back for each reason. */
export const REASON_STATUS: Record<ChatReason, number> = {
  disabled: 404, unpublished: 409, limit: 429, busy: 503, gone: 410, too_long: 413, empty: 400, try_again: 502,
};

export const SESSION = /^[0-9a-f]{32}$/;
export const MAX_MESSAGE = 1000;
