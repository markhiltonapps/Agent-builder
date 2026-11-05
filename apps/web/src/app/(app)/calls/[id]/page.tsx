import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { LocalTime } from "@/components/local-time";
import { duration } from "@/lib/format";
import { friendlyName } from "@/lib/labels";
import { supabaseServer } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Call" };

interface Line { who: "caller" | "agent"; text: string }
interface ToolCall { tool: string; args: Record<string, unknown>; ok: boolean; result: unknown; latency_ms: number; goal: boolean }

export default async function CallPage({ params }: PageProps<"/calls/[id]">) {
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const supabase = await supabaseServer();
  const { data: call } = await supabase
    .from("calls")
    .select("*, agent:agents(id, name)")
    .eq("id", id)
    .maybeSingle();
  if (!call) notFound();

  const agent = call.agent as unknown as { id: string; name: string } | null;
  const transcript = (call.transcript ?? []) as Line[];
  const tools = (call.tool_calls ?? []) as ToolCall[];

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <Link href={agent ? `/calls?agent=${agent.id}` : "/calls"} className="link text-sm">← All calls</Link>
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{agent?.name ?? "Deleted agent"}</h1>
        <p className="mt-1 flex flex-wrap items-center gap-2 text-sm text-muted">
          <LocalTime iso={call.started_at} />
          {call.channel !== "chat" && <span className="chip">{duration(Number(call.duration_s))}</span>}
          <span className="chip">Version {call.agent_version ?? "?"}</span>
          <span className="chip">{call.channel === "chat" ? "Website chat" : call.source === "phone" ? "Phone" : call.source === "web" ? "Website" : "Test call"}</span>
          {call.goal_reached && <span className="chip chip-live">Successful</span>}
          {call.transferred && <span className="chip">Transferred{call.transfer_reason ? `: ${call.transfer_reason}` : ""}</span>}
          {call.votel_synced_at && <span className="chip chip-live">In Votel CRM</span>}
          {call.recoveries > 0 && <span className="chip" title="The connection dropped briefly and the call continued.">Reconnected ×{call.recoveries}</span>}
        </p>
      </div>

      {call.votel_error && (
        <p role="note" className="rounded-2xl border border-warn/40 bg-warn/10 p-3 text-sm">
          We couldn&apos;t send this call to Votel. It is still saved here with its full transcript.
        </p>
      )}

      <section className="glass p-5" aria-label="Transcript">
        <h2 className="mb-3 text-sm font-medium">Transcript</h2>
        {transcript.length === 0 ? (
          <p className="text-sm text-muted">Nothing was said.</p>
        ) : (
          <ul className="space-y-3">
            {transcript.map((l, i) => (
              <li key={i} className="text-sm">
                <span className={`mr-2 font-medium ${l.who === "agent" ? "text-accent" : "text-muted"}`}>
                  {l.who === "agent" ? (agent?.name ?? "Agent") : "Caller"}
                </span>
                {l.text}
              </li>
            ))}
          </ul>
        )}
      </section>

      {tools.length > 0 && (
        <section className="glass p-5" aria-label="Tool activity">
          <h2 className="mb-3 text-sm font-medium">What the agent did</h2>
          <ul className="space-y-3">
            {tools.map((t, i) => (
              <li key={i} className="rounded-2xl border border-line p-3 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{friendlyName(t.tool)}</span>
                  <span className={`chip ${t.ok ? "chip-live" : ""}`}>{t.ok ? "Worked" : "Failed"}</span>
                                    <span className="text-xs text-faint">{t.latency_ms} ms</span>
                </div>
                <p className="mt-2 break-words font-mono text-xs text-muted">
                  {Object.entries(t.args ?? {}).map(([k, v]) => `${k}=${String(v)}`).join("  ") || "no inputs"}
                </p>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
