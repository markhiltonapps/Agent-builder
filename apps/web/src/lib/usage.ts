// Billing minutes: which month is being looked at, and how the numbers become a spreadsheet.

export interface UsageRow {
  account_id: string;
  name: string;
  calls: number;
  seconds: number;
  billable_minutes: number;
  chats: number;
}

export interface UsageDetail {
  started_at: string;
  agent: string;
  source: string;
  channel: string;
  duration_s: number;
}

const MONTH = /^(\d{4})-(0[1-9]|1[0-2])$/;
const pad = (n: number) => String(n).padStart(2, "0");

/** "2026-10" if it is a real month (2020 to 2100), otherwise null. */
export function parseMonth(value: string | undefined | null): string | null {
  const m = value ? MONTH.exec(value) : null;
  return m && Number(m[1]) >= 2020 && Number(m[1]) <= 2100 ? value! : null;
}

/** The month containing "now" as the person's clock shows it. */
export function currentMonth(now: Date, tz: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit" }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}`;
}

export function monthRange(month: string): { from: string; to: string; label: string; prev: string; next: string } {
  const [y, m] = month.split("-").map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const shift = (d: number) => {
    const t = new Date(Date.UTC(y, m - 1 + d, 1));
    return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}`;
  };
  return {
    from: `${month}-01`,
    to: `${month}-${pad(last)}`,
    label: new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" }),
    prev: shift(-1),
    next: shift(1),
  };
}

/** Minutes to one decimal: 125 seconds is "2.1". */
export const minutes = (seconds: number) => (Math.round((Number(seconds) / 60) * 10) / 10).toFixed(1);

export function totals(rows: UsageRow[]) {
  return rows.reduce(
    (t, r) => ({ calls: t.calls + Number(r.calls), seconds: t.seconds + Number(r.seconds), billable: t.billable + Number(r.billable_minutes), chats: t.chats + Number(r.chats) }),
    { calls: 0, seconds: 0, billable: 0, chats: 0 },
  );
}

/** One CSV cell. Quoted when needed, and a leading = + - @ is defused so a spreadsheet never runs it as a formula. */
export function cell(value: string | number): string {
  let s = String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const line = (cells: (string | number)[]) => cells.map(cell).join(",");

export function summaryCsv(rows: UsageRow[], month: string): string {
  const out = [line(["Client", "Month", "Voice calls", "Minutes", "Billable minutes (each call rounded up)", "Chats"])];
  for (const r of rows) out.push(line([r.name, month, r.calls, minutes(r.seconds), r.billable_minutes, r.chats]));
  const t = totals(rows);
  out.push(line(["Total", month, t.calls, minutes(t.seconds), t.billable, t.chats]));
  return out.join("\r\n") + "\r\n";
}

export function detailCsv(rows: UsageDetail[], tz: string): string {
  const when = (iso: string) =>
    new Intl.DateTimeFormat("en-CA", { timeZone: tz, dateStyle: "short", timeStyle: "medium", hourCycle: "h23" }).format(new Date(iso)).replace(",", "");
  const out = [line(["Started", "Agent", "Source", "Type", "Seconds", "Minutes", "Billable minutes"])];
  for (const r of rows) {
    const voice = r.channel === "voice";
    out.push(line([when(r.started_at), r.agent, r.source === "web" ? "Website" : r.source === "phone" ? "Phone" : "Test", voice ? "Voice" : "Chat", voice ? Math.round(Number(r.duration_s)) : "", voice ? minutes(r.duration_s) : "", voice ? Math.ceil(Number(r.duration_s) / 60) : ""]));
  }
  return out.join("\r\n") + "\r\n";
}
