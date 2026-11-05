import type { Metadata } from "next";
import { cookies } from "next/headers";
import Link from "next/link";
import { redirect } from "next/navigation";
import { CountUp } from "@/components/count-up";
import { LocalTime } from "@/components/local-time";
import { TimeZoneCookie } from "@/components/time-zone-cookie";
import { type DashboardStats, PERIODS, parseDays, percent, safeTimeZone, shortDay, spoken } from "@/lib/dashboard";
import { duration } from "@/lib/format";
import { supabaseServer } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Dashboard" };

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Position in the build-in sequence: each step starts a little after the one before. */
const step = (i: number) => ({ "--i": i }) as React.CSSProperties;

export default async function DashboardPage({ searchParams }: PageProps<"/dashboard">) {
  const sp = await searchParams;
  const days = parseDays(sp.days);
  const customersOnly = sp.source === "customers";
  const tz = safeTimeZone((await cookies()).get("tz")?.value);

  const supabase = await supabaseServer();
  const [{ data: stats }, { data: recent }, { data: accounts }] = await Promise.all([
    supabase.rpc("dashboard_stats", { p_days: days, p_phone_only: customersOnly, p_tz: tz }),
    supabase
      .from("calls")
      .select("id, started_at, duration_s, goal_reached, transferred, summary, agent:agents(name)")
      .order("started_at", { ascending: false })
      .limit(5),
    supabase.from("accounts").select("name").order("created_at").limit(1),
  ]);
  if (!accounts?.length) redirect("/agents"); // a new person names their workspace there first
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
          <p className="mt-1 text-sm text-muted">{accounts[0].name}</p>
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

      {s && s.totals.calls > 0 && s.agents.length > 0 && (
        <section aria-labelledby="by-agent-h" className="rise space-y-3" style={step(8)}>
          <h2 id="by-agent-h" className="text-lg font-medium">By agent</h2>
          <div className="glass overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="text-xs text-faint">
                <tr>
                  <th scope="col" className="px-2 py-3 font-medium sm:px-4">Agent</th>
                  <th scope="col" className="px-2 py-3 sm:px-4 text-right font-medium">Calls</th>
                  <th scope="col" className="px-2 py-3 sm:px-4 text-right font-medium">Reached their goal</th>
                  <th scope="col" className="px-2 py-3 sm:px-4 text-right font-medium">Handed to a person</th>
                  <th scope="col" className="px-2 py-3 sm:px-4 text-right font-medium">Average length</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {s.agents.map((a) => (
                  <tr key={a.agent_id}>
                    <th scope="row" className="px-2 py-3 sm:px-4 font-medium">
                      <Link href={`/calls?agent=${a.agent_id}`} className="link">{a.name}</Link>
                    </th>
                    <td className="px-2 py-3 sm:px-4 text-right tabular-nums">{a.calls}</td>
                    <td className="px-2 py-3 sm:px-4 text-right tabular-nums">{percent(a.successful, a.calls)}%</td>
                    <td className="px-2 py-3 sm:px-4 text-right tabular-nums">{a.transferred}</td>
                    <td className="px-2 py-3 sm:px-4 text-right tabular-nums">{duration(Number(a.avg_seconds))}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

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

function Numbers({ s }: { s: DashboardStats }) {
  const t = s.totals;
  const rate = percent(t.successful, t.calls);
  const tiles: { label: string; value: React.ReactNode; note: string }[] = [
    { label: "Calls", value: <CountUp to={t.calls} delayMs={250} />, note: `in the last ${s.days} days` },
    {
      label: "Reached their goal",
      value: rate === null ? "-" : <CountUp to={rate} kind="percent" delayMs={330} />,
      note: `${t.successful} of ${plural(t.calls, "call")}`,
    },
    { label: "Handed to a person", value: <CountUp to={t.transferred} delayMs={410} />, note: t.transferred === 1 ? "call" : "calls" },
    { label: "Average length", value: <CountUp to={t.avg_seconds} kind="clock" delayMs={490} />, note: `${spoken(t.total_seconds)} in total` },
    { label: "Messages taken", value: <CountUp to={t.messages} delayMs={570} />, note: t.messages === 1 ? "call left one" : "calls left one" },
    { label: "Booking links sent", value: <CountUp to={t.links} delayMs={650} />, note: t.links === 1 ? "call" : "calls" },
  ];
  const peak = Math.max(1, ...s.series.map((d) => d.calls));
  return (
    <>
      <dl className="grid grid-cols-2 gap-3 md:grid-cols-3">
        {tiles.map((x, i) => (
          <div key={x.label} className="glass rise p-4" style={step(i + 1)}>
            <dt className="text-sm text-muted">{x.label}</dt>
            <dd className="mt-1 text-3xl font-semibold tabular-nums tracking-tight">{x.value}</dd>
            <dd className="mt-1 text-xs text-faint">{x.note}</dd>
          </div>
        ))}
      </dl>

      <section aria-labelledby="per-day-h" className="glass rise p-4" style={step(7)}>
        <h2 id="per-day-h" className="text-lg font-medium">Calls per day</h2>
        <div
          className="mt-4 flex h-40 items-end gap-0.5 sm:gap-1"
          role="img"
          aria-label={`Bar chart of calls per day, ${shortDay(s.series[0].day)} to ${shortDay(s.series[s.series.length - 1].day)}. Busiest day had ${plural(peak, "call")}. The table below has every day.`}
        >
          {s.series.map((d, i) => (
            <div
              key={d.day}
              className="flex h-full min-w-0 flex-1 items-end rounded-full bg-white/[0.07] p-px shadow-[inset_0_1px_3px_rgb(0_0_0/0.4)]"
              title={`${shortDay(d.day)}: ${plural(d.calls, "call")}`}
            >
              <div
                style={{ ...step(i), height: d.calls ? `${Math.max(6, (d.calls / peak) * 100)}%` : "0" }}
                className={`grow-bar w-full rounded-full ${d.calls ? "bg-gradient-to-t from-[#3fc8b4] to-[#a6f7ea] shadow-[0_0_12px_-2px_rgb(110_231_211/0.55)]" : "bg-transparent"}`}
              />
            </div>
          ))}
        </div>
        <div className="mt-2 flex justify-between text-xs text-faint" aria-hidden="true">
          <span>{shortDay(s.series[0].day)}</span>
          <span>{shortDay(s.series[s.series.length - 1].day)}</span>
        </div>
        <details className="mt-3 text-sm">
          <summary className="link cursor-pointer">Show as a table</summary>
          <table className="mt-2 w-full max-w-xs text-left">
            <thead className="text-xs text-faint">
              <tr><th scope="col" className="py-1 font-medium">Day</th><th scope="col" className="py-1 text-right font-medium">Calls</th></tr>
            </thead>
            <tbody>
              {s.series.map((d) => (
                <tr key={d.day}>
                  <th scope="row" className="py-1 font-normal text-muted">{shortDay(d.day)}</th>
                  <td className="py-1 text-right tabular-nums">{d.calls}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      </section>
    </>
  );
}
