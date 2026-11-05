import type { Metadata } from "next";
import { cookies } from "next/headers";
import Link from "next/link";
import { TimeZoneCookie } from "@/components/time-zone-cookie";
import { safeTimeZone } from "@/lib/dashboard";
import { supabaseServer } from "@/lib/supabase/server";
import { type UsageRow, currentMonth, minutes, monthRange, parseMonth, totals } from "@/lib/usage";

export const metadata: Metadata = { title: "Usage and billing" };

export default async function UsagePage({ searchParams }: PageProps<"/usage">) {
  const sp = await searchParams;
  const tz = safeTimeZone((await cookies()).get("tz")?.value);
  const now = currentMonth(new Date(), tz);
  const month = parseMonth(typeof sp.month === "string" ? sp.month : null) ?? now;
  const withTests = sp.tests === "1";
  const range = monthRange(month);

  const supabase = await supabaseServer();
  const { data } = await supabase.rpc("client_usage", { p_from: range.from, p_to: range.to, p_tz: tz, p_customers_only: !withTests });
  const rows = (data ?? []) as UsageRow[];
  const t = totals(rows);

  const q = (m: string, tests: boolean) => `/usage?month=${m}${tests ? "&tests=1" : ""}`;
  const exportUrl = (client?: string) => `/usage/export?month=${month}${withTests ? "&tests=1" : ""}${client ? `&client=${client}` : ""}`;
  const pill = "nav-pill px-3 py-2 text-sm text-muted hover:text-text focus-visible:outline-2 focus-visible:outline-accent";

  return (
    <section aria-labelledby="usage-h" className="mx-auto max-w-5xl space-y-5">
      <TimeZoneCookie current={tz} />
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 id="usage-h" className="text-2xl font-semibold tracking-tight">Usage and billing</h1>
          <p className="mt-1 max-w-2xl text-sm text-muted">
            Talk time for each of your clients, month by month, ready to bill from. Only clients you own are listed.
          </p>
        </div>
        <a href={exportUrl()} className="btn" download>Download this month (CSV)</a>
      </div>

      <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
        <nav aria-label="Month" className="flex items-center gap-1">
          <Link href={q(range.prev, withTests)} className={pill} aria-label="Previous month">← Earlier</Link>
          <h2 className="px-2 text-lg font-medium" aria-live="polite">{range.label}</h2>
          {month < now ? <Link href={q(range.next, withTests)} className={pill} aria-label="Next month">Later →</Link> : <span className="px-3 py-2 text-sm text-faint" aria-hidden>Later →</span>}
          {month !== now && <Link href={q(now, withTests)} className={pill}>This month</Link>}
        </nav>
        <Link href={q(month, !withTests)} className="text-sm underline decoration-dotted underline-offset-4 hover:text-text">
          {withTests ? "Test calls are included. Leave them out" : "Test calls are left out. Include them"}
        </Link>
      </div>

      <div className="glass overflow-x-auto">
        <table className="w-full min-w-[34rem] text-left text-sm">
          <caption className="sr-only">Calls and minutes for each client in {range.label}</caption>
          <thead className="text-faint">
            <tr>
              <th scope="col" className="px-4 py-3 font-medium">Client</th>
              <th scope="col" className="px-4 py-3 text-right font-medium">Voice calls</th>
              <th scope="col" className="px-4 py-3 text-right font-medium">Minutes</th>
              <th scope="col" className="px-4 py-3 text-right font-medium">Billable minutes</th>
              <th scope="col" className="px-4 py-3 text-right font-medium">Chats</th>
              <th scope="col" className="px-4 py-3 text-right font-medium"><span className="sr-only">Download</span></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.account_id} className="border-t border-line">
                <th scope="row" className="px-4 py-3 font-medium">{r.name}</th>
                <td className="px-4 py-3 text-right tabular-nums">{r.calls}</td>
                <td className="px-4 py-3 text-right tabular-nums">{minutes(r.seconds)}</td>
                <td className="px-4 py-3 text-right text-base font-semibold tabular-nums">{r.billable_minutes}</td>
                <td className="px-4 py-3 text-right tabular-nums">{r.chats}</td>
                <td className="px-4 py-3 text-right">
                  {r.calls + r.chats > 0 ? <a href={exportUrl(r.account_id)} className="link whitespace-nowrap" download>Calls (CSV)<span className="sr-only"> for {r.name}</span></a> : <span className="text-faint">-</span>}
                </td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr><td colSpan={6} className="px-4 py-6 text-muted">You don&apos;t own any clients yet. Add one on the Clients page.</td></tr>
            )}
          </tbody>
          {rows.length > 0 && (
            <tfoot>
              <tr className="border-t border-line font-semibold">
                <th scope="row" className="px-4 py-3">Total</th>
                <td className="px-4 py-3 text-right tabular-nums">{t.calls}</td>
                <td className="px-4 py-3 text-right tabular-nums">{minutes(t.seconds)}</td>
                <td className="px-4 py-3 text-right tabular-nums">{t.billable}</td>
                <td className="px-4 py-3 text-right tabular-nums">{t.chats}</td>
                <td />
              </tr>
            </tfoot>
          )}
        </table>
      </div>

      <div className="max-w-3xl space-y-2 text-sm text-muted">
        <p><span className="font-medium text-text">Minutes</span> is the exact time on the line, from pick-up to hang-up. <span className="font-medium text-text">Billable minutes</span> rounds every call up to a whole minute, the way most phone carriers and agencies bill. Use whichever your agreement says.</p>
        <p>Chats are typed, so they have no minutes. They are counted separately. Days follow your own clock ({tz.replace("_", " ")}), so a call just before midnight lands on the day you saw it.</p>
        <p>By default only real customer calls (phone and website) count. Your own test calls in the builder are left out unless you include them.</p>
      </div>
    </section>
  );
}
