import type { NextRequest } from "next/server";

/** The addresses this app counts as its own: the configured one, and the one this request used. */
export function ownOrigins(req: NextRequest): string[] {
  const proto = req.headers.get("x-forwarded-proto") ?? "https";
  const arrived = `${proto}://${req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? ""}`;
  try {
    return process.env.APP_URL ? [new URL(process.env.APP_URL).origin, arrived] : [arrived];
  } catch {
    return [arrived];
  }
}

export const visitorOf = (req: NextRequest) => (req.headers.get("x-forwarded-for") ?? "").split(",")[0].trim() || "unknown";
