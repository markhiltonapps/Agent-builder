import { type NextRequest, NextResponse } from "next/server";
import { MAX_MESSAGE, REASON_STATUS, SESSION, chatSend } from "@/lib/embed-chat";
import { isSameOrigin, isUuid, makeLimiter } from "@/lib/embed-code";
import { sharedLimiter } from "@/lib/shared-limit";
import { ownOrigins, visitorOf } from "@/lib/embed-origin";

// One message from the visitor; the agent's reply comes back. Same guards as starting a chat,
// plus a short limit on how fast one visitor can type at it.

const perVisitor = sharedLimiter("chat-send", 30, 60_000);
const everyone = makeLimiter(600, 60_000);

const say = (status: number, body: object) => NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });

export async function POST(req: NextRequest, ctx: RouteContext<"/api/embed/[agent]/chat/send">) {
  const { agent } = await ctx.params;
  if (!isUuid(agent)) return say(404, { error: "unavailable" });
  if (!isSameOrigin(req.headers.get("origin"), ownOrigins(req))) return say(403, { error: "forbidden" });
  if (!everyone("all") || !(await perVisitor(visitorOf(req)))) return say(429, { error: "slow_down" });

  const body = (await req.json().catch(() => null)) as { session?: unknown; message?: unknown } | null;
  if (!body || typeof body.session !== "string" || !SESSION.test(body.session) || typeof body.message !== "string") return say(400, { error: "empty" });
  const message = body.message.trim();
  if (!message) return say(400, { error: "empty" });
  if (message.length > MAX_MESSAGE) return say(413, { error: "too_long" });

  const r = await chatSend(body.session, message);
  if (!r.ok) return say(REASON_STATUS[r.reason], { error: r.reason });
  return say(200, { reply: r.reply });
}
