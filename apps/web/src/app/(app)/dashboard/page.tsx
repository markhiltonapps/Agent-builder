import type { Metadata } from "next";
import { cookies } from "next/headers";
import Link from "next/link";
import { redirect } from "next/navigation";
import { ByAgent, Numbers, step } from "@/components/dashboard-view";
import { LocalTime } from "@/components/local-time";
import { TimeZoneCookie } from "@/components/time-zone-cookie";
import { currentClient } from "@/lib/client";
import { type DashboardStats, PERIODS, parseDays, safeTimeZone } from "@/lib/dashboard";
import { duration } from "@/lib/format";
import { supabaseServer } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Dashboard" };

export default async function DashboardPage({ searchParams }: PageProps<"/dashboard">) {
  const sp = await searchParams;
  const days = parseDays(sp.days);
  const customersOnly = sp.source === "customers";
  const tz = safeTimeZone((await cookies()).get("tz")?.value);

  const supabase = await supabaseServer();
  const { current } = await currentClient(supabase);
  if (!current) redirect("/agents"); // a new person names their workspace there first
  const [{ data: stats }, { data: recent }] = await Promise.all([
    supabase.rpc("dashboard_stats", { p_days: days, p_phone_only: customersOnly, p_tz: tz, p_account: current.id }),
    supabase
      .from("calls")
      .select("id, started_at, duration_s, goal_reached, transferred, summary, agent:agents(name)")
      .eq("account_id", current.id)
      .order("started_at", { ascending: false })
      .limit(5),
  ]);
  const s = stats as DashboardStats | null;

  const href = (d: number, customers: boolean) => `/dashboard?days=${d}${customers ? "&source=customers" : ""}`;
  const pill = (active: boolean) =>
    `nav-pill px-3 py-2 text-sm focus-visible:outline-2 focus-visible:outline-accent ${active ? "" : "text-muted hover:text-text"}`;

  return (
    <section aria-labelledby="dash-h" className="mx-auto max-w-5xl space-y-6">
      <TimeZoneCookie current={tz} />
      <div className="rise flex flex-wrap items-end justify-between gap-3" style={step(0)}>
        <div>
          <h1 id="dash-h" className="text-2xl font-semibold tracking-tight">Dashboard</h1>
          <p className="mt-1 text-sm text-muted">How {current.name} is doing. <Link href="/clients" className="link">See all clients</Link></p>
        </div>
        <div className="flex flex-wrap gap-x-4 gap-y-2">
          <nav aria-label="Time period" className="flex gap-1">
            {PERIODS.map((d) => (
              <Link key={d} href={href(d, customersOnly)} aria-current={d === days ? "true" : undefined} className={pill(d === days)}>
                Last {d} days
              </Link>
            ))}
          </nav>
          <nav aria-label="Which calls" className="flex gap-1">
            <Link href={href(days, false)} aria-current={!customersOnly ? "true" : undefined} className={pill(!customersOnly)}>All calls</Link>
            <Link href={href(days, true)} aria-current={customersOnly ? "true" : undefined} className={pill(customersOnly)}>Customer calls only</Link>
          </nav>
        </div>
      </div>

      {!s ? (
        <p role="alert" className="glass p-6 text-muted">We couldn&apos;t load the numbers. Refresh the page, or try again in a minute.</p>
      ) : s.totals.calls === 0 ? (
        <p className="glass p-6 text-muted">
          No {customersOnly ? "customer " : ""}calls in the last {days} days. Open an agent and choose{" "}
          <strong className="font-medium text-text">Test call</strong> to see numbers appear here.
        </p>
      ) : (
        <Numbers s={s} />
      )}

      {s && s.totals.calls > 0 && s.agents.length > 0 && <ByAgent stats={s} step={8} linkAgents />}

      {!!recent?.length && (
        <section aria-labelledby="recent-h" className="rise space-y-3" style={step(9)}>
          <div className="flex items-baseline justify-between gap-2">
            <h2 id="recent-h" className="text-lg font-medium">Latest calls</h2>
            <Link href="/calls" className="link text-sm">See all calls</Link>
          </div>
          <ul className="glass divide-y divide-line overflow-hidden">
            {recent.map((c) => {
              const agent = c.agent as unknown as { name: string } | null;
              return (
                <li key={c.id}>
                  <Link
                    href={`/calls/${c.id}`}
                    className="block px-4 py-3 transition-colors hover:bg-white/5 focus-visible:outline-2 focus-visible:outline-accent"
                  >
                    <span className="flex flex-wrap items-center justify-between gap-2">
                      <span className="font-medium">{agent?.name ?? "Deleted agent"}</span>
                      <span className="flex items-center gap-2 text-sm">
                        {c.goal_reached && <span className="chip chip-live">Successful</span>}
                        {c.transferred && <span className="chip">Transferred</span>}
                        <span className="tabular-nums text-muted">{duration(Number(c.duration_s))}</span>
                      </span>
                    </span>
                    <LocalTime iso={c.started_at} className="text-xs text-faint" />
                    {c.summary && <span className="mt-1 line-clamp-2 block text-sm text-muted">{c.summary}</span>}
                  </Link>
                </li>
              );
            })}
          </ul>
        </section>
      )}
    </section>
  );
}
