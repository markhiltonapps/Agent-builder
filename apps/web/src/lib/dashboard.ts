// Shapes and small helpers for the client dashboard (numbers come from public.dashboard_stats).

export type DashboardStats = {
  days: number;
  tz: string;
  totals: {
    calls: number;
    successful: number;
    transferred: number;
    messages: number;
    links: number;
    total_seconds: number;
    avg_seconds: number;
  };
  series: { day: string; calls: number }[];
  agents: {
    agent_id: string;
    name: string;
    calls: number;
    successful: number;
    transferred: number;
    avg_seconds: number;
  }[];
};

export const PERIODS = [7, 30, 90] as const;

/** `?days=` from the address bar: only the offered periods are accepted. */
export function parseDays(v: unknown): number {
  const n = Number(Array.isArray(v) ? v[0] : v);
  return (PERIODS as readonly number[]).includes(n) ? n : 30;
}

/** "3 of 4" -> 75. No calls means no rate (null), never a made-up 0%. */
export function percent(part: number, whole: number): number | null {
  return whole > 0 ? Math.round((part / whole) * 100) : null;
}

/** A time zone name the browser reported, or UTC. Guards the database call and the cookie. */
export function safeTimeZone(v: string | undefined | null): string {
  if (!v || v.length > 64 || !/^[A-Za-z0-9_+\-/]+$/.test(v)) return "UTC";
  try {
    new Intl.DateTimeFormat("en", { timeZone: v });
    return v;
  } catch {
    return "UTC";
  }
}

/** 3725 -> "1 hr 2 min", 90 -> "1 min 30 sec", 0 -> "0 min". For totals, not clocks. */
export function spoken(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return s ? `${s} sec` : "0 min";
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h) return `${h} hr ${m} min`;
  const rest = s % 60;
  return rest && m < 10 ? `${m} min ${rest} sec` : `${m} min`;
}

/** "2026-11-04" -> "Nov 4", read as a plain date (no time-zone shift). */
export function shortDay(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}
