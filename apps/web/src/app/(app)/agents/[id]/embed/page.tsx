import type { Metadata } from "next";
import { headers } from "next/headers";
import Link from "next/link";
import { notFound } from "next/navigation";
import { supabaseServer } from "@/lib/supabase/server";
import { EmbedForm } from "./embed-form";

export const metadata: Metadata = { title: "Put on your website" };

export default async function EmbedSettingsPage({ params }: PageProps<"/agents/[id]/embed">) {
  const { id } = await params;
  const supabase = await supabaseServer();
  const { data: agent } = await supabase
    .from("agents")
    .select("id, name, published_version_id, embed_enabled, embed_origins, embed_daily_limit, embed_voice, embed_chat")
    .eq("id", id)
    .maybeSingle();
  if (!agent) notFound();

  const h = await headers();
  const proto = h.get("x-forwarded-proto") ?? "https";
  const appUrl = (process.env.APP_URL || `${proto}://${h.get("x-forwarded-host") ?? h.get("host")}`).replace(/\/$/, "");

  return (
    <div className="mx-auto max-w-6xl space-y-4">
      <Link href={`/agents/${id}`} className="link text-sm">← Back to editor</Link>
      <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">Put {agent.name} on your website</h1>
        <p className="text-sm text-muted">Visitors click, allow their microphone, and talk to the live agent. Calls show under Calls and the Dashboard.</p>
      </div>
      <EmbedForm
        agentId={agent.id}
        appUrl={appUrl}
        published={agent.published_version_id !== null}
        initial={{ enabled: agent.embed_enabled, sites: agent.embed_origins ?? [], limit: agent.embed_daily_limit, voice: agent.embed_voice !== false, chat: agent.embed_chat !== false }}
      />
    </div>
  );
}
