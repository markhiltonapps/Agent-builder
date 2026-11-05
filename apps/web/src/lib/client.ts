import "server-only";
import { cookies } from "next/headers";
import type { SupabaseClient } from "@supabase/supabase-js";

export interface Client { id: string; name: string }

/** The workspaces (clients) this person belongs to, and the one they are working in now. */
export async function currentClient(supabase: SupabaseClient): Promise<{ clients: Client[]; current: Client | null }> {
  const { data } = await supabase.from("accounts").select("id, name").order("created_at");
  const clients = (data ?? []) as Client[];
  const picked = (await cookies()).get("client")?.value;
  return { clients, current: clients.find((c) => c.id === picked) ?? clients[0] ?? null };
}
