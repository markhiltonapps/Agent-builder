import type { Metadata } from "next";
import { currentClient } from "@/lib/client";
import { owned } from "@/lib/phone-numbers";
import { supabaseServer } from "@/lib/supabase/server";
import { AddClientForm, VotelPicker } from "./client-forms";
import { type ClientRow, ClientsTable } from "./clients-table";

export const metadata: Metadata = { title: "All clients" };

interface Overview { account_id: string; calls: number; voice_seconds: number | string; last_call: string | null; agents_total: number; agents_live: number }

export default async function ClientsPage() {
  const supabase = await supabaseServer();
  const { clients } = await currentClient(supabase);

  const [{ data: overview }, { data: members }, { data: agents }, numbersByAgent] = await Promise.all([
    supabase.rpc("clients_overview", { p_days: 30 }),
    supabase.from("account_members").select("account_id, role"),
    supabase.from("agents").select("id, account_id"),
    // phone numbers live with the phone service; if it cannot be asked the column shows a dash
    owned().then((n) => new Map(n.filter((x) => x.agentId).map((x) => [x.agentId as string, x.e164]))).catch(() => null),
  ]);
  const by = new Map(((overview ?? []) as Overview[]).map((o) => [o.account_id, o]));
  const role = new Map((members ?? []).map((m) => [m.account_id as string, m.role as string]));
  const agentAccount = new Map((agents ?? []).map((a) => [a.id as string, a.account_id as string]));
  const numbers = new Map<string, number>();
  for (const agentId of numbersByAgent?.keys() ?? []) {
    const acct = agentAccount.get(agentId);
    if (acct) numbers.set(acct, (numbers.get(acct) ?? 0) + 1);
  }

  const rows: ClientRow[] = clients.map((c) => {
    const o = by.get(c.id);
    return {
      id: c.id,
      name: c.name,
      role: role.get(c.id) ?? "",
      agentsLive: Number(o?.agents_live ?? 0),
      agentsTotal: Number(o?.agents_total ?? 0),
      calls: Number(o?.calls ?? 0),
      minutes: Math.round(Number(o?.voice_seconds ?? 0) / 60),
      numbers: role.get(c.id) === "owner" && numbersByAgent ? (numbers.get(c.id) ?? 0) : null,
      lastCall: o?.last_call ?? null,
    };
  });
  const totalCalls = rows.reduce((n, r) => n + r.calls, 0);
  const totalMinutes = rows.reduce((n, r) => n + r.minutes, 0);

  return (
    <section aria-labelledby="clients-h" className="mx-auto max-w-6xl space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 id="clients-h" className="text-2xl font-semibold tracking-tight">All clients</h1>
          <p className="mt-1 max-w-2xl text-sm text-muted">
            Every client you look after. Open one to work on its agents, knowledge, calls, phone numbers and settings.
          </p>
        </div>
        {rows.length > 0 && (
          <p className="text-sm text-muted" aria-label="Totals for the last 30 days">
            <strong className="font-medium text-text">{totalCalls.toLocaleString()}</strong> customer calls ·{" "}
            <strong className="font-medium text-text">{totalMinutes.toLocaleString()}</strong> minutes · last 30 days
          </p>
        )}
      </div>

      {rows.length > 0 ? (
        <ClientsTable rows={rows} />
      ) : (
        <p className="glass p-6 text-sm text-muted">You don&apos;t have a client yet. Add your first one below.</p>
      )}

      <div className="grid gap-3 lg:grid-cols-2">
        <aside className="glass p-5" aria-labelledby="add-h">
          <h2 id="add-h" className="mb-1 font-medium">Add a client</h2>
          <p className="mb-4 text-sm text-muted">A new, empty workspace for another business. You&apos;ll be its owner.</p>
          <AddClientForm />
        </aside>
        <aside className="glass p-5" aria-labelledby="votel-h">
          <h2 id="votel-h" className="mb-1 font-medium">Add from Votel</h2>
          <p className="mb-4 text-sm text-muted">
            In Votel, give a contact the tag <code>agent-builder-client</code>. Then check here and add it as a client.
          </p>
          <VotelPicker />
        </aside>
      </div>
    </section>
  );
}
