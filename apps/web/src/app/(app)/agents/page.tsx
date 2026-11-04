import type { Metadata } from "next";
import Link from "next/link";
import { LocalTime } from "@/components/local-time";
import { supabaseServer } from "@/lib/supabase/server";
import { TEMPLATES } from "@/lib/templates";
import { CreateAccountForm, CreateAgentForm } from "./forms";

export const metadata: Metadata = { title: "Agents" };

export default async function AgentsPage() {
  const supabase = await supabaseServer();
  const [{ data: accounts }, { data: agents }] = await Promise.all([
    supabase.from("accounts").select("id, name").order("created_at"),
    supabase
      .from("agents")
      .select("id, name, updated_at, published:agent_versions!agents_published_fk(version)")
      .order("updated_at", { ascending: false }),
  ]);

  if (!accounts?.length) {
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

  const account = accounts[0];
  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
      <section aria-labelledby="agents-h">
        <h1 id="agents-h" className="text-2xl font-semibold tracking-tight">Agents</h1>
        <p className="mb-4 mt-1 text-sm text-muted">{account.name}</p>
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
            No agents yet. Choose how to start in the form, name your agent, and you&apos;ll have a working agent to edit and test.
          </p>
        )}
      </section>

      <aside className="glass h-fit p-5 lg:sticky lg:top-20" aria-labelledby="new-h">
        <h2 id="new-h" className="mb-4 font-medium">New agent</h2>
        <CreateAgentForm accountId={account.id} templates={TEMPLATES.map(({ key, label, blurb }) => ({ key, label, blurb }))} />
      </aside>
    </div>
  );
}
