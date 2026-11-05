import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { LocalTime } from "@/components/local-time";
import { VoiceStatusLine } from "@/components/voice-status";
import { currentClient } from "@/lib/client";
import { supabaseServer } from "@/lib/supabase/server";
import { CreateAccountForm, SyncVotelButton } from "./forms";

export const metadata: Metadata = { title: "Agents" };

export default async function AgentsPage() {
  const supabase = await supabaseServer();
  const { current } = await currentClient(supabase);
  const { data: agents } = current
    ? await supabase
        .from("agents")
        .select("id, name, updated_at, published:agent_versions!agents_published_fk(version)")
        .eq("account_id", current.id)
        .order("updated_at", { ascending: false })
    : { data: null };

  const { count: knowledgeCount } = current
    ? await supabase.from("knowledge_docs").select("id", { count: "exact", head: true }).eq("account_id", current.id)
    : { count: 0 };

  if (!current) {
    return (
      <section className="glass mx-auto mt-10 max-w-lg p-6">
        <h1 className="mb-1 text-xl font-semibold">Name your workspace</h1>
        <p className="mb-5 text-sm text-muted">
          Agents live in a workspace. This is usually your company name.
        </p>
        <CreateAccountForm />
      </section>
    );
  }

  const account = current;
  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
      <section aria-labelledby="agents-h">
        <h1 id="agents-h" className="text-2xl font-semibold tracking-tight">Agents</h1>
        <p className="mt-1 text-sm text-muted">
          {account.name} ·{" "}
          <Link href="/knowledge" className="link">
            Knowledge: {knowledgeCount ? `${knowledgeCount} document${knowledgeCount === 1 ? "" : "s"}` : "none yet"}
          </Link>
        </p>
        <div className="mb-4 mt-3 space-y-2"><SyncVotelButton /><Suspense fallback={<p className="text-xs text-faint">Checking the voice service…</p>}><VoiceStatusLine /></Suspense></div>
        {agents?.length ? (
          <ul className="grid gap-3 sm:grid-cols-2">
            {agents.map((a) => {
              const published = (a.published as unknown as { version: number } | null)?.version;
              return (
                <li key={a.id}>
                  <Link
                    href={`/agents/${a.id}`}
                    className="glass block p-5 transition-colors hover:bg-white/[0.09] focus-visible:outline-2 focus-visible:outline-accent"
                  >
                    <div className="mb-3 flex items-center justify-between gap-2">
                      <h2 className="truncate font-medium">{a.name}</h2>
                      {published ? (
                        <span className="chip chip-live whitespace-nowrap">Live: version {published}</span>
                      ) : (
                        <span className="chip whitespace-nowrap">Not live yet</span>
                      )}
                    </div>
                    <p className="text-xs text-faint">Edited <LocalTime iso={a.updated_at} /></p>
                  </Link>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="glass p-6 text-muted">
            No agents yet. Choose a ready-made agent for your kind of business and you&apos;ll have something to edit and test in a minute.
          </p>
        )}
      </section>

      <aside className="glass h-fit p-5 lg:sticky lg:top-20" aria-labelledby="new-h">
        <h2 id="new-h" className="mb-2 font-medium">New agent</h2>
        <p className="mb-4 text-sm text-muted">
          Start from a ready-made agent for your kind of business, with the right questions and safety rules already in.
        </p>
        <div className="space-y-2">
          <Link href="/agents/new" className="btn btn-primary w-full">Choose a ready-made agent</Link>
          <Link href="/agents/new?tab=ai" className="btn w-full">Describe it and let AI draft it</Link>
        </div>
      </aside>
    </div>
  );
}
