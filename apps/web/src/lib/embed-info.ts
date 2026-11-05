import { env } from "./env";

// What the public embed needs to know about an agent, from the builder API (which holds the
// database key). Deliberately not "server-only": the proxy file uses it too.

export type EmbedInfo = {
  name: string;
  business: string;
  enabled: boolean;
  origins: string[];
  published: boolean;
};

const TTL_MS = 30_000;
const cache = new Map<string, { at: number; info: EmbedInfo | null }>();

/** The agent's embed settings, null if there is no such agent, or "error" if we couldn't ask. */
export async function embedInfo(agentId: string): Promise<EmbedInfo | null | "error"> {
  const hit = cache.get(agentId);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.info;
  try {
    const res = await fetch(`${env.builderApiUrl}/v1/embed/info?agent_id=${encodeURIComponent(agentId)}`, {
      headers: { Authorization: `Bearer ${env.builderApiSecret}` },
      cache: "no-store",
      signal: AbortSignal.timeout(8_000),
    });
    if (res.status === 404) return remember(agentId, null);
    if (!res.ok) return "error";
    return remember(agentId, (await res.json()) as EmbedInfo);
  } catch {
    return "error";
  }
}

function remember(agentId: string, info: EmbedInfo | null) {
  if (cache.size > 500) cache.clear();
  cache.set(agentId, { at: Date.now(), info });
  return info;
}

/** Forget what we know about one agent, so a settings change shows up right away. */
export function forgetEmbedInfo(agentId: string) {
  cache.delete(agentId);
}

export type BeginStatus = "ok" | "disabled" | "unpublished" | "limit" | "error";

/** Count one embedded call against the agent's daily cap. */
export async function embedBegin(agentId: string): Promise<BeginStatus> {
  try {
    const res = await fetch(`${env.builderApiUrl}/v1/embed/begin`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${env.builderApiSecret}` },
      body: JSON.stringify({ agent_id: agentId }),
      cache: "no-store",
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) return "error";
    const { status } = (await res.json()) as { status: BeginStatus };
    return status;
  } catch {
    return "error";
  }
}
