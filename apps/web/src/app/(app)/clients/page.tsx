import type { Metadata } from "next";
import { headers } from "next/headers";
import { openClient } from "@/app/actions";
import { LocalTime } from "@/components/local-time";
import { currentClient } from "@/lib/client";
import { type DashboardStats } from "@/lib/dashboard";
import { supabaseServer } from "@/lib/supabase/server";
import { AddClientForm, ShareControl } from "./client-forms";

export const metadata: Metadata = { title: "Clients" };

export default async function ClientsPage() {
  const supabase = await supabaseServer();
  const { clients, current } = await currentClient(supabase);
  const h = await headers();
  const proto = h.get("x-forwarded-proto") ?? "https";
  const appUrl = (process.env.APP_URL || `${proto}://${h.get("x-forwarded-host") ?? h.get("host")}`).replace(/\/$/, "");

  const [{ data: members }, { data: agents }, { data: tokens }, ...stats] = await Promise.all([
    supabase.from("account_members").select("account_id, role"),
    supabase.from("agents").select("account_id, published_version_id"),
    supabase.from("accounts").select("id, share_token"),
    ...clients.map((c) => supabase.rpc("dashboard_stats", { p_days: 30, p_account: c.id })),
  ]);
  const role = new Map((members ?? []).map((m) => [m.account_id as string, m.role as string]));
  const token = new Map((tokens ?? []).map((t) => [t.id as string, (t.share_token as string | null) ?? null]));

  return (
    <section aria-labelledby="clients-h" className="mx-auto max-w-5xl space-y-5">
      <div>
        <h1 id="clients-h" className="text-2xl font-semibold tracking-tight">Clients</h1>
        <p className="mt-1 max-w-2xl text-sm text-muted">
          Each client has its own agents, calls and numbers. Switch between them from the top bar, and give a client a
          private link to their own dashboard so they can see how their agents are doing.
        </p>
      </div>

      <ul className="grid gap-3 md:grid-cols-2">
        {clients.map((c) => {
          const s = stats[clients.indexOf(c)]?.data as DashboardStats | null;
          const mine = (agents ?? []).filter((a) => a.account_id === c.id);
          const live = mine.filter((a) => a.published_version_id).length;
          const owner = role.get(c.id) === "owner";
          return (
            <li key={c.id} className="glass flex flex-col gap-4 p-5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h2 className="truncate text-lg font-medium">{c.name}</h2>
                {c.id === current?.id && <span className="chip chip-live">Working in this client</span>}
              </div>
              <dl className="grid grid-cols-3 gap-3 text-sm">
                <div><dt className="text-faint">Agents</dt><dd className="text-xl font-semibold tabular-nums">{mine.length}</dd><dd className="text-xs text-muted">{live} live</dd></div>
                <div><dt className="text-faint">Calls</dt><dd className="text-xl font-semibold tabular-nums">{s?.totals.calls ?? 0}</dd><dd className="text-xs text-muted">last 30 days</dd></div>
                <div><dt className="text-faint">Your role</dt><dd className="text-xl font-semibold capitalize">{role.get(c.id) ?? "-"}</dd></div>
              </dl>
              <form action={openClient} className="flex flex-wrap gap-2">
                <input type="hidden" name="account_id" value={c.id} />
                <button className="btn btn-primary">Open this client</button>
              </form>
              {owner ? (
                <ShareControl accountId={c.id} initialToken={token.get(c.id) ?? null} appUrl={appUrl} />
              ) : (
                <p className="text-xs text-faint">Only the owner of a client can share its dashboard.</p>
              )}
            </li>
          );
        })}
      </ul>

      <aside className="glass max-w-xl p-5" aria-labelledby="add-h">
        <h2 id="add-h" className="mb-1 font-medium">Add a client</h2>
        <p className="mb-4 text-sm text-muted">A new, empty workspace for another business. You&apos;ll be its owner.</p>
        <AddClientForm />
      </aside>
      <p className="text-xs text-faint">Last updated <LocalTime iso={new Date().toISOString()} />.</p>
    </section>
  );
}
