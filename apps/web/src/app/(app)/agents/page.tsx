import type { Metadata } from "next";
import Link from "next/link";
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
    <div className="grid gap-6 lg:grid-cols-[1fr_22rem]">
      <section aria-labelledby="agents-h">
        <div className="mb-4 flex items-baseline justify-between">
          <h1 id="agents-h" className="text-2xl font-semibold tracking-tight">Agents</h1>
          <span className="text-sm text-faint">{account.name}</span>
        </div>
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
                        <span className="chip chip-live">Live · v{published}</span>
                      ) : (
                        <span className="chip">Not published</span>
                      )}
                    </div>
                    <p className="text-xs text-faint">
                      Edited {new Date(a.updated_at).toLocaleDateString()}
                    </p>
                  </Link>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="glass p-6 text-muted">No agents yet. Start one from a template.</p>
        )}
      </section>

      <aside className="glass h-fit p-5" aria-labelledby="new-h">
        <h2 id="new-h" className="mb-4 font-medium">New agent</h2>
        <CreateAgentForm accountId={account.id} templates={TEMPLATES.map(({ key, label, blurb }) => ({ key, label, blurb }))} />
      </aside>
    </div>
  );
}
