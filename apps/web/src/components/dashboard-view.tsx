import { CountUp } from "@/components/count-up";
import { type DashboardStats, percent, shortDay, spoken } from "@/lib/dashboard";
import { duration } from "@/lib/format";
import Link from "next/link";

export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Position in the build-in sequence: each step starts a little after the one before. */
export const step = (i: number) => ({ "--i": i }) as React.CSSProperties;

export function Numbers({ s }: { s: DashboardStats }) {
  const t = s.totals;
  const rate = percent(t.successful, t.calls);
  const tiles: { label: string; value: React.ReactNode; note: string }[] = [
    { label: "Calls", value: <CountUp to={t.calls} delayMs={250} />, note: `in the last ${s.days} days${t.chats ? `, ${t.chats} ${t.chats === 1 ? "chat" : "chats"}` : ""}` },
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


export function ByAgent({ stats: s, step: at, linkAgents = false }: { stats: DashboardStats; step: number; linkAgents?: boolean }) {
  return (
    <section aria-labelledby="by-agent-h" className="rise space-y-3" style={step(at)}>
      <h2 id="by-agent-h" className="text-lg font-medium">By agent</h2>
      <div className="glass overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead className="text-xs text-faint">
            <tr>
              <th scope="col" className="px-2 py-3 font-medium sm:px-4">Agent</th>
              <th scope="col" className="px-2 py-3 text-right font-medium sm:px-4">Calls</th>
              <th scope="col" className="px-2 py-3 text-right font-medium sm:px-4">Reached their goal</th>
              <th scope="col" className="px-2 py-3 text-right font-medium sm:px-4">Handed to a person</th>
              <th scope="col" className="px-2 py-3 text-right font-medium sm:px-4">Average length</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {s.agents.map((a) => (
              <tr key={a.agent_id}>
                <th scope="row" className="px-2 py-3 font-medium sm:px-4">
                  {linkAgents ? <Link href={`/calls?agent=${a.agent_id}`} className="link">{a.name}</Link> : a.name}
                </th>
                <td className="px-2 py-3 text-right tabular-nums sm:px-4">{a.calls}</td>
                <td className="px-2 py-3 text-right tabular-nums sm:px-4">{percent(a.successful, a.calls)}%</td>
                <td className="px-2 py-3 text-right tabular-nums sm:px-4">{a.transferred}</td>
                <td className="px-2 py-3 text-right tabular-nums sm:px-4">{duration(Number(a.avg_seconds))}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
