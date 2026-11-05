import type { Metadata } from "next";
import { currentClient } from "@/lib/client";
import { owned } from "@/lib/phone-numbers";
import { supabaseServer } from "@/lib/supabase/server";
import { NumbersPanel } from "./numbers-panel";

export const metadata: Metadata = { title: "Phone numbers" };

export default async function NumbersPage() {
  const supabase = await supabaseServer();
  const { data: claims } = await supabase.auth.getClaims();
  const { data: ownerRows } = await supabase
    .from("account_members").select("account_id").eq("user_id", claims?.claims?.sub ?? "").eq("role", "owner");

  if (!ownerRows?.length) {
    return (
      <section className="mx-auto max-w-3xl">
        <h1 className="mb-2 text-2xl font-semibold tracking-tight">Phone numbers</h1>
        <p className="glass p-6 text-muted">Only a workspace owner can rent or change phone numbers, because it costs money.</p>
      </section>
    );
  }

  const { current } = await currentClient(supabase);
  const { data: agents } = await supabase.from("agents").select("id, name, published_version_id").eq("account_id", current?.id ?? "").order("name");
  let mine: Awaited<ReturnType<typeof owned>> = [];
  let loadError: string | null = null;
  try {
    mine = await owned();
  } catch {
    loadError = "We couldn't load your numbers from the phone service. Try again in a minute.";
  }
  const names = new Map((agents ?? []).map((a) => [a.id, a.name as string]));
  const mineIds = new Set((agents ?? []).map((a) => a.id as string));
  const others = mine.filter((n) => n.agentId && !mineIds.has(n.agentId)).length;
  mine = mine.filter((n) => !n.agentId || mineIds.has(n.agentId)); // this client's numbers, and numbers not given to anyone yet

  return (
    <section aria-labelledby="numbers-h" className="mx-auto max-w-3xl space-y-4">
      <div>
        <h1 id="numbers-h" className="text-2xl font-semibold tracking-tight">Phone numbers</h1>
        <p className="mt-1 text-sm text-muted">
          Rent a number for {current?.name ?? "this client"}, choose which of its agents answers it, and anyone who calls it talks to that agent.
          {others > 0 && ` ${others} other ${others === 1 ? "number belongs" : "numbers belong"} to other clients and ${others === 1 ? "is" : "are"} shown inside them.`}
        </p>
      </div>
      {loadError && <p role="alert" className="text-sm text-danger">{loadError}</p>}
      <NumbersPanel
        owned={mine.map((n) => ({ e164: n.e164, status: n.status, agentId: n.agentId, agentName: n.agentId ? (names.get(n.agentId) ?? "an agent that was removed") : null }))}
        agents={(agents ?? []).filter((a) => a.published_version_id).map((a) => ({ id: a.id as string, name: a.name as string }))}
      />
    </section>
  );
}
