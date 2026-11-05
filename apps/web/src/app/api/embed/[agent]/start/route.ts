import { type NextRequest, NextResponse } from "next/server";
import { embedBegin } from "@/lib/embed-info";
import { isSameOrigin, isUuid, makeLimiter } from "@/lib/embed-code";
import { visitorToken } from "@/lib/livekit";

// Starts one call for an anonymous visitor on an embedded page. Public on purpose, so it is
// guarded three ways: it only answers our own embed page (Origin check), one visitor can only
// start a few calls in a short time, and each agent has a daily cap in the database.

const perVisitor = makeLimiter(5, 10 * 60_000);
const everyone = makeLimiter(120, 60_000);

/** The addresses this app counts as its own: the configured one, and the one this request used. */
function ownOrigins(req: NextRequest): string[] {
  const proto = req.headers.get("x-forwarded-proto") ?? "https";
  const arrived = `${proto}://${req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? ""}`;
  try {
    return process.env.APP_URL ? [new URL(process.env.APP_URL).origin, arrived] : [arrived];
  } catch {
    return [arrived];
  }
}

const say = (status: number, error: string) =>
  NextResponse.json({ error }, { status, headers: { "Cache-Control": "no-store" } });

export async function POST(req: NextRequest, ctx: RouteContext<"/api/embed/[agent]/start">) {
  const { agent } = await ctx.params;
  if (!isUuid(agent)) return say(404, "unavailable");
  if (!isSameOrigin(req.headers.get("origin"), ownOrigins(req))) return say(403, "forbidden");

  const visitor = (req.headers.get("x-forwarded-for") ?? "").split(",")[0].trim() || "unknown";
  if (!everyone("all") || !perVisitor(visitor)) return say(429, "slow_down");

  switch (await embedBegin(agent)) {
    case "ok":
      break;
    case "limit":
      return say(429, "busy");
    case "unpublished":
      return say(409, "not_ready");
    case "error":
      return say(502, "try_again");
    default:
      return say(404, "unavailable");
  }
  try {
    const { url, token } = await visitorToken({ agentId: agent });
    return NextResponse.json({ url, token }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return say(502, "try_again");
  }
}
