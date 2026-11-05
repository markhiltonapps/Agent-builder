import type { Metadata } from "next";
import Link from "next/link";
import { LocalTime } from "@/components/local-time";
import { duration } from "@/lib/format";
import { currentClient } from "@/lib/client";
import { supabaseServer } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Calls" };

const UUID = /^[0-9a-f-]{36}$/i;

export default async function CallsPage({ searchParams }: PageProps<"/calls">) {
  const { agent: agentParam } = await searchParams;
  const agentId = typeof agentParam === "string" && UUID.test(agentParam) ? agentParam : null;

  const supabase = await supabaseServer();
  const { current } = await currentClient(supabase);
  let query = supabase
    .from("calls")
    .select("id, started_at, duration_s, goal_reached, transferred, source, agent_version, agent:agents(id, name)")
    .order("started_at", { ascending: false })
    .limit(100);
  if (current) query = query.eq("account_id", current.id);
  if (agentId) query = query.eq("agent_id", agentId);
  const { data: calls } = await query;

  const filteredName = agentId
    ? (calls?.[0]?.agent as unknown as { name: string } | undefined)?.name
    : undefined;

  return (
    <section aria-labelledby="calls-h" className="mx-auto max-w-4xl space-y-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h1 id="calls-h" className="text-2xl font-semibold tracking-tight">
          Calls{filteredName ? `: ${filteredName}` : ""}
        </h1>
        {agentId && <Link href="/calls" className="link text-sm">Show calls for all agents</Link>}
      </div>

      {!calls?.length ? (
        <p className="glass p-6 text-muted">
          No calls yet. Open an agent and choose <strong className="font-medium text-text">Test call</strong>. Every
          call is saved here with its transcript.
        </p>
      ) : (
        <ul className="glass divide-y divide-line overflow-hidden">
          {calls.map((c) => {
            const agent = c.agent as unknown as { id: string; name: string } | null;
            return (
              <li key={c.id}>
                <Link
                  href={`/calls/${c.id}`}
                  className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 transition-colors hover:bg-white/5 focus-visible:outline-2 focus-visible:outline-accent"
                >
                  <span className="min-w-0">
                    <span className="block truncate font-medium">{agent?.name ?? "Deleted agent"}</span>
                    <LocalTime iso={c.started_at} className="text-xs text-faint" />
                  </span>
                  <span className="flex flex-wrap items-center gap-2 text-sm">
                    {c.goal_reached && <span className="chip chip-live">Successful</span>}
                    {c.transferred && <span className="chip">Transferred</span>}
                    <span className="chip">{c.source === "phone" ? "Phone" : c.source === "web" ? "Website" : "Test call"}</span>
                    <span className="chip" title="Agent version">Version {c.agent_version ?? "?"}</span>
                    <span className="w-14 text-right tabular-nums text-muted">{duration(Number(c.duration_s))}</span>
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
