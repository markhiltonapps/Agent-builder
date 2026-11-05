import type { Metadata } from "next";
import { openClient } from "@/app/actions";
import { LocalTime } from "@/components/local-time";
import { currentClient } from "@/lib/client";
import { duration } from "@/lib/format";
import { supabaseServer } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "All calls" };

const UUID = /^[0-9a-f-]{36}$/i;

export default async function AllCallsPage({ searchParams }: PageProps<"/all-calls">) {
  const { client: clientParam } = await searchParams;
  const supabase = await supabaseServer();
  const { clients } = await currentClient(supabase);
  const clientId = typeof clientParam === "string" && UUID.test(clientParam) && clients.some((c) => c.id === clientParam) ? clientParam : null;

  let query = supabase
    .from("calls")
    .select("id, account_id, started_at, duration_s, goal_reached, transferred, source, channel, agent:agents(name), client:accounts(name)")
    .order("started_at", { ascending: false })
    .limit(100);
  if (clientId) query = query.eq("account_id", clientId);
  const { data: calls } = await query;

  return (
    <section aria-labelledby="allcalls-h" className="mx-auto max-w-5xl space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 id="allcalls-h" className="text-2xl font-semibold tracking-tight">All calls</h1>
          <p className="mt-1 text-sm text-muted">The latest calls and chats across every client. Choose one to read it inside its client.</p>
        </div>
        {clients.length > 1 && (
          <form method="get" className="flex items-center gap-2 text-sm">
            <label className="flex items-center gap-2">
              <span className="text-muted">Client</span>
              <select name="client" defaultValue={clientId ?? ""} className="field !w-auto max-w-[14rem] !rounded-full !py-1.5 text-sm">
                <option value="">All clients</option>
                {clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </label>
            <button className="btn">Show</button>
          </form>
        )}
      </div>

      {!calls?.length ? (
        <p className="glass p-6 text-muted">No calls yet{clientId ? " for this client" : ""}.</p>
      ) : (
        <ul className="glass divide-y divide-line overflow-hidden">
          {calls.map((c) => {
            const agent = c.agent as unknown as { name: string } | null;
            const client = c.client as unknown as { name: string } | null;
            return (
              <li key={c.id}>
                <form action={openClient}>
                  <input type="hidden" name="account_id" value={c.account_id as string} />
                  <input type="hidden" name="to" value={`/calls/${c.id}`} />
                  <button className="flex w-full flex-wrap items-center justify-between gap-3 px-4 py-3 text-left transition-colors hover:bg-white/5 focus-visible:outline-2 focus-visible:outline-accent">
                    <span className="min-w-0">
                      <span className="block truncate font-medium">{client?.name ?? "A client"} <span className="font-normal text-muted">· {agent?.name ?? "Deleted agent"}</span></span>
                      <LocalTime iso={c.started_at as string} className="text-xs text-faint" />
                    </span>
                    <span className="flex flex-wrap items-center gap-2 text-sm">
                      {c.goal_reached && <span className="chip chip-live">Successful</span>}
                      {c.transferred && <span className="chip">Transferred</span>}
                      <span className="chip">{c.channel === "chat" ? "Website chat" : c.source === "phone" ? "Phone" : c.source === "web" ? "Website" : "Test call"}</span>
                      <span className="w-14 text-right tabular-nums text-muted">{c.channel === "chat" ? "-" : duration(Number(c.duration_s))}</span>
                    </span>
                  </button>
                </form>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
