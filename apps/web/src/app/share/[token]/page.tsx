import type { Metadata } from "next";
import { cookies } from "next/headers";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ByAgent, Numbers, step } from "@/components/dashboard-view";
import { TimeZoneCookie } from "@/components/time-zone-cookie";
import { type DashboardStats, PERIODS, parseDays, safeTimeZone } from "@/lib/dashboard";
import { supabaseServer } from "@/lib/supabase/server";

// A client's private dashboard. The link is the key; the page shows numbers only.
export const metadata: Metadata = {
  title: "Call dashboard",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

export default async function SharedDashboard({ params, searchParams }: PageProps<"/share/[token]">) {
  const { token } = await params;
  const days = parseDays((await searchParams).days);
  const tz = safeTimeZone((await cookies()).get("tz")?.value);
  const supabase = await supabaseServer();
  const { data } = await supabase.rpc("client_dashboard", { p_token: token, p_days: days, p_tz: tz });
  const view = data as { client: string; stats: DashboardStats } | null;
  if (!view) notFound();
  const s = view.stats;

  return (
    <main className="mx-auto w-full max-w-5xl space-y-6 px-4 pb-16 pt-8 sm:px-6">
      <TimeZoneCookie current={tz} />
      <div className="rise flex flex-wrap items-end justify-between gap-3" style={step(0)}>
        <div>
          <p className="text-sm text-muted">Call dashboard</p>
          <h1 className="text-2xl font-semibold tracking-tight">{view.client}</h1>
        </div>
        <nav aria-label="Time period" className="flex gap-1">
          {PERIODS.map((d) => (
            <Link key={d} href={`/share/${token}?days=${d}`} aria-current={d === days ? "true" : undefined}
              className={`nav-pill px-3 py-2 text-sm focus-visible:outline-2 focus-visible:outline-accent ${d === days ? "" : "text-muted hover:text-text"}`}>
              Last {d} days
            </Link>
          ))}
        </nav>
      </div>
      {s.totals.calls === 0 ? (
        <p className="glass p-6 text-muted">No calls in the last {days} days yet. They will show up here as they come in.</p>
      ) : (
        <>
          <Numbers s={s} />
          {s.agents.length > 0 && <ByAgent stats={s} step={8} />}
        </>
      )}
    </main>
  );
}
