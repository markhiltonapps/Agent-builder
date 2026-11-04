import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { env } from "./env";

/**
 * Send one agent's details to Votel's "Agent Builder OS" board (through the builder API).
 * Best effort: the callers never wait on this and never fail because of it.
 */
export async function pushCard(supabase: SupabaseClient, agentId: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const { data: agent } = await supabase
      .from("agents")
      .select("id, name, account_id, published_version_id, votel_task_id")
      .eq("id", agentId)
      .maybeSingle();
    if (!agent) return { ok: false, error: "That agent was not found." };

    const [{ data: account }, { data: live }, { data: latest }] = await Promise.all([
      supabase.from("accounts").select("name").eq("id", agent.account_id).maybeSingle(),
      agent.published_version_id
        ? supabase.from("agent_versions").select("version, config").eq("id", agent.published_version_id).maybeSingle()
        : Promise.resolve({ data: null }),
      supabase
        .from("agent_versions")
        .select("config")
        .eq("agent_id", agentId)
        .order("version", { ascending: false })
        .limit(1)
        .maybeSingle(),
    ]);
    const persona = ((live?.config ?? latest?.config) as { persona?: Record<string, string> } | null)?.persona ?? {};

    const res = await fetch(`${env.builderApiUrl}/v1/directory/sync`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${env.builderApiSecret}` },
      body: JSON.stringify({
        agent_id: agent.id,
        name: agent.name,
        workspace: account?.name ?? "",
        business: persona.business_name ?? "",
        about: persona.business_description ?? "",
        live_version: live?.version ?? null,
        app_url: process.env.APP_URL ?? "",
        task_id: agent.votel_task_id ?? undefined,
      }),
      cache: "no-store",
      signal: AbortSignal.timeout(60_000),
    });
    const body = await res.json().catch(() => ({}));
    if (res.ok && body.ok) {
      // Remember the card so the next sync updates it directly instead of searching for it.
      if (typeof body.task_id === "string" && body.task_id !== agent.votel_task_id) {
        await supabase.rpc("set_votel_task_id", { p_agent: agent.id, p_task: body.task_id });
      }
      return { ok: true };
    }
    return { ok: false, error: typeof body.error === "string" ? body.error : "Votel did not accept it." };
  } catch {
    return { ok: false, error: "Couldn't reach Votel." };
  }
}
