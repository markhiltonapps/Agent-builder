import { type NextRequest, NextResponse } from "next/server";
import { REASON_STATUS, chatStart } from "@/lib/embed-chat";
import { isSameOrigin, isUuid, makeLimiter } from "@/lib/embed-code";
import { ownOrigins, visitorOf } from "@/lib/embed-origin";

// Opens a text chat for an anonymous visitor. Public on purpose, so it is guarded like the call
// start: it only answers our own embed page, one visitor can only open a few chats in a short
// time, and every chat counts against the agent's daily cap in the database.

const perVisitor = makeLimiter(8, 10 * 60_000);
const everyone = makeLimiter(240, 60_000);

const say = (status: number, body: object) => NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });

export async function POST(req: NextRequest, ctx: RouteContext<"/api/embed/[agent]/chat/start">) {
  const { agent } = await ctx.params;
  if (!isUuid(agent)) return say(404, { error: "unavailable" });
  if (!isSameOrigin(req.headers.get("origin"), ownOrigins(req))) return say(403, { error: "forbidden" });
  if (!everyone("all") || !perVisitor(visitorOf(req))) return say(429, { error: "slow_down" });

  const r = await chatStart(agent);
  if (!r.ok) return say(REASON_STATUS[r.reason], { error: r.reason });
  return say(200, { session: r.session, greeting: r.greeting });
}
