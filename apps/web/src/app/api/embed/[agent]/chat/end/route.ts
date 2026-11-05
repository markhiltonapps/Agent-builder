import { type NextRequest, NextResponse } from "next/server";
import { SESSION, chatEnd } from "@/lib/embed-chat";
import { isSameOrigin, isUuid } from "@/lib/embed-code";
import { sharedLimiter } from "@/lib/shared-limit";
import { ownOrigins, visitorOf } from "@/lib/embed-origin";

// The visitor closed the chat: finish it now (summary, Calls, Votel) instead of waiting for it to go quiet.

const perVisitor = sharedLimiter("chat-end", 20, 10 * 60_000);

export async function POST(req: NextRequest, ctx: RouteContext<"/api/embed/[agent]/chat/end">) {
  const { agent } = await ctx.params;
  const quiet = (status: number) => new NextResponse(null, { status, headers: { "Cache-Control": "no-store" } });
  if (!isUuid(agent)) return quiet(404);
  if (!isSameOrigin(req.headers.get("origin"), ownOrigins(req))) return quiet(403);
  if (!(await perVisitor(visitorOf(req)))) return quiet(429);
  const body = (await req.json().catch(() => null)) as { session?: unknown } | null;
  if (!body || typeof body.session !== "string" || !SESSION.test(body.session)) return quiet(400);
  await chatEnd(body.session);
  return quiet(204);
}
